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
  return /(?:^|\n)[❯>]\s*$/.test(text.trimEnd());
}

const TURN_TIMEOUT_MS = 1500;     // silence after last PTY chunk → turn done
const STARTUP_TIMEOUT_MS = 30_000; // safety: Claude never responded at all
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

    const args = ['--dangerously-skip-permissions'];
    if (claudeSessionId) args.push('--resume', claudeSessionId);
    if (model) args.push('--model', model);

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
    // emit result after 30 s. #onData resets this to TURN_TIMEOUT_MS on first chunk.
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
    // 100 ms buffer: TranscriptWatcher debounce is 50 ms — give it time to
    // deliver assistant events before we close the turn with `result`.
    setTimeout(() => this.#emitResult(), 100);
  }

  #onData(chunk) {
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

  #emitResult() {
    if (this.#resultEmitted) return; // idempotent
    this.#resultEmitted = true;
    clearTimeout(this.#silenceTimer);
    this.emit('event', { type: 'result', is_error: false, total_cost_usd: 0, modelUsage: {} });
  }
}
