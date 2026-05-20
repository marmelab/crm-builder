import pty from 'node-pty';
import stripAnsi from 'strip-ansi';
import { EventEmitter } from 'node:events';
import { access, unlink } from 'node:fs/promises';
import { watch } from 'node:fs';
import { CWD, CLAUDE_HOME } from './config.js';
import { getOrchestratorModel } from './system-prompt.js';
import { buildSpawnEnv } from '../spawn-env.js';
import { TranscriptWatcher } from './transcript-watcher.js';
import { join } from 'node:path';

// Exported for unit testing.
export function detectPrompt(text) {
  // Match ❯ or > at the very end of the text (after trimming trailing whitespace),
  // only when preceded by a newline or start-of-string — i.e. it's on its own line.
  // The welcome-screen "❯ <suggestion>" does NOT match (❯ is mid-text there).
  return /(?:^|\n)[❯>]\s*$/.test(text.trimEnd());
}

const TURN_TIMEOUT_MS = 15_000;   // fallback: silence after last PTY chunk → turn done (Stop hook is primary)
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
        // Force-flush: if Claude never shows a prompt, send anyway and hope.
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
    this.#pty.write(message + '\r');
  }

  kill() {
    if (!this.closed) this.#pty.kill();
  }

  // Watch /tmp for the sentinel file written by the Stop hook (turn-complete.sh).
  // The Stop hook fires AFTER Claude has flushed the JSONL transcript, so by
  // the time we react to the sentinel the TranscriptWatcher has already (or will
  // shortly, within its 50 ms debounce) delivered all assistant events.
  #watchForStop() {
    if (!this.#sessionId || this.#stopDirWatcher) return;
    const sentinel = `pty-turn-done-${this.#sessionId}`;
    const sentinelPath = `/tmp/${sentinel}`;

    this.#stopDirWatcher = watch('/tmp', { persistent: false }, (_, filename) => {
      if (filename === sentinel && !this.#resultEmitted) {
        this.#handleStopSentinel(sentinelPath);
      }
    });

    // Post-attach check: catch sentinel that appeared before watch() attached.
    access(sentinelPath)
      .then(() => { if (!this.#resultEmitted) this.#handleStopSentinel(sentinelPath); })
      .catch(() => {});
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
    // Reset silence window (overrides the 30 s startup safety timer).
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
    this.emit('event', { type: 'result', is_error: false, total_cost_usd: 0, modelUsage: {} });
  }
}
