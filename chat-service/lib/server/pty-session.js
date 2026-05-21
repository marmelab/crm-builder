import pty from 'node-pty';
import stripAnsi from 'strip-ansi';
import { EventEmitter } from 'node:events';
import { access, unlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { CWD, CLAUDE_HOME } from './config.js';
import { getOrchestratorModel } from './system-prompt.js';
import { buildSpawnEnv } from '../spawn-env.js';
import { TranscriptWatcher } from './transcript-watcher.js';
import { costFromBreakdown } from '../stats/io.js';
import { join } from 'node:path';

// Exported for unit testing.
export function detectPrompt(text) {
  // Match ❯ or > at the very end of the text (after trimming trailing whitespace),
  // only when preceded by a newline or start-of-string — i.e. it's on its own line.
  // The welcome-screen "❯ <suggestion>" does NOT match (❯ is mid-text there).
  return /(?:^|\n)[❯>]\s*$/.test(text.trimEnd());
}

const TURN_TIMEOUT_MS = 120_000;  // fallback: silence after last PTY chunk → turn done (Stop hook is primary).
                                  // 120 s: COMPLEX turns can be silent for >15 s while the orchestrator waits
                                  // for subagent responses (planner, developer team). The Stop hook sentinel
                                  // is the primary "turn done" signal; this timer is only the safety net.
const STARTUP_TIMEOUT_MS = 12_000; // safety: Claude TUI initializes in ~1.5s; 12s is reliably safe
// Claude project dir slug: '/app' → '-app'
const PROJECT_SLUG = CWD.replace(/\//g, '-');
const PROJECT_DIR = join(CLAUDE_HOME, '.claude', 'projects', PROJECT_SLUG);

const OUTPUT_BUFFER_LIMIT = 2048;

export class PtySession extends EventEmitter {
  #pty;
  #watcher;
  #sessionId;            // Claude session UUID, learned from TranscriptWatcher
  #silenceTimer = null;
  #resultEmitted = true; // true = idle (no active turn), prevents spurious result on startup
  #outputBuffer = '';    // last 2 KB of PTY output (after strip-ansi) for friendlyError
  #ready = false;        // true once Claude's TUI shows its first ❯ prompt
  #pendingSend = null;   // message queued before Claude was ready
  #stopDirWatcher = null; // fs.watch on /tmp for stop sentinel file
  closed = false;

  get stderr() { return this.#outputBuffer; }

  constructor(claudeSessionId, sessionDir) {
    super();
    this.#sessionId = claudeSessionId || null;
    const model = getOrchestratorModel();
    const mode = process.env.MODE || 'demo';

    // Inject mode + session_dir into the system prompt so the orchestrator can
    // read them (it expects <mode> and <session_dir> in its system context).
    // Sending them in the user message via PTY confuses Claude's TUI and causes
    // it to try to process the XML tags rather than generate a response.
    const appendedPrompt = `<mode>${mode}</mode>\n<session_dir>${sessionDir}</session_dir>`;

    const args = ['--dangerously-skip-permissions'];
    if (claudeSessionId) args.push('--resume', claudeSessionId);
    // Load the orchestrator agent file so the state machine, CLASSIFICATION,
    // and LANGUAGE RULES are active. Without --agent, the TUI starts with the
    // generic Claude Code system prompt and routes requests itself (wrong).
    args.push('--agent', 'chat-orchestrator');
    if (model) args.push('--model', model);
    args.push('--append-system-prompt', appendedPrompt);

    this.#pty = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: CWD,
      env: buildSpawnEnv({
        ...process.env,
        HOME: CLAUDE_HOME,
        CLAUDE_PROJECT_DIR: CWD,
        CHAT_SESSION_DIR: sessionDir,
        MODE: mode,
        // Prevent the auto-update check from blocking the TUI startup.
        // Without this, the TUI shows "Auto-updating…" then "✗ Auto-update failed"
        // for ~2s on each spawn, eating into the 12s STARTUP_TIMEOUT_MS budget.
        DISABLE_AUTOUPDATER: '1',
      }, claudeSessionId),
    });

    this.#pty.onData(chunk => this.#onData(chunk));
    this.#pty.onExit(({ exitCode }) => {
      this.closed = true;
      clearTimeout(this.#silenceTimer);
      this.#stopDirWatcher?.close();
      this.#watcher?.close();
      this.emit('exit', exitCode ?? 1);
    });

    this.#watcher = new TranscriptWatcher(claudeSessionId, PROJECT_DIR);
    this.#watcher.on('event', e => {
      // Discover session_id for new sessions so we can watch for the stop sentinel.
      if (e.session_id && !this.#sessionId) {
        this.#sessionId = e.session_id;
        this.#watchForStop();
      }
      this.emit('event', e);
    });
    this.#watcher.start().catch(() => {});

    // Resumed sessions already know the session_id — set up the stop watcher now.
    if (claudeSessionId) this.#watchForStop();
  }

  // Send a plain-text message to the Claude interactive session.
  send(message) {
    if (this.closed) return;
    if (!this.#ready) {
      // Claude's TUI hasn't shown its first prompt yet — queue and wait.
      // The startup timeout ensures we don't wait forever.
      this.#pendingSend = message;
      clearTimeout(this.#silenceTimer);
      this.#silenceTimer = setTimeout(() => {
        // Force-flush: if Claude never shows a prompt, send anyway.
        // The ❯ prompt uses ANSI cursor-movement codes that are invisible after
        // strip-ansi, so detectPrompt never fires in practice. The 12 s timer
        // is the reliable path for all first-turn messages.
        if (this.#pendingSend !== null) {
          const msg = this.#pendingSend;
          this.#pendingSend = null;
          this.#ready = true;
          this.#doSend(msg);
        }
      }, STARTUP_TIMEOUT_MS);
      return;
    }
    this.#doSend(message);
  }

  #doSend(message) {
    this.#resultEmitted = false; // open new turn
    // Safety timeout: if Claude never outputs anything after sending,
    // emit result after STARTUP_TIMEOUT_MS. #onData resets this to TURN_TIMEOUT_MS on first chunk.
    clearTimeout(this.#silenceTimer);
    this.#silenceTimer = setTimeout(() => this.#emitResult(), STARTUP_TIMEOUT_MS);
    // Sanitize message to avoid multi-byte UTF-8 sequences whose continuation
    // bytes (0x80–0xBF) land in the C1 control-code range and get mishandled
    // by Claude's Ink TUI input handler, silently garbling the message.
    const safe = message
      .replace(/[–—]/g, '-')   // en-dash, em-dash → hyphen
      .replace(/['']/g, "'")   // left/right single quote → apostrophe
      .replace(/[""]/g, '"')   // left/right double quote → straight quote
      .replace(/…/g, '...')         // ellipsis → triple dot
      .replace(/ /g, ' ');          // non-breaking space → regular space
    // Write the message text first, then send Enter (CR) after a short delay.
    // Sending safe + '\r' as one write causes Ink's input handler to miss the CR
    // for messages longer than ~50 chars: the TUI renders the input field but
    // never submits. A 50 ms gap lets the TUI event loop process all message
    // characters before the CR arrives, so Enter always triggers submission
    // regardless of message length.
    this.#pty.write(safe);
    setTimeout(() => this.#pty.write('\r'), 50);
  }

  kill() {
    if (!this.closed) this.#pty.kill();
  }

  // Watch /tmp for the sentinel file written by the Stop hook (turn-complete.sh).
  // The Stop hook fires AFTER Claude has flushed the JSONL transcript, so by
  // the time we react to the sentinel the TranscriptWatcher has already (or will
  // shortly, within its 50 ms debounce) delivered all assistant events.
  //
  // Two cases:
  //   Active turn  (#resultEmitted = false): processMessage is running.
  //     → #handleStopSentinel: delete sentinel, wait 150 ms, emit `result`.
  //   Background turn (#resultEmitted = true): orchestrator is handling agent
  //     messages (idle_notifications, merge confirmations) after the active turn
  //     ended. processMessage is NOT running.
  //     → #handleBackgroundSentinel: delete sentinel, flush JSONL, emit
  //       `background_result` so turn.js can forward output to clients.
  #watchForStop() {
    if (!this.#sessionId || this.#stopDirWatcher) return;
    const sentinel = `pty-turn-done-${this.#sessionId}`;
    const sentinelPath = `/tmp/${sentinel}`;

    this.#stopDirWatcher = watch('/tmp', { persistent: false }, (_, filename) => {
      if (filename !== sentinel) return;
      if (!this.#resultEmitted) {
        this.#handleStopSentinel(sentinelPath);
      } else {
        this.#handleBackgroundSentinel(sentinelPath);
      }
    });

    // Post-attach check: catch sentinel that appeared before watch() attached.
    access(sentinelPath)
      .then(() => {
        if (!this.#resultEmitted) this.#handleStopSentinel(sentinelPath);
        else this.#handleBackgroundSentinel(sentinelPath);
      })
      .catch(() => {});
  }

  // Handle a Stop-hook sentinel that arrived while the session was idle
  // (no active processMessage loop). Flush the JSONL watcher so any assistant
  // events from this background turn are forwarded to listeners, then emit
  // `background_result` so turn.js can broadcast the output and refresh progress.
  // Does NOT call consumeTurnUsage() — token accounting stays cumulative and
  // is collected in full by the next active-turn #emitResult() call.
  #handleBackgroundSentinel(sentinelPath) {
    unlink(sentinelPath).catch(() => {});
    setTimeout(async () => {
      await this.#watcher?.flush().catch(() => {});
      await new Promise(r => setTimeout(r, 100));
      await this.#watcher?.flush().catch(() => {});
      this.emit('event', { type: 'background_result' });
    }, 150);
  }

  #handleStopSentinel(sentinelPath) {
    unlink(sentinelPath).catch(() => {});
    // 150 ms: the file-watcher debounce is 50 ms, so by 150 ms the debounced
    // #poll() will have run and emitted the assistant event. Without this margin
    // the 50 ms sentinel delay raced the 50 ms file-watcher debounce.
    setTimeout(() => this.#emitResult(), 150);
  }

  #onData(chunk) {
    // Respond to terminal capability queries so Claude's Ink TUI can initialize.
    // Without these, Ink blocks waiting for terminal responses and ❯ never appears.
    if (chunk.includes('\x1b[>0q')) this.#pty.write('\x1bP>|xterm(314)\x1b\\'); // XTVERSION
    if (chunk.includes('\x1b[c'))   this.#pty.write('\x1b[?1;2c');   // DA1
    if (chunk.includes('\x1b[?2026$p')) this.#pty.write('\x1b[?2026;1$y');      // DECRQM mode 2026

    const text = stripAnsi(chunk);
    // Always buffer for friendlyError classification (e.g. auth/network errors).
    this.#outputBuffer = (this.#outputBuffer + text).slice(-OUTPUT_BUFFER_LIMIT);
    // Detect first-ever prompt while idle → Claude TUI is ready for input.
    // In practice this never fires: the ❯ prompt is drawn via ANSI cursor-movement
    // codes that are invisible after strip-ansi. The startup force-flush timer
    // (STARTUP_TIMEOUT_MS) is the reliable path for all first-turn messages.
    if (!this.#ready && detectPrompt(text)) {
      this.#ready = true;
      if (this.#pendingSend !== null) {
        const msg = this.#pendingSend;
        this.#pendingSend = null;
        this.#doSend(msg);
      }
      return;
    }
    if (this.#resultEmitted) return; // idle — don't drive turn-end detection
    // Reset silence window (overrides the startup safety timer).
    // Turn completion is driven by the Stop hook sentinel, not prompt detection —
    // detecting the ❯ prompt here would race with the JSONL watcher (50 ms debounce).
    clearTimeout(this.#silenceTimer);
    this.#silenceTimer = setTimeout(() => this.#emitResult(), TURN_TIMEOUT_MS);
  }

  async #emitResult() {
    if (this.#resultEmitted) return; // idempotent
    this.#resultEmitted = true;
    clearTimeout(this.#silenceTimer);
    await this.#watcher?.flush().catch(() => {});
    // Second flush after a brief pause: catches assistant events that weren't
    // on disk yet when the first flush ran (OS write buffering, or new-session
    // JSONL discovery still in flight when the sentinel arrived).
    await new Promise(r => setTimeout(r, 100));
    await this.#watcher?.flush().catch(() => {});

    // Collect token usage from JSONL (main session + subagents). This gives
    // accurate per-model token counts and cost even without stream-json events.
    const modelUsage = await this.#watcher?.consumeTurnUsage().catch(() => null) ?? {};
    let total_cost_usd = 0;
    for (const [model, mu] of Object.entries(modelUsage)) {
      const perModelCost = costFromBreakdown(model, {
        input:       mu.inputTokens              || 0,
        cacheCreate: mu.cacheCreationInputTokens || 0,
        output:      mu.outputTokens             || 0,
        cacheRead:   mu.cacheReadInputTokens     || 0,
      });
      // Populate costUSD so sendStats / computeSummary use the right cost without
      // falling back to (null || 0) which zeros out per-model cost in the tooltip.
      mu.costUSD = perModelCost;
      total_cost_usd += perModelCost;
    }

    this.emit('event', { type: 'result', is_error: false, total_cost_usd, modelUsage });
  }
}
