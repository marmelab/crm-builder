import { EventEmitter } from 'node:events';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { watch, watchFile, unwatchFile } from 'node:fs';
import { join, basename } from 'node:path';
import { emptyBreakdown, addBreakdown, breakdownFromUsage } from '../stats/io.js';

export class TranscriptWatcher extends EventEmitter {
  #sessionId;
  #projectDir;
  #jsonlPath = null;
  #linesRead = 0;
  #dirWatcher = null;
  #debounce = null;
  closed = false;

  // Per-turn token accumulation. Populated incrementally by #poll() as new
  // assistant lines arrive. Consumed and reset by consumeTurnUsage() at turn end.
  // Map<model, {input, cacheCreate, output, cacheRead}>
  #turnUsage = new Map();
  // Subagent JSONL files already counted in a previous consumeTurnUsage() call.
  // Prevents double-counting when the same subagent dir is scanned on a later turn.
  #knownSubagents = new Set();
  // Tool-use IDs of pending Agent() calls — used to emit synthetic task_started /
  // task_notification events so activeAgents tracking works without system events.
  #pendingAgentIds = new Set();

  // projectDir: directory containing <sessionId>.jsonl files.
  // sessionId: null for new sessions (watch dir), string for resumed sessions.
  constructor(sessionId, projectDir) {
    super();
    this.#sessionId = sessionId || null;
    this.#projectDir = projectDir;
    if (sessionId) {
      this.#jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    }
  }

  async start() {
    if (this.#sessionId) {
      // Resumed session: seek to current end-of-file so we only see new lines.
      try {
        const content = await readFile(this.#jsonlPath, 'utf8');
        this.#linesRead = (content.match(/\n/g) || []).length;
      } catch { /* file doesn't exist yet — will be created shortly */ }
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
    // Sessions started with --print (e.g. title generation via regenerateTitleWithHaiku)
    // begin with queue-operation entries. Interactive sessions begin with either:
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
    let content;
    try {
      content = await readFile(this.#jsonlPath, 'utf8');
    } catch { return; }

    const lines = content.split('\n');
    for (let i = this.#linesRead; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) {
        if (i < lines.length - 1) this.#linesRead = i + 1;
        continue;
      }
      let entry;
      try { entry = JSON.parse(raw); } catch { break; } // partial line — retry next poll
      this.#linesRead = i + 1;

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
        for (const b of entry.message?.content ?? []) {
          if (b.type === 'tool_result' && this.#pendingAgentIds.has(b.tool_use_id)) {
            this.#pendingAgentIds.delete(b.tool_use_id);
            this.emit('event', { type: 'system', subtype: 'task_notification', status: 'completed', task_id: b.tool_use_id });
          }
        }
      } else if (entry.type === 'rate_limit_event') {
        this.emit('event', entry);
      }
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
    // Only read files we haven't seen before to avoid double-counting across turns.
    if (this.#sessionId) {
      try {
        const subDir = join(this.#projectDir, this.#sessionId, 'subagents');
        const files = await readdir(subDir);
        await Promise.all(
          files
            .filter(f => f.endsWith('.jsonl') && !this.#knownSubagents.has(f))
            .map(async f => {
              this.#knownSubagents.add(f);
              const content = await readFile(join(subDir, f), 'utf8').catch(() => null);
              if (!content) return;
              for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                let e; try { e = JSON.parse(line); } catch { continue; }
                if (e.type !== 'assistant') continue;
                const model = e.message?.model;
                const u = e.message?.usage;
                if (!model || !u) continue;
                usage.set(model, addBreakdown(
                  usage.get(model) || emptyBreakdown(),
                  breakdownFromUsage(u),
                ));
              }
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
