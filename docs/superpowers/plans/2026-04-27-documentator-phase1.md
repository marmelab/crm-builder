# Documentator Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily-running synthesizer agent that reads reflections + hooks.log + session logs + stats + user-friction signals, and maintains a structured patterns ledger (`docs/learnings/patterns.md`) for human review. No config mutation in phase 1.

**Architecture:** A node-cron task inside the existing chat-service spawns a one-shot claude process at 03:00 daily (or via `POST /api/documentator/run`). The spawned process runs the new `documentator` agent which reads source files via Read/Glob/Grep, edits `patterns.md`, and writes an audit trail to `docs/learnings/runs/<date>-run.md`. A PreToolUse hook restricts the documentator's Bash usage to a strict whitelist (gated by env var `DOCUMENTATOR_RUN=1`) so it cannot escape its read-only mandate.

**Tech Stack:** Node 22 (`type: module`), node-cron, native `node --test`, claude CLI, bash 5, markdown.

**Reference spec:** [docs/superpowers/specs/2026-04-27-documentator-design.md](../specs/2026-04-27-documentator-design.md)

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `docs/learnings/patterns.md` | new (seed) | Ledger of detected patterns, amended by documentator |
| `docs/learnings/runs/.gitkeep` | new | Keep the audit-log dir versioned |
| `chat-service/package.json` | modified | Add `node-cron` dependency |
| `chat-service/lib/documentator-cron.js` | new (~120 lines) | Pure-ish module: skip-check helper, prompt loader, spawn wrapper, schedule wiring |
| `chat-service/test/documentator-cron.test.js` | new | Unit tests for skip-check + prompt-loader |
| `chat-service/test/fixtures/documentator-agent.md` | new | Fixture used by prompt-loader test |
| `chat-service/server.js` | modified (~10 lines added) | Wire cron at boot + register `POST /api/documentator/run` |
| `claudeConfig/.claude/agents/documentator.md` | new | Agent definition: frontmatter + prose |
| `claudeConfig/.claude/hooks/restrict-documentator-bash.sh` | new | PreToolUse / Bash whitelist hook gated on `$DOCUMENTATOR_RUN` |
| `claudeConfig/.claude/settings.json` | modified | Register the new hook under `hooks.PreToolUse[].matcher: Bash` |

---

## Task 1: Bootstrap learnings directory structure

**Files:**
- Create: `docs/learnings/patterns.md`
- Create: `docs/learnings/runs/.gitkeep`

- [ ] **Step 1: Create the seed patterns.md**

Write the file `docs/learnings/patterns.md` with this exact content:

```markdown
# Patterns ledger

This file is maintained by the `documentator` agent. Each entry below is a recurring friction pattern detected across reflections, hook failures, agent retries, stats, and user-side signals.

In phase 1 the entries are **read-only for humans**: no agent loads this file at runtime, no automatic action is taken. The maintainer reviews entries to validate the documentator's detection quality and the appliquability of its proposed actions.

See [docs/superpowers/specs/2026-04-27-documentator-design.md](../superpowers/specs/2026-04-27-documentator-design.md) for the full design.

---

<!-- Patterns appear below this line. Documentator preserves the file header verbatim. -->
```

- [ ] **Step 2: Create the runs directory placeholder**

Run:
```bash
mkdir -p docs/learnings/runs
touch docs/learnings/runs/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add docs/learnings/patterns.md docs/learnings/runs/.gitkeep
git commit -m "feat(learnings): seed patterns ledger and runs audit dir"
```

---

## Task 2: Add node-cron dependency

**Files:**
- Modify: `chat-service/package.json`
- Modify: `chat-service/package-lock.json` (regenerated)

- [ ] **Step 1: Install node-cron in chat-service**

Run:
```bash
cd chat-service && npm install --save node-cron@^3.0.3
```

Expected: `package.json` gains a `dependencies.node-cron` entry; `package-lock.json` is created or updated.

- [ ] **Step 2: Verify install**

Run:
```bash
cd chat-service && node -e "import('node-cron').then(m => console.log('ok', typeof m.default.schedule))"
```

Expected output: `ok function`

- [ ] **Step 3: Commit**

```bash
git add chat-service/package.json chat-service/package-lock.json
git commit -m "chore(chat-service): add node-cron dependency"
```

---

## Task 3: TDD `shouldSkipRun` helper

**Files:**
- Create: `chat-service/lib/documentator-cron.js`
- Create: `chat-service/test/documentator-cron.test.js`

The helper decides whether the cron tick should fire claude or skip. It returns `true` (skip) when no session log has been touched since the last run.

- [ ] **Step 1: Write the failing test**

Create `chat-service/test/documentator-cron.test.js` with:

```javascript
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldSkipRun } from '../lib/documentator-cron.js';

async function makeTmpRoot() {
  const root = join(tmpdir(), `doctest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

test('shouldSkipRun returns false when last-run marker is missing', async () => {
  const root = await makeTmpRoot();
  const sessionsDir = join(root, 'logs');
  await mkdir(sessionsDir, { recursive: true });
  const result = await shouldSkipRun(join(root, 'last-run.txt'), sessionsDir);
  assert.strictEqual(result, false);
  await rm(root, { recursive: true, force: true });
});

test('shouldSkipRun returns true when no session log is newer than last-run', async () => {
  const root = await makeTmpRoot();
  const sessionsDir = join(root, 'logs');
  await mkdir(join(sessionsDir, 'sess-A'), { recursive: true });
  await writeFile(join(sessionsDir, 'sess-A', 'log.jsonl'), '');
  const old = new Date(Date.now() - 60_000);
  await utimes(join(sessionsDir, 'sess-A', 'log.jsonl'), old, old);
  const lastRunPath = join(root, 'last-run.txt');
  await writeFile(lastRunPath, new Date().toISOString());
  const result = await shouldSkipRun(lastRunPath, sessionsDir);
  assert.strictEqual(result, true);
  await rm(root, { recursive: true, force: true });
});

test('shouldSkipRun returns false when at least one session log is newer than last-run', async () => {
  const root = await makeTmpRoot();
  const sessionsDir = join(root, 'logs');
  await mkdir(join(sessionsDir, 'sess-A'), { recursive: true });
  const lastRunPath = join(root, 'last-run.txt');
  await writeFile(lastRunPath, 'old');
  const old = new Date(Date.now() - 60_000);
  await utimes(lastRunPath, old, old);
  await writeFile(join(sessionsDir, 'sess-A', 'log.jsonl'), '{}');
  const result = await shouldSkipRun(lastRunPath, sessionsDir);
  assert.strictEqual(result, false);
  await rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests, expect failure**

Run:
```bash
cd chat-service && node --test 'test/documentator-cron.test.js'
```

Expected: 3 failed tests with `Cannot find module '../lib/documentator-cron.js'` or similar.

- [ ] **Step 3: Implement the helper**

Create `chat-service/lib/documentator-cron.js` with:

```javascript
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @param {string} lastRunPath  Path to the last-run marker file (mtime is used).
 * @param {string} sessionsDir  Path to /chat-service/logs/ (one subdir per session).
 * @returns {Promise<boolean>}  true → no new activity, skip the run.
 */
export async function shouldSkipRun(lastRunPath, sessionsDir) {
  let lastRunMtime;
  try {
    const s = await stat(lastRunPath);
    lastRunMtime = s.mtime;
  } catch {
    return false;
  }

  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return true;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const logStat = await stat(join(sessionsDir, entry.name, 'log.jsonl'));
      if (logStat.mtime > lastRunMtime) return false;
    } catch {
      continue;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run:
```bash
cd chat-service && node --test 'test/documentator-cron.test.js'
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add chat-service/lib/documentator-cron.js chat-service/test/documentator-cron.test.js
git commit -m "feat(chat-service): add shouldSkipRun helper for documentator cron"
```

---

## Task 4: TDD `loadDocumentatorPrompt` helper

Mirrors the existing `loadSystemPrompt()` for the orchestrator (`chat-service/server.js:28`). Reads the agent file, parses frontmatter, returns `{ content, model }`.

**Files:**
- Modify: `chat-service/lib/documentator-cron.js` (append)
- Modify: `chat-service/test/documentator-cron.test.js` (append)
- Create: `chat-service/test/fixtures/documentator-agent.md`

- [ ] **Step 1: Create the test fixture**

Create `chat-service/test/fixtures/documentator-agent.md` with:

```markdown
---
name: documentator
description: Test fixture
model: sonnet
tools: [Read, Write, Edit, Glob, Grep, Bash]
skills: []
---

You are the documentator. Your job is to detect patterns.
```

- [ ] **Step 2: Add failing tests at the end of `documentator-cron.test.js`**

Append to `chat-service/test/documentator-cron.test.js`:

```javascript
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadDocumentatorPrompt } from '../lib/documentator-cron.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'documentator-agent.md');

test('loadDocumentatorPrompt returns model and content from a valid agent file', async () => {
  const result = await loadDocumentatorPrompt(fixturePath);
  assert.strictEqual(result.model, 'sonnet');
  assert.match(result.content, /You are the documentator\./);
  assert.doesNotMatch(result.content, /^---/m);
});

test('loadDocumentatorPrompt returns null model and empty content when file is missing', async () => {
  const result = await loadDocumentatorPrompt('/nonexistent/path.md');
  assert.strictEqual(result.model, null);
  assert.strictEqual(result.content, '');
});
```

- [ ] **Step 3: Run tests, expect new failures**

Run:
```bash
cd chat-service && node --test 'test/documentator-cron.test.js'
```

Expected: 3 passing (from Task 3), 2 failing (`loadDocumentatorPrompt is not a function`).

- [ ] **Step 4: Implement the helper**

Append to `chat-service/lib/documentator-cron.js`:

```javascript
import { readFile } from 'node:fs/promises';

/**
 * Reads a Claude agent markdown file (frontmatter + prose) and returns the
 * model identifier from frontmatter and the body text. Mirrors the
 * loadSystemPrompt() function in server.js.
 *
 * @param {string} agentMdPath
 * @returns {Promise<{ content: string, model: string|null }>}
 */
export async function loadDocumentatorPrompt(agentMdPath) {
  try {
    const raw = await readFile(agentMdPath, 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    const model = fm?.[1].match(/^model:\s*(\S+)/m)?.[1] || null;
    const content = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    return { content, model };
  } catch {
    return { content: '', model: null };
  }
}
```

- [ ] **Step 5: Run tests, expect all pass**

Run:
```bash
cd chat-service && node --test 'test/documentator-cron.test.js'
```

Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add chat-service/lib/documentator-cron.js chat-service/test/documentator-cron.test.js chat-service/test/fixtures/documentator-agent.md
git commit -m "feat(chat-service): add loadDocumentatorPrompt frontmatter parser"
```

---

## Task 5: Implement `runDocumentator` and `scheduleDocumentator`

The `runDocumentator` function spawns claude with the documentator prompt, streams stdout/stderr to a per-day audit file, then updates the last-run marker. `scheduleDocumentator` registers the daily cron entry. No new tests for the spawn itself (out of scope for unit tests — the smoke test in Task 10 covers it); we keep the function small and verifiable by reading.

**Files:**
- Modify: `chat-service/lib/documentator-cron.js`

- [ ] **Step 1: Append the run/schedule logic**

Append to `chat-service/lib/documentator-cron.js`:

```javascript
import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import cron from 'node-cron';

/**
 * Spawns a one-shot claude process running the documentator agent. Streams
 * stdout into the daily audit file. Updates the last-run marker on completion.
 *
 * @param {object} opts
 * @param {string} opts.sessionsDir   e.g. /chat-service/logs
 * @param {string} opts.lastRunPath   e.g. /app/docs/learnings/runs/last-run.txt
 * @param {string} opts.runsDir       e.g. /app/docs/learnings/runs
 * @param {string} opts.agentMdPath   path to documentator.md
 * @param {string} opts.claudeHome    HOME for the spawned claude process
 * @param {string} opts.cwd           cwd for the spawned claude process
 * @returns {Promise<{ skipped: boolean, exitCode?: number, auditPath?: string }>}
 */
export async function runDocumentator(opts) {
  const { sessionsDir, lastRunPath, runsDir, agentMdPath, claudeHome, cwd } = opts;
  if (await shouldSkipRun(lastRunPath, sessionsDir)) {
    return { skipped: true };
  }

  const { content: systemPrompt, model } = await loadDocumentatorPrompt(agentMdPath);
  if (!systemPrompt) {
    throw new Error(`documentator agent prompt missing or unreadable at ${agentMdPath}`);
  }

  await mkdir(runsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const auditPath = `${runsDir}/${today}-run.md`;

  const userMessage =
    `Run a documentator pass. Read the 5 sources described in your instructions, ` +
    `match each new event against the existing entries in docs/learnings/patterns.md, ` +
    `amend that file accordingly. Output a short summary of what you did.`;
  const prompt = `<instructions>\n${systemPrompt}\n</instructions>\n\n${userMessage}`;

  const args = ['--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (model) args.push('--model', model);
  args.push('-p', prompt);

  const proc = spawn('claude', args, {
    env: { ...process.env, HOME: claudeHome, DOCUMENTATOR_RUN: '1' },
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await appendFile(auditPath, `# Documentator run — ${new Date().toISOString()}\n\n## stream\n\n`);
  const audit = createWriteStream(auditPath, { flags: 'a' });
  proc.stdout.pipe(audit, { end: false });
  proc.stderr.on('data', (d) => audit.write(`[stderr] ${d}`));

  const exitCode = await new Promise((resolve) => {
    proc.once('close', resolve);
    proc.once('error', (err) => {
      audit.write(`\n[spawn-error] ${err.message}\n`);
      resolve(-1);
    });
  });
  audit.end();

  await writeFile(lastRunPath, new Date().toISOString());
  return { skipped: false, exitCode, auditPath };
}

/**
 * Registers a daily cron at 03:00 local time that calls runDocumentator.
 * Returns the ScheduledTask so callers can stop it in tests.
 */
export function scheduleDocumentator(opts) {
  return cron.schedule('0 3 * * *', async () => {
    try {
      const result = await runDocumentator(opts);
      console.log('[documentator]', result.skipped ? 'skipped (no activity)' : `ran exit=${result.exitCode}`);
    } catch (err) {
      console.error('[documentator] run failed:', err.message);
    }
  });
}
```

- [ ] **Step 2: Verify the module is still importable**

Run:
```bash
cd chat-service && node -e "import('./lib/documentator-cron.js').then(m => console.log(Object.keys(m)))"
```

Expected output: `[ 'shouldSkipRun', 'loadDocumentatorPrompt', 'runDocumentator', 'scheduleDocumentator' ]`

- [ ] **Step 3: Re-run unit tests to confirm no regression**

Run:
```bash
cd chat-service && node --test 'test/documentator-cron.test.js'
```

Expected: 5 passed (same as Task 4).

- [ ] **Step 4: Commit**

```bash
git add chat-service/lib/documentator-cron.js
git commit -m "feat(chat-service): add runDocumentator + scheduleDocumentator wrappers"
```

---

## Task 6: Wire cron + manual endpoint into `server.js`

**Files:**
- Modify: `chat-service/server.js`

We want minimal surface change: import, schedule at boot, add one POST handler. The endpoint lets us trigger the documentator manually (smoke testing + future deploy-trigger placeholder).

- [ ] **Step 1: Locate the imports and CLAUDE_HOME / CWD constants**

Run:
```bash
grep -n "CLAUDE_HOME\|^const CWD\|^import" chat-service/server.js | head -10
```

Note the line numbers for: existing imports block, `CLAUDE_HOME`, `CWD`. You'll insert the new import next to existing imports and the schedule call after the constants.

- [ ] **Step 2: Add the import**

Add this line in `chat-service/server.js` near the top, with the other imports:

```javascript
import { scheduleDocumentator, runDocumentator } from './lib/documentator-cron.js';
```

- [ ] **Step 3: Schedule the cron at startup**

Find the bottom of the file (where the HTTP server starts listening). Just before `server.listen(...)`, add:

```javascript
const DOCUMENTATOR_OPTS = {
  sessionsDir: LOG_DIR,
  lastRunPath: '/app/docs/learnings/runs/last-run.txt',
  runsDir: '/app/docs/learnings/runs',
  agentMdPath: `${CLAUDE_HOME}/.claude/agents/documentator.md`,
  claudeHome: CLAUDE_HOME,
  cwd: CWD,
};
scheduleDocumentator(DOCUMENTATOR_OPTS);
```

- [ ] **Step 4: Add the manual endpoint**

Locate where other routes are handled (search for `app.post` or the HTTP request dispatcher). Add the route. If the file uses a manual switch on `req.url`, add a branch:

```javascript
if (req.method === 'POST' && req.url === '/api/documentator/run') {
  runDocumentator(DOCUMENTATOR_OPTS)
    .then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    })
    .catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  return;
}
```

If `server.js` uses a different routing pattern (e.g. an Express-like helper), follow that pattern instead. Adjust accordingly — the endpoint must call `runDocumentator(DOCUMENTATOR_OPTS)` and return its JSON result.

- [ ] **Step 5: Restart chat-service locally and verify cron is registered**

If a chat-service is running, restart it (Ctrl-C and `npm start`, or recreate the container).

Confirm in logs:
```
[documentator] cron registered at 0 3 * * *
```

(Note: the current code does not print this — that's optional. Acceptance criterion is just "no startup error".)

- [ ] **Step 6: Commit**

```bash
git add chat-service/server.js
git commit -m "feat(chat-service): wire documentator cron and manual run endpoint"
```

---

## Task 7: Write the bash-restriction hook

**Files:**
- Create: `claudeConfig/.claude/hooks/restrict-documentator-bash.sh`

The hook reads a JSON envelope on stdin (Claude Code's PreToolUse contract). It only enforces the whitelist when `DOCUMENTATOR_RUN=1` is set in the environment of the calling process — otherwise it passes through.

- [ ] **Step 1: Write the hook script**

Create `claudeConfig/.claude/hooks/restrict-documentator-bash.sh` with:

```bash
#!/bin/bash
# PreToolUse / Bash hook. Restricts the documentator's bash usage to a strict
# read-only whitelist. Pass-through for any other agent or for non-documentator
# claude sessions (no DOCUMENTATOR_RUN env var).

set -euo pipefail

if [ "${DOCUMENTATOR_RUN:-}" != "1" ]; then
  exit 0
fi

# Read the JSON envelope from stdin and extract tool_input.command
ENVELOPE=$(cat)
COMMAND=$(printf '%s' "$ENVELOPE" | python3 -c 'import sys, json; print(json.loads(sys.stdin.read()).get("tool_input", {}).get("command", ""))')

# Whitelist of allowed prefixes (regex, anchored at start of command).
WHITELIST=(
  '^git log( |$)'
  '^git show( |$)'
  '^ls( |$)'
  '^wc -l( |$)'
)

for pattern in "${WHITELIST[@]}"; do
  if [[ "$COMMAND" =~ $pattern ]]; then
    exit 0
  fi
done

echo "Bash command blocked for documentator. Allowed commands: git log, git show, ls, wc -l. Use Read/Glob/Grep for everything else." >&2
exit 2
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x claudeConfig/.claude/hooks/restrict-documentator-bash.sh
```

- [ ] **Step 3: Smoke-test the hook locally (allowed)**

Run:
```bash
DOCUMENTATOR_RUN=1 echo '{"tool_input":{"command":"git log --oneline -5"}}' | claudeConfig/.claude/hooks/restrict-documentator-bash.sh
echo "exit=$?"
```

Expected: `exit=0` (allowed).

- [ ] **Step 4: Smoke-test the hook locally (blocked)**

Run:
```bash
DOCUMENTATOR_RUN=1 echo '{"tool_input":{"command":"rm -rf /tmp/foo"}}' | claudeConfig/.claude/hooks/restrict-documentator-bash.sh 2>&1
echo "exit=$?"
```

Expected: stderr contains the "Bash command blocked" message; `exit=2`.

- [ ] **Step 5: Smoke-test pass-through (no env var)**

Run:
```bash
echo '{"tool_input":{"command":"rm -rf /tmp/foo"}}' | claudeConfig/.claude/hooks/restrict-documentator-bash.sh
echo "exit=$?"
```

Expected: `exit=0` (pass-through, since `DOCUMENTATOR_RUN` is unset).

- [ ] **Step 6: Commit**

```bash
git add claudeConfig/.claude/hooks/restrict-documentator-bash.sh
git commit -m "feat(claude-config): add bash whitelist hook for documentator agent"
```

---

## Task 8: Register the hook in `settings.json`

**Files:**
- Modify: `claudeConfig/.claude/settings.json`

- [ ] **Step 1: Add the hook to the existing PreToolUse / Bash matcher**

Open `claudeConfig/.claude/settings.json`. Find the `hooks.PreToolUse` array, the entry with `"matcher": "Bash"`. Append a new hook entry to its `hooks` array, after `block-bash-validation.sh`:

```json
{
  "type": "command",
  "command": "/home/developer/.claude/hooks/restrict-documentator-bash.sh"
}
```

The full updated entry should look like:

```json
{
  "matcher": "Bash",
  "hooks": [
    { "type": "command", "command": "/home/developer/.claude/hooks/silent-mode-check.sh" },
    { "type": "command", "command": "/home/developer/.claude/hooks/circuit-breaker.sh" },
    { "type": "command", "command": "/home/developer/.claude/hooks/block-bash-file-write.sh" },
    { "type": "command", "command": "/home/developer/.claude/hooks/block-bash-validation.sh" },
    { "type": "command", "command": "/home/developer/.claude/hooks/restrict-documentator-bash.sh" }
  ]
}
```

(Preserve existing formatting style — multi-line if the file uses it.)

- [ ] **Step 2: Verify JSON validity**

Run:
```bash
python3 -c "import json; json.load(open('claudeConfig/.claude/settings.json'))" && echo "JSON OK"
```

Expected output: `JSON OK`.

- [ ] **Step 3: Commit**

```bash
git add claudeConfig/.claude/settings.json
git commit -m "feat(claude-config): register restrict-documentator-bash PreToolUse hook"
```

---

## Task 9: Write the documentator agent prompt

**Files:**
- Create: `claudeConfig/.claude/agents/documentator.md`

This is the agent's identity, instructions, and operational rules. Phase 1: read-only, output is `docs/learnings/patterns.md` only.

- [ ] **Step 1: Write the agent file**

Create `claudeConfig/.claude/agents/documentator.md` with:

```markdown
---
name: documentator
description: Read-only synthesizer. Detects recurring friction patterns across reflections, hooks, sessions and stats. Maintains the patterns ledger. Never modifies agent prompts or shipped config in phase 1.
model: sonnet
tools: [Read, Write, Edit, Glob, Grep, Bash]
skills: []
---

# Documentator

You observe the agent team's activity and detect recurring friction patterns. Your only output in this phase is the ledger at `/app/docs/learnings/patterns.md`. You do not modify any other file under `/app/` and you never write under `/home/developer/.claude/`.

## Sources you read

| Source | Path |
|---|---|
| Reflections (developer's narrative) | `/app/docs/reflections/*.md` |
| Hook logs (objective failures) | `/chat-service/logs/hooks.log` |
| Session logs (retries, friction) | `/chat-service/logs/<session-id>/log.jsonl` |
| Existing ledger | `/app/docs/learnings/patterns.md` |

For session logs, use Glob to enumerate session subdirectories, then Read with offset/limit on `log.jsonl` if needed (these files can be large — read targeted ranges, do not slurp the whole file).

## Your run, step by step

1. Read `/app/docs/learnings/patterns.md` so you know which patterns already exist and their counters.
2. Glob `/app/docs/reflections/*.md`, read those modified since the last run (use `ls -la` to check mtimes if needed — `ls` is in your bash whitelist).
3. Read `/chat-service/logs/hooks.log` (tail only — use Read with `offset` to skip to the recent portion).
4. For each session subdir under `/chat-service/logs/`, read `log.jsonl` in chunks if its mtime is newer than your last run.
5. Extract events. An event is a tuple `{ source, signature, timestamp, evidence-ref }`. Examples of signatures: `e2e-fail-after-migration`, `developer-retry-on-typecheck`, `user-reformulation-auth`, `hook-blocked-prettier`.
6. For each event:
   - If its signature matches an existing pattern in the ledger, **edit that pattern's entry**: increment `Occurrences`, update `Dernier vu`, append the evidence reference.
   - If a pattern's signature does not match but the proposed action would touch a file already in another pattern's `Files Touched`, **amend the existing pattern** (treat as a variant), do not create a duplicate.
   - Otherwise, **create a new pattern entry** with the format below.
7. Write a short summary to stdout (the cron wrapper captures this in the audit file).

## Pattern entry format

Use this format verbatim. Always preserve the file header and any existing entries above the one you are editing.

```markdown
## P-NNN — <short title>

- **Status** : observed
- **Occurrences** : <int>
- **Premier vu** : YYYY-MM-DD (TASK-XXX or session-id)
- **Dernier vu** : YYYY-MM-DD (TASK-XXX or session-id)
- **Evidence** : TASK-031, TASK-044, ... (or session IDs for non-ticket signals)
- **Symptôme** : one-sentence description of what the user / agent observes.
- **Hypothèse** : one-sentence guess at the cause.

### Action proposée (non appliquée en phase 1)

- **Type** : skill-extension | new-hook | new-rule | new-skill | modify-existing | agent-prompt-edit | escalation
- **Files Touched** :
  - `path/to/file.ext` (created)
  - `path/to/other.ext` (modified — section X)
- **Depends on** : (P-XXX, …) or (aucun)
- **Trigger** (for hooks): PreToolUse / Bash, PostToolUse / Edit, etc.
- **Settings.json patch** (for hooks): the literal JSON snippet to add.
- **Contenu** : the literal full content of the file to create, or a unified diff against the file to modify.

### Promotion criteria pour phase 2

- Occurrences ≥ 10
- Type d'action autorisé pour auto-apply
- Dependencies resolved
```

For the **escalation** form, replace the `Action proposée` body with:

```
- **Type** : escalation
- **Why no additive lever** : <short explanation>
```

## Allocation rules

- ID format: `P-NNN`, zero-padded to 3 digits, monotonically increasing. Look at the highest existing ID in the file and add 1.
- Pattern signatures are stable identifiers you invent based on the event's nature. Reuse existing signatures faithfully — drift causes duplicate patterns.
- A pattern entry is **atomic to an action**: every file in `Files Touched` is owned by this entry. If a future event would touch one of those files, amend this entry rather than create a sibling.
- The hierarchy of action types from least invasive to most invasive: `skill-extension < new-hook < new-rule < new-skill < modify-existing < agent-prompt-edit`. Pick the cheapest lever that captures the pattern. Use `escalation` when none fits.

## Hard constraints (phase 1)

- You **never** write outside `/app/docs/learnings/patterns.md`. Not under `/home/developer/.claude/`, not in `/app/src/`, not anywhere else.
- You **never** apply your proposed actions. The `Action proposée` block is descriptive, not executable.
- You **never** modify or delete an existing entry except to (a) increment its counter, (b) update `Dernier vu`, (c) append evidence, (d) refine the `Action proposée` content if a new event makes the proposal more precise. Never lower a counter, never remove evidence.
- If you are uncertain about a signature, prefer creating a new pattern over forcing a stretch into an existing one. Duplicates are easier to merge than a wrong increment is to undo.

## Bash usage

Your Bash tool is restricted by a hook to: `git log`, `git show`, `ls`, `wc -l`. Anything else is blocked. Use Read/Glob/Grep for everything else.

## Output

When you finish, print a short summary to stdout (one line per pattern touched) so it's captured in the audit log. Example:

```
Touched: P-007 (Occurrences 7→8), P-012 (Occurrences 3→4), created P-018.
```
```

- [ ] **Step 2: Verify the file is readable as a markdown agent**

Run:
```bash
head -10 claudeConfig/.claude/agents/documentator.md
```

Expected: shows the frontmatter starting with `---` and ending with `---`, then a blank line, then `# Documentator`.

- [ ] **Step 3: Verify your prompt-loader can parse it**

Run:
```bash
cd chat-service && node -e "
import('./lib/documentator-cron.js').then(async (m) => {
  const r = await m.loadDocumentatorPrompt('../claudeConfig/.claude/agents/documentator.md');
  console.log('model:', r.model);
  console.log('content length:', r.content.length);
  console.log('first 60 chars:', r.content.slice(0, 60));
});
"
```

Expected output:
```
model: sonnet
content length: <some integer > 1000>
first 60 chars: # Documentator

You observe the agent team's activity ...
```

- [ ] **Step 4: Commit**

```bash
git add claudeConfig/.claude/agents/documentator.md
git commit -m "feat(claude-config): add documentator agent prompt"
```

---

## Task 10: End-to-end smoke test

**Files:** none (verification only)

This task validates the full chain: cron registers, manual endpoint triggers, documentator spawns, ledger gets edited or left alone, audit log gets written, hook restrictions fire.

- [ ] **Step 1: Build and start the container in demo mode**

Run from the repo root:
```bash
docker build -t atomic-crm-dev .
docker compose --profile demo up -d
```

Wait until `crm-frontend`, `ttyd`, and `chat-service` all show `RUNNING` in supervisord (you can `docker exec atomic-crm-dev supervisorctl status` to check).

- [ ] **Step 2: Generate at least one session log so the activity check has something to find**

Open `http://localhost:8080`, send any message to the chat (e.g. "Hello"). Wait for the orchestrator to respond. This creates `/chat-service/logs/<uuid>/log.jsonl`.

- [ ] **Step 3: Trigger documentator manually**

Run:
```bash
curl -X POST http://localhost:8080/api/documentator/run
```

Expected response: a JSON object like `{"skipped": false, "exitCode": 0, "auditPath": "/app/docs/learnings/runs/2026-04-27-run.md"}`.

If `skipped: true`, then no session log was newer than `last-run.txt`. Touch a session log to force activity:
```bash
docker exec atomic-crm-dev sh -c 'touch /chat-service/logs/*/log.jsonl 2>/dev/null'
```
And re-run the curl.

- [ ] **Step 4: Inspect the audit log**

Run:
```bash
docker exec atomic-crm-dev cat /app/docs/learnings/runs/$(date +%Y-%m-%d)-run.md | head -40
```

Expected: a markdown header with the timestamp + the streamed claude output (mostly stream-json events, ending with a summary line).

- [ ] **Step 5: Inspect the ledger**

Run:
```bash
docker exec atomic-crm-dev cat /app/docs/learnings/patterns.md
```

Expected: the file header is preserved. Below the marker comment, either:
- new pattern entries with `## P-001 — …` (if documentator found patterns), or
- the file is unchanged (if there was nothing to detect).

Either is acceptable for a first run with sparse data.

- [ ] **Step 6: Verify the bash-restriction hook fires**

In the terminal where the container is running, watch the chat-service logs:
```bash
docker compose logs -f chat-service
```

In another terminal, hand-craft a test by running:
```bash
docker exec -e DOCUMENTATOR_RUN=1 atomic-crm-dev sh -c 'echo "{\"tool_input\":{\"command\":\"rm -rf /tmp/x\"}}" | /home/developer/.claude/hooks/restrict-documentator-bash.sh; echo exit=$?'
```

Expected: stderr message "Bash command blocked …", and `exit=2`.

- [ ] **Step 7: Final commit if any tweaks were made**

If you had to adjust any code/file during the smoke test (e.g., a path constant, a missing dependency), commit those tweaks with a descriptive message and re-run the relevant unit tests.

If everything worked first try, the smoke test produces no commits.

- [ ] **Step 8: Tag the working commit**

```bash
git tag documentator-phase1-smoked
git log --oneline -10
```

This makes it easy to identify the baseline before starting phase 2 design work.

---

## Self-review checklist (run before considering this plan done)

After implementing all 10 tasks, verify:

1. **Spec coverage** — match against `docs/superpowers/specs/2026-04-27-documentator-design.md`:
   - [x] 5 sources read by documentator (Task 9 prompt enumerates them)
   - [x] `patterns.md` ledger format with required fields, including `Files Touched` and `Depends on` (Task 9 prompt + Task 1 seed)
   - [x] node-cron daily trigger + manual endpoint (Tasks 5–6)
   - [x] Skip when no activity (Task 3)
   - [x] Audit log per run (Task 5)
   - [x] Bash restriction via hook (Tasks 7–8)
   - [x] Agent definition with sonnet model + restricted tool list (Task 9)
   - [x] No mutation of `claudeConfig/.claude/` from documentator (enforced by prompt + hook)

2. **No placeholders** — every code block above is concrete, no TBD/TODO.

3. **Type/path consistency**:
   - `lastRunPath`, `runsDir`, `sessionsDir` paths used identically across cron, runDocumentator, and the schedule wiring.
   - `DOCUMENTATOR_RUN` env var name spelled the same in the hook and in the spawn env.
   - `agentMdPath` matches the one Task 9 creates.

4. **Tests pass** — `cd chat-service && node --test 'test/**/*.test.js'` returns 5+ tests, all passing.

5. **Smoke test passes** — Task 10 produces an audit file and either an updated or unchanged ledger.

If any item fails, fix inline before declaring the plan complete.
