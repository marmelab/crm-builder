import { EventEmitter } from 'node:events';
import { readFile, readdir, mkdir, stat } from 'node:fs/promises';
import { watch, watchFile, unwatchFile } from 'node:fs';
import { join, basename } from 'node:path';
import { emptyBreakdown, addBreakdown, breakdownFromUsage } from '../stats/io.js';
import { readAppendedLines } from './jsonl-tail.js';

// A run_in_background Agent dispatch returns an immediate stub tool_result; the
// REAL completion arrives later as a `<task-notification>` entry keyed by the
// internal agentId. These pure helpers are exported for unit tests.
export function classifyToolResult(text) {
  const m = /Async agent launched successfully\.?[\s\S]*?agentId:\s*([A-Za-z0-9_-]+)/.exec(text || '');
  return m ? { background: true, agentId: m[1] } : { background: false, agentId: null };
}

export function parseTaskNotification(text) {
  const m = /<task-notification>[\s\S]*?<task-id>([A-Za-z0-9_-]+)<\/task-id>/.exec(text || '');
  return m ? m[1] : null;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
  return '';
}

export class TranscriptWatcher extends EventEmitter {
  #sessionId;
  #projectDir;
  #jsonlPath = null;
  // Byte offset into #jsonlPath of the next unread byte, and the mtime at that
  // offset. The main transcript is tailed incrementally via readAppendedLines
  // (shared with subagent-tail.js): each #poll() reads only the bytes appended
  // since the last tick, never re-parsing history.
  #offset = 0;
  #mtimeMs = 0;
  #dirWatcher = null;
  #debounce = null;
  closed = false;

  // Per-turn token accumulation. Populated incrementally by #poll() as new
  // assistant lines arrive. Consumed and reset by consumeTurnUsage() at turn end.
  // Map<model, {input, cacheCreate, output, cacheRead}>
  #turnUsage = new Map();
  // Per-subagent-file line offsets already counted in a previous
  // consumeTurnUsage() call. Map<filename, linesConsumed>. Injected by the
  // runtime so it survives PTY restarts (a fresh watcher must not re-count
  // historical files in full). Tracking offsets — not a "seen" set — lets a
  // file's later-appended lines be counted on subsequent turns.
  #subagentUsageLines;
  // Tool-use IDs of pending Agent() calls — used to emit synthetic task_started /
  // task_notification events so activeAgents tracking works without system events.
  #pendingAgentIds = new Set();
  // Internal agentId → Agent tool_use_id, for run_in_background dispatches whose
  // immediate stub tool_result is NOT a completion. The completion is emitted
  // later when the matching `<task-notification>` entry arrives.
  #bgAgentToToolId = new Map();

  // projectDir: directory containing <sessionId>.jsonl files.
  // sessionId: null for new sessions (watch dir), string for resumed sessions.
  constructor(sessionId, projectDir, { subagentUsageLines = new Map() } = {}) {
    super();
    this.#sessionId = sessionId || null;
    this.#projectDir = projectDir;
    this.#subagentUsageLines = subagentUsageLines;
    if (sessionId) {
      this.#jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    }
  }

  async start() {
    if (this.#sessionId) {
      // Resumed session: seek to current end-of-file (by byte offset) so we
      // only see lines appended after this point — no full read of history.
      try {
        const st = await stat(this.#jsonlPath);
        this.#offset = st.size;
        this.#mtimeMs = st.mtimeMs;
      } catch { /* file doesn't exist yet — offset 0 / mtime 0, will be created shortly */ }
      this.#watchFile();
    } else {
      // Ensure the project dir exists before watching — fs.watch() throws
      // synchronously on a missing directory, which would silently swallow
      // all events if the caller does .catch(() => {}).
      await mkdir(this.#projectDir, { recursive: true }).catch(() => {});
      await this.#watchDir();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.#debounce);
    if (this.#jsonlPath) unwatchFile(this.#jsonlPath);
    this.#dirWatcher?.close();
  }

  async #watchDir() {
    // Snapshot files that exist before we start watching — ignore them.
    let before;
    try {
      const files = await readdir(this.#projectDir);
      before = new Set(files.filter(f => f.endsWith('.jsonl')));
    } catch {
      before = new Set();
    }

    // Latch onto a new JSONL only if it belongs to an interactive session.
    // Defensive guard: any `--print` (`claude -p`) session that might land in this
    // shared project dir begins with queue-operation entries (chat-service no
    // longer spawns one itself, but this keeps the watcher robust). Interactive
    // sessions begin with either:
    //   - agent-setting  (when --agent is used, written first)
    //   - permission-mode (written immediately after, or as the very first entry
    //                     for sessions without --agent)
    //
    // Checking for agent-setting alone is safe: --print sessions never use --agent,
    // so they never produce an agent-setting entry in the main project dir. Subagent
    // JSONLs (which do start with agent-setting) live in a different subdirectory.
    //
    // This also fixes a race condition: on cold-start / slow flush, the directory
    // watcher can fire after agent-setting is written but before permission-mode
    // arrives. Checking only permission-mode would return false, the file would be
    // abandoned (the dir watcher doesn't re-fire on content appends), and the session
    // would never be discovered.
    const isInteractiveSession = async (filename) => {
      try {
        const content = await readFile(join(this.#projectDir, filename), 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        if (!lines.length) return false; // empty file, not ready yet
        for (const line of lines.slice(0, 3)) {
          try {
            const t = JSON.parse(line).type;
            if (t === 'permission-mode' || t === 'agent-setting') return true;
          } catch { break; }
        }
        return false;
      } catch { return false; }
    };

    const handleNewFile = async (filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      if (before.has(filename)) return;
      if (!await isInteractiveSession(filename)) return; // skip --print sessions
      before.add(filename);

      const id = basename(filename, '.jsonl');
      this.#sessionId = id;
      this.#jsonlPath = join(this.#projectDir, filename);

      this.emit('event', { session_id: id });

      this.#dirWatcher?.close();
      this.#dirWatcher = null;
      this.#watchFile();
    };

    this.#dirWatcher = watch(this.#projectDir, { persistent: false }, (_event, filename) => {
      handleNewFile(filename).catch(() => {});
    });

    // Post-attach re-check: catches files created between readdir resolving and
    // watch() registering (tiny window, but possible under load).
    try {
      const files = await readdir(this.#projectDir);
      for (const f of files) await handleNewFile(f);
    } catch { /* ignore */ }
  }

  #watchFile() {
    // Use fs.watchFile (stat-based polling) instead of fs.watch (inotify) for
    // the session JSONL. Stat polling is immune to inotify limit exhaustion,
    // silent error events, and atomic file replacement — all of which can cause
    // fs.watch to silently stop delivering events with no observable error.
    // The 500 ms interval is fine: flush() is called explicitly at every turn
    // boundary (result / background_result), so incremental polling only needs
    // to cover intermediate events during long turns.
    watchFile(this.#jsonlPath, { persistent: false, interval: 500 }, () => {
      clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => this.#poll().catch(() => {}), 50);
    });
    // Initial poll in case lines were written before the watcher was attached.
    this.#poll().catch(() => {});
  }

  // Force-read any new lines immediately (bypasses the debounce timer).
  // Call this before emitting a result event to guarantee assistant events
  // are delivered first, without relying on inotify timing.
  async flush() {
    await this.#poll();
  }

  async #poll() {
    if (!this.#jsonlPath) return;
    // Incremental byte-offset tail via the shared helper: reads only the bytes
    // appended since the last tick and returns complete (\n-terminated) lines,
    // carrying any partial tail to the next call via newOffset — so we never
    // JSON.parse a half-written event.
    // Caveat: readAppendedLines skips a single slice > 1 MiB (MAX_SLICE_BYTES).
    // Acceptable here — individual orchestrator transcript events are small; a
    // pathological multi-MB single line would be skipped rather than buffered.
    const r = await readAppendedLines(this.#jsonlPath, this.#offset, this.#mtimeMs);
    if (!r) return;
    this.#offset = r.newOffset;
    this.#mtimeMs = r.mtimeMs;

    for (const raw of r.lines) {
      let entry;
      try { entry = JSON.parse(raw); } catch { continue; } // helper only yields complete lines

      if (entry.type === 'assistant') {
        this.emit('event', entry);

        // Accumulate token usage for this turn (consumed by consumeTurnUsage()).
        const model = entry.message?.model;
        const u = entry.message?.usage;
        if (model && u) {
          this.#turnUsage.set(model, addBreakdown(
            this.#turnUsage.get(model) || emptyBreakdown(),
            breakdownFromUsage(u),
          ));
        }

        // Emit synthetic task_started for each Agent() tool call so activeAgents
        // tracking works without stream-json system events.
        // tool_use_id mirrors task_id (both equal b.id) so phases.js can look up
        // agentType via agentTypeByToolId.get(ev.tool_use_id) = subagent_type.
        for (const b of entry.message?.content ?? []) {
          if (b.type === 'tool_use' && b.name === 'Agent' && b.id) {
            this.#pendingAgentIds.add(b.id);
            // team_name present → in_process_teammate (COMPLEX team member),
            // absent → local_agent (planner, simple-developer, merger, etc.).
            const taskType = b.input?.team_name ? 'in_process_teammate' : 'local_agent';
            this.emit('event', {
              type: 'system',
              subtype: 'task_started',
              task_type: taskType,
              task_id: b.id,
              tool_use_id: b.id,       // phases.js: agentTypeByToolId lookup
              description: b.input?.description ?? '', // phases.js: phase.description
            });
          }
        }
      } else if (entry.type === 'user') {
        // Emit synthetic task_notification/completed when a tool_result closes a
        // pending Agent() call. The user entry itself is not forwarded.
        // A run_in_background dispatch returns an immediate stub tool_result that
        // is NOT a completion — defer it to the later `<task-notification>`.
        const blocks = Array.isArray(entry.message?.content)
          ? entry.message.content
          : [{ type: 'text', text: String(entry.message?.content ?? '') }];
        for (const b of blocks) {
          if (b.type === 'tool_result' && this.#pendingAgentIds.has(b.tool_use_id)) {
            this.#pendingAgentIds.delete(b.tool_use_id);
            const { background, agentId } = classifyToolResult(toolResultText(b.content));
            if (background && agentId) {
              // Completion is deferred to the matching <task-notification> entry.
              this.#bgAgentToToolId.set(agentId, b.tool_use_id);
            } else {
              this.emit('event', { type: 'system', subtype: 'task_notification', status: 'completed', task_id: b.tool_use_id });
            }
          } else if (b.type === 'text') {
            // Defensive: a <task-notification> delivered as a user text block.
            this.#resolveTaskNotification(b.text);
          }
        }
      } else if (entry.type === 'queue-operation') {
        // The real `<task-notification>` for a background Agent arrives here, with
        // the notification XML on the top-level `content` string.
        this.#resolveTaskNotification(entry.content);
      } else if (entry.type === 'rate_limit_event') {
        this.emit('event', entry);
      }
    }
  }

  // Resolve a deferred background-Agent completion from a `<task-notification>`.
  // The notification is keyed on the internal agentId (<task-id>); we map it back
  // to the original Agent tool_use_id so the progress-bar / stats consumer credits
  // the right phase — and only at real completion time, not at dispatch.
  #resolveTaskNotification(text) {
    const agentId = parseTaskNotification(text);
    if (agentId && this.#bgAgentToToolId.has(agentId)) {
      const toolId = this.#bgAgentToToolId.get(agentId);
      this.#bgAgentToToolId.delete(agentId);
      this.emit('event', { type: 'system', subtype: 'task_notification', status: 'completed', task_id: toolId });
    }
  }

  // Collect token usage for the just-completed turn: all new assistant usage
  // accumulated by #poll() since the last call, plus any new subagent JSONL files
  // that appeared during this turn. Returns a modelUsage object in the camelCase
  // format expected by turn.js. Resets per-turn state so the next turn starts clean.
  async consumeTurnUsage() {
    const usage = new Map(this.#turnUsage);
    this.#turnUsage.clear();

    // Subagent JSONLs live at <projectDir>/<sessionId>/subagents/*.jsonl.
    // Count only lines we haven't consumed yet (per-file offset), so a file's
    // later-appended assistant lines are credited on subsequent turns instead
    // of being lost after a near-empty first read.
    if (this.#sessionId) {
      try {
        const subDir = join(this.#projectDir, this.#sessionId, 'subagents');
        const files = await readdir(subDir);
        await Promise.all(
          files
            .filter((f) => f.endsWith('.jsonl'))
            .map(async (f) => {
              const consumed = this.#subagentUsageLines.get(f) || 0;
              const content = await readFile(join(subDir, f), 'utf8').catch(() => null);
              if (!content) return;
              const lines = content.split('\n');
              let counted = consumed;
              for (let i = consumed; i < lines.length; i++) {
                const line = lines[i];
                // Mirror #poll(): never advance past a trailing empty line — a
                // later append turns it into content we must still count.
                if (!line.trim()) { if (i < lines.length - 1) counted = i + 1; continue; }
                let e; try { e = JSON.parse(line); } catch { break; } // partial tail — retry next call
                counted = i + 1;
                if (e.type !== 'assistant') continue;
                const model = e.message?.model;
                const u = e.message?.usage;
                if (!model || !u) continue;
                usage.set(model, addBreakdown(usage.get(model) || emptyBreakdown(), breakdownFromUsage(u)));
              }
              this.#subagentUsageLines.set(f, counted);
            })
        );
      } catch { /* no subagents dir — normal for first turn */ }
    }

    // Convert to turn.js modelUsage format (camelCase).
    const modelUsage = {};
    for (const [model, u] of usage) {
      modelUsage[model] = {
        inputTokens:              u.input,
        cacheCreationInputTokens: u.cacheCreate,
        cacheReadInputTokens:     u.cacheRead,
        outputTokens:             u.output,
      };
    }
    return modelUsage;
  }
}
