# Interactive Claude Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `--print` from the Claude spawn; use `node-pty` for interactive mode with JSONL transcript watching for text extraction and ANSI prompt detection for turn-end.

**Architecture:** `PtySession` is rewritten to spawn `claude --dangerously-skip-permissions` via `node-pty`, which creates a proper PTY so Claude's terminal queries are answered automatically. A new `TranscriptWatcher` class watches Claude's JSONL transcript file and emits `{type:'assistant', message:{...}}` events — same format the stream-json pipeline already produces — so `turn.js` needs no logic changes. Turn-end is signaled by a synthetic `{type:'result'}` event emitted when the Claude prompt pattern is detected in PTY output, with a 1500 ms silence fallback.

**Tech Stack:** Node.js 22 (ESM), `node-pty ^1.0.0` (native, compiles with existing build tools), `strip-ansi ^7.1.0` (ESM), `node:test` + `node:assert/strict` for tests, `node:fs/promises` + `node:fs` for JSONL watching.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `chat-service/package.json` | Modify | Add node-pty + strip-ansi deps |
| `chat-service/lib/server/transcript-watcher.js` | Create | Watch JSONL transcript, emit compatible events, discover session ID |
| `chat-service/lib/server/pty-session.js` | Rewrite | node-pty spawn, use TranscriptWatcher, prompt detection, synthetic result event |
| `chat-service/test/transcript-watcher.test.js` | Create | Unit tests for JSONL watching and session ID discovery |
| `chat-service/test/pty-session.test.js` | Create | Unit tests for prompt detection logic |
| `chat-service/lib/server/turn.js` | Verify | No logic changes expected; confirm event compatibility |
| `chat-service/lib/server/claude-spawn.js` | Verify | `spawnClaude` kept as-is for `regenerateTitleWithHaiku` |

---

## Task 1: Add dependencies

**Files:**
- Modify: `chat-service/package.json`

- [ ] **Step 1: Add node-pty and strip-ansi to package.json**

Replace the `dependencies` block:

```json
"dependencies": {
  "ws": "^8.18.0",
  "node-pty": "^1.0.0",
  "strip-ansi": "^7.1.0"
}
```

- [ ] **Step 2: Install and verify build succeeds**

```bash
cd /workspaces/crm-builder/chat-service && npm install
```

Expected: `node_modules/node-pty/` contains compiled `.node` file. If compilation fails, check that `python3`, `make`, `g++` are on PATH (`which python3 make g++`).

- [ ] **Step 3: Smoke-check the imports compile**

```bash
cd /workspaces/crm-builder/chat-service && node -e "
import('node-pty').then(m => console.log('node-pty ok', typeof m.default.spawn));
import('strip-ansi').then(m => console.log('strip-ansi ok', typeof m.default));
"
```

Expected: two lines `node-pty ok function` and `strip-ansi ok function`.

- [ ] **Step 4: Commit**

```bash
cd /workspaces/crm-builder && git add chat-service/package.json chat-service/package-lock.json && git commit -m "feat: add node-pty and strip-ansi dependencies"
```

---

## Task 2: TranscriptWatcher — failing tests

**Files:**
- Create: `chat-service/test/transcript-watcher.test.js`

The TranscriptWatcher class will:
- On new sessions: watch a directory for a new `.jsonl` file, emit `{session_id: id}` when found, then watch the file.
- On resumed sessions: seek to end-of-file, then watch for new lines.
- On each new assistant JSONL entry: emit `{type:'assistant', message:{...}}` verbatim.

- [ ] **Step 1: Write failing tests**

Create `chat-service/test/transcript-watcher.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TranscriptWatcher } from '../lib/server/transcript-watcher.js';

// Helper: wait for an event with timeout
function waitForEvent(emitter, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for '${event}'`)), timeoutMs);
    emitter.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}

test('TranscriptWatcher: emits session_id when new .jsonl appears in dir', async () => {
  const dir = join(tmpdir(), `tw-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  const watcher = new TranscriptWatcher(null, dir);
  const eventPromise = waitForEvent(watcher, 'event');
  await watcher.start();

  // Simulate Claude creating its session file
  const sessionId = 'abc123-test-session-id';
  await writeFile(join(dir, `${sessionId}.jsonl`), '');

  const ev = await eventPromise;
  assert.equal(ev.session_id, sessionId);

  watcher.close();
  await rm(dir, { recursive: true });
});

test('TranscriptWatcher: emits assistant event when new line appended to watched file', async () => {
  const dir = join(tmpdir(), `tw-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sessionId = 'def456-test-session';
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  const watcher = new TranscriptWatcher(sessionId, dir);
  await watcher.start();

  const eventPromise = waitForEvent(watcher, 'event');

  const assistantEntry = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    uuid: 'u1',
    sessionId,
  };
  await appendFile(jsonlPath, JSON.stringify(assistantEntry) + '\n');

  const ev = await eventPromise;
  assert.equal(ev.type, 'assistant');
  assert.equal(ev.message.content[0].text, 'Hello!');

  watcher.close();
  await rm(dir, { recursive: true });
});

test('TranscriptWatcher: skips existing lines on resume, only emits new ones', async () => {
  const dir = join(tmpdir(), `tw-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sessionId = 'ghi789-resume';
  const jsonlPath = join(dir, `${sessionId}.jsonl`);

  // Pre-existing content (old turn)
  const oldEntry = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Old message' }] },
    uuid: 'old', sessionId,
  };
  await writeFile(jsonlPath, JSON.stringify(oldEntry) + '\n');

  const watcher = new TranscriptWatcher(sessionId, dir);
  await watcher.start();  // should seek to end, skip old entry

  const events = [];
  watcher.on('event', e => events.push(e));

  // Append new content
  const newEntry = {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'New message' }] },
    uuid: 'new', sessionId,
  };
  await appendFile(jsonlPath, JSON.stringify(newEntry) + '\n');

  // Give the watcher time to pick it up
  await new Promise(r => setTimeout(r, 300));

  assert.equal(events.length, 1, 'should emit only the new entry, not the old one');
  assert.equal(events[0].message.content[0].text, 'New message');

  watcher.close();
  await rm(dir, { recursive: true });
});

test('TranscriptWatcher: ignores non-assistant JSONL entries', async () => {
  const dir = join(tmpdir(), `tw-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sessionId = 'jkl012-filter';
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  const watcher = new TranscriptWatcher(sessionId, dir);
  await watcher.start();

  const events = [];
  watcher.on('event', e => events.push(e));

  const userEntry = { type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u2', sessionId };
  await appendFile(jsonlPath, JSON.stringify(userEntry) + '\n');
  await new Promise(r => setTimeout(r, 300));

  assert.equal(events.length, 0, 'should not emit user entries');

  watcher.close();
  await rm(dir, { recursive: true });
});
```

- [ ] **Step 2: Run tests and confirm they fail (module not found)**

```bash
cd /workspaces/crm-builder/chat-service && node --test 'test/transcript-watcher.test.js' 2>&1 | head -20
```

Expected: `ERR_MODULE_NOT_FOUND` for `transcript-watcher.js`.

---

## Task 3: Implement TranscriptWatcher

**Files:**
- Create: `chat-service/lib/server/transcript-watcher.js`

- [ ] **Step 1: Create the module**

Create `chat-service/lib/server/transcript-watcher.js`:

```javascript
import { EventEmitter } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, basename } from 'node:path';

export class TranscriptWatcher extends EventEmitter {
  #sessionId;
  #projectDir;
  #jsonlPath = null;
  #linesRead = 0;
  #fileWatcher = null;
  #dirWatcher = null;
  closed = false;

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
        this.#linesRead = content.split('\n').length;
      } catch { /* file doesn't exist yet — will be created shortly */ }
      this.#watchFile();
    } else {
      await this.#watchDir();
    }
  }

  close() {
    this.closed = true;
    this.#fileWatcher?.close();
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

    this.#dirWatcher = watch(this.#projectDir, { persistent: false }, (event, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      if (before.has(filename)) return;
      before.add(filename); // deduplicate rapid fire events

      const id = basename(filename, '.jsonl');
      this.#sessionId = id;
      this.#jsonlPath = join(this.#projectDir, filename);

      this.emit('event', { session_id: id });

      this.#dirWatcher?.close();
      this.#dirWatcher = null;
      this.#watchFile();
    });
  }

  #watchFile() {
    // Debounce rapid change events — JSONL writes can trigger multiple events.
    let debounce = null;
    this.#fileWatcher = watch(this.#jsonlPath, { persistent: false }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.#poll().catch(() => {}), 50);
    });
    // Initial poll in case lines were written before the watcher was attached.
    this.#poll().catch(() => {});
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
      if (!raw) { this.#linesRead = i + 1; continue; }
      let entry;
      try { entry = JSON.parse(raw); } catch { break; } // partial line — retry next poll
      this.#linesRead = i + 1;
      if (entry.type === 'assistant') {
        this.emit('event', entry);
      }
    }
  }
}
```

- [ ] **Step 2: Run tests and confirm they pass**

```bash
cd /workspaces/crm-builder/chat-service && node --test 'test/transcript-watcher.test.js' 2>&1
```

Expected: 4 passing tests. If `session_id` event test is flaky (timing), increase the `writeFile` delay or check that `fs.watch` works in the environment.

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
cd /workspaces/crm-builder/chat-service && npm test
```

Expected: all existing tests pass.

- [ ] **Step 4: Commit**

```bash
cd /workspaces/crm-builder && git add chat-service/lib/server/transcript-watcher.js chat-service/test/transcript-watcher.test.js && git commit -m "feat: add TranscriptWatcher for JSONL-based message extraction"
```

---

## Task 4: PtySession — failing tests for prompt detection

**Files:**
- Create: `chat-service/test/pty-session.test.js`

The prompt detection logic will be extracted as an exported helper `detectPrompt(strippedText)` so it can be unit-tested without spawning a real PTY.

- [ ] **Step 1: Write failing tests**

Create `chat-service/test/pty-session.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPrompt } from '../lib/server/pty-session.js';

// Claude Code interactive prompt appears on its own after a response.
// After strip-ansi the prompt line contains ❯ or > near the end.

test('detectPrompt: returns true for ❯ at end of text', () => {
  assert.equal(detectPrompt('some text\n❯ '), true);
});

test('detectPrompt: returns true for > at end of line', () => {
  assert.equal(detectPrompt('response text\n> '), true);
});

test('detectPrompt: returns false for mid-text > (not a prompt)', () => {
  assert.equal(detectPrompt('Here is a comparison: a > b and c < d'), false);
});

test('detectPrompt: returns false for empty string', () => {
  assert.equal(detectPrompt(''), false);
});

test('detectPrompt: returns true for ❯ with trailing spaces', () => {
  assert.equal(detectPrompt('done\n❯   '), true);
});

test('detectPrompt: returns false for > inside a code block line', () => {
  // > appears mid-line in markdown blockquotes — should not trigger
  assert.equal(detectPrompt('> This is a blockquote line with more text after'), false);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /workspaces/crm-builder/chat-service && node --test 'test/pty-session.test.js' 2>&1 | head -20
```

Expected: `ERR_MODULE_NOT_FOUND` or `detectPrompt is not exported`.

---

## Task 5: Rewrite PtySession with node-pty

**Files:**
- Modify: `chat-service/lib/server/pty-session.js`

The new `PtySession`:
- Spawns `claude --dangerously-skip-permissions` via `node-pty`
- Uses `TranscriptWatcher` for text events — forwarded verbatim to listeners
- Detects Claude's interactive prompt via `detectPrompt()` to emit a synthetic `result` event
- `send()` starts a 30 s safety timer (handles the case where Claude never outputs anything)
- `#onData` resets the timer to 1500 ms on each chunk (silence after response → turn end)
- JSONL assistant events always arrive well before the 1500 ms timer fires (JSONL written before PTY goes quiet)

- [ ] **Step 1: Rewrite the module**

Overwrite `chat-service/lib/server/pty-session.js` entirely:

```javascript
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
```

- [ ] **Step 2: Run PtySession unit tests**

```bash
cd /workspaces/crm-builder/chat-service && node --test 'test/pty-session.test.js' 2>&1
```

Expected: 6 passing tests. If `detectPrompt` regex needs tuning (e.g. real Claude prompt differs), adjust the regex. The key invariant: matches only when `❯` or `>` is the last non-whitespace content on a line by itself.

- [ ] **Step 3: Run full test suite**

```bash
cd /workspaces/crm-builder/chat-service && npm test
```

Expected: all tests pass (including transcript-watcher tests).

- [ ] **Step 4: Commit**

```bash
cd /workspaces/crm-builder && git add chat-service/lib/server/pty-session.js chat-service/test/pty-session.test.js && git commit -m "feat: rewrite PtySession with node-pty and JSONL transcript watcher"
```

---

## Task 6: Verify turn.js compatibility

**Files:**
- Read: `chat-service/lib/server/turn.js` (no changes expected)

- [ ] **Step 1: Confirm event shape compatibility**

Open `chat-service/lib/server/turn.js` and check each event handler against what `PtySession` now emits:

| `turn.js` checks | What `PtySession` now emits | Compatible? |
|---|---|---|
| `if (event.session_id)` | `{session_id: id}` from TranscriptWatcher | ✓ |
| `extractText(event)` needs `event.type==='assistant'` + `event.message.content` | JSONL assistant entries have exactly this shape | ✓ |
| `event.type === 'result'` | Synthetic `{type:'result', ...}` | ✓ |
| `event.modelUsage` for token breakdown | `{}` → zeros | ✓ (graceful zero) |
| `event.total_cost_usd` | `0` | ✓ (graceful zero) |
| `event.type === 'system'` for agent tracking | Never emitted | ✓ (counter stays 0) |
| `event.type === 'rate_limit_event'` | Never emitted | ✓ (no rate-limit display) |
| `extractToolUses(event)` | Returns `[]` from JSONL entries | ✓ (pendingTicketWrites no-op) |

If any check fails (e.g. JSONL entry shape differs from expected), fix `TranscriptWatcher` emit.

- [ ] **Step 2: Confirm buildPrompt still works for system prompt injection**

In `turn.js`, `buildPrompt(prompt, sessionDir, isNewSession)` wraps the first message with `<instructions>...</instructions>` when `isNewSession=true`. In interactive mode this is sent as plain text to the PTY — Claude reads and follows it as user-provided instructions (same behavior as the stream-json approach, which also injects instructions via the first user message, not a real system prompt).

No change needed. Verify `getSystemPrompt()` in `system-prompt.js` is still called at startup (in `server.js` or equivalent).

- [ ] **Step 3: Confirm claude-spawn.js is still imported correctly**

`turn.js` imports `rewriteUserMessage`, `extractText`, `extractToolUses`, `friendlyError` from `claude-spawn.js`. The `spawnClaude` function in `claude-spawn.js` is only used by `regenerateTitleWithHaiku` — still valid.

No changes needed.

- [ ] **Step 4: Run full test suite one final time**

```bash
cd /workspaces/crm-builder/chat-service && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit if any minor fixes were made**

```bash
cd /workspaces/crm-builder && git add -p && git commit -m "fix: turn.js compatibility adjustments for interactive Claude mode"
```

Skip if no changes were needed.

---

## Task 7: Manual smoke test

**No automated test for PTY spawn** — requires a running Claude in the container.

- [ ] **Step 1: Start the container and open a test session**

```bash
# From host
make up   # starts demo stack
# Then open http://localhost:5173 in browser
```

- [ ] **Step 2: Send a first message and verify**

Type "Hello" in the chat. Verify:
1. Chat UI shows a working bubble (Claude is processing)
2. An assistant reply appears within ~10 seconds
3. No infinite spinner (turn-end detection fired)
4. Browser console (`debug_raw` details) shows `{type:'assistant', message:{...}}` events from JSONL, and a `{type:'result'}` synthetic event at the end

- [ ] **Step 3: Send a second message (session reuse)**

Type a follow-up message. Verify:
1. The session ID is the same (no new spawn — `runtime.ptySession` reused)
2. Claude's reply is coherent with the previous exchange
3. Turn ends cleanly again

- [ ] **Step 4: Test a CRM change request**

Type a substantive request like "Add a Priority field to contacts". Verify the full agent team flow works: planner dispatches, developer implements, merger merges. The `activeAgents` counter will show 0 (accepted limitation), but the workflow itself should complete.

- [ ] **Step 5: If Claude blocks at startup (terminal queries unanswered)**

If Claude hangs and never sends any PTY output: check `runtime.ptySession.stderr` in a debug log. If errors mention terminal capability queries, install `unbuffer` and wrap the spawn:

```javascript
// In pty-session.js constructor, replace:
this.#pty = pty.spawn('claude', args, { ... });
// With:
this.#pty = pty.spawn('unbuffer', ['claude', ...args], { ... });
// and add `apt install expect` to Dockerfile
```

This is the documented fallback — should not be needed since node-pty provides a real PTY.
