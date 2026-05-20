import pty from 'node-pty';
import stripAnsi from 'strip-ansi';
import { EventEmitter } from 'node:events';
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

export class PtySession extends EventEmitter {
  #pty;
  #watcher;
  #silenceTimer = null;
  #resultEmitted = true; // true = idle (no active turn), prevents spurious result on startup
  closed = false;

  constructor(claudeSessionId, sessionDir) {
    super();
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
      this.#watcher?.close();
      this.emit('exit', exitCode ?? 1);
    });

    this.#watcher = new TranscriptWatcher(claudeSessionId, PROJECT_DIR);
    this.#watcher.on('event', e => this.emit('event', e));
    this.#watcher.start().catch(() => {});
  }

  // Send a plain-text message to the Claude interactive session.
  send(message) {
    if (this.closed) return;
    this.#resultEmitted = false; // open new turn
    // Safety timeout: if Claude never outputs anything (hang/crash before PTY data),
    // emit result after 30 s. #onData resets this to TURN_TIMEOUT_MS on first chunk.
    clearTimeout(this.#silenceTimer);
    this.#silenceTimer = setTimeout(() => this.#emitResult(), STARTUP_TIMEOUT_MS);
    this.#pty.write(message + '\r');
  }

  kill() {
    if (!this.closed) this.#pty.kill();
  }

  #onData(chunk) {
    if (this.#resultEmitted) return; // idle — ignore startup noise
    const text = stripAnsi(chunk);
    // Reset to short silence window; overrides the 30 s startup safety timer.
    clearTimeout(this.#silenceTimer);
    this.#silenceTimer = setTimeout(() => this.#emitResult(), TURN_TIMEOUT_MS);
    if (detectPrompt(text)) this.#emitResult();
  }

  #emitResult() {
    if (this.#resultEmitted) return; // idempotent
    this.#resultEmitted = true;
    clearTimeout(this.#silenceTimer);
    this.emit('event', { type: 'result', is_error: false, total_cost_usd: 0, modelUsage: {} });
  }
}
