# Bench Result Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4th dimension (result) to the bench harness — a soft file-set/diff-size signal (A) and a bloquant Playwright behavioral check (C) — so we can measure whether the IA actually delivered what was asked, not just how much it cost.

**Architecture:** Extend `chat-service/tests/run.js` to capture `git diff` from `/app` after each case (via `docker exec`), evaluate it against new `mustModify` / `mustNotModify` / `expectedDiffStats` keys in cases.json (soft warnings), and run a per-case Playwright check from `tests/checks/<id>.js` (bloquant, default-exports `async (page) => {…}`, launched with `chromium` directly — no Playwright Test runner). Full diffs archived to `tests/results/<runTs>/<caseId>.patch` for human inspection.

**Tech Stack:** Node 22 (ESM), `playwright` (new dev dep, bare lib not @playwright/test), existing `ws`, `node:test` for unit tests.

**Spec:** [docs/superpowers/specs/2026-04-28-bench-result-validation-design.md](../specs/2026-04-28-bench-result-validation-design.md)

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `chat-service/package.json` | modify | add `playwright` devDep |
| `chat-service/tests/run.js` | modify | wire diff capture, A eval, C runner, patch archive into `runCase` and reporting |
| `chat-service/tests/lib/diff-capture.js` | create | `captureDiff(container)` returning `{ files, numstat, patch }` |
| `chat-service/tests/lib/evaluate-files.js` | create | `evaluateFileSet(diff, expect)` returning `{ warnings: string[] }` + inline glob matcher |
| `chat-service/tests/lib/run-check.js` | create | `runPlaywrightCheck(caseId, baseDir)` returning `{ ran, success, error? }` |
| `chat-service/tests/checks/<id>.js` | create | per-case Playwright check, default-exports `async (page) => {…}` |
| `chat-service/tests/cases.json` | modify | add `mustModify`, `mustNotModify`, `expectedDiffStats` to existing cases |
| `chat-service/test/bench-diff-capture.test.js` | create | unit tests, runner injected |
| `chat-service/test/bench-evaluate-files.test.js` | create | unit tests for A signal |
| `chat-service/test/bench-run-check.test.js` | create | unit tests for C runner with fixture checks |
| `chat-service/test/fixtures/checks/passing.js` | create | fixture: throws nothing |
| `chat-service/test/fixtures/checks/failing.js` | create | fixture: throws Error |

The lib helpers stay small (each ~50-100 LOC) and testable in isolation. `run.js` keeps its top-level orchestration role and grows by ~60 lines of glue.

---

## Task 1: Add `playwright` dependency

**Files:**
- Modify: `chat-service/package.json`

- [ ] **Step 1: Add devDependencies block**

In [chat-service/package.json](../../../chat-service/package.json), add a `devDependencies` block after `dependencies`:

```json
  "dependencies": {
    "node-cron": "^3.0.3",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "playwright": "^1.49.0"
  }
```

- [ ] **Step 2: Install**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && npm install
```

Expected: lockfile updated, `node_modules/playwright` present, no errors.

- [ ] **Step 3: Verify chromium binary available**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node -e "import('playwright').then(p => p.chromium.launch().then(b => b.close()).then(() => console.log('ok')))"
```

Expected: prints `ok`. If chromium is missing, run `npx playwright install chromium`.

- [ ] **Step 4: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/package.json chat-service/package-lock.json && git commit -m "chore(bench): add playwright devDep for result-validation checks"
```

---

## Task 2: `captureDiff` helper (TDD)

**Files:**
- Create: `chat-service/tests/lib/diff-capture.js`
- Test: `chat-service/test/bench-diff-capture.test.js`

The helper runs three `docker exec ... git diff …` calls (already a pattern used by [chat-service/tests/run.js#resetCrmSource](../../../chat-service/tests/run.js)) and parses the output into a structured object. We isolate it so the bench tests can inject a stub runner.

- [ ] **Step 1: Write the failing test**

Create `chat-service/test/bench-diff-capture.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureDiff, parseNumstat } from '../tests/lib/diff-capture.js';

test('parseNumstat extracts files + line counts', () => {
  const raw = '5\t2\tsrc/foo.tsx\n12\t0\tsrc/bar.tsx\n';
  const stats = parseNumstat(raw);
  assert.deepEqual(stats, {
    filesChanged: 2,
    linesAdded: 17,
    linesRemoved: 2,
    perFile: [
      { added: 5, removed: 2, path: 'src/foo.tsx' },
      { added: 12, removed: 0, path: 'src/bar.tsx' },
    ],
  });
});

test('parseNumstat handles binary files (- - path)', () => {
  const raw = '-\t-\tsrc/logo.png\n3\t1\tsrc/foo.tsx\n';
  const stats = parseNumstat(raw);
  assert.equal(stats.filesChanged, 2);
  assert.equal(stats.linesAdded, 3);
  assert.equal(stats.linesRemoved, 1);
});

test('parseNumstat returns zeros for empty input', () => {
  assert.deepEqual(parseNumstat(''), {
    filesChanged: 0, linesAdded: 0, linesRemoved: 0, perFile: [],
  });
});

test('captureDiff calls runner for numstat, name-only, full patch', () => {
  const calls = [];
  const fakeRunner = (cmd) => {
    calls.push(cmd);
    if (cmd.includes('--numstat')) return '5\t2\tsrc/foo.tsx\n';
    if (cmd.includes('--name-only')) return 'src/foo.tsx\n';
    return 'diff --git a/src/foo.tsx b/src/foo.tsx\n@@ ...\n';
  };
  const diff = captureDiff('atomic-crm-demo', { runner: fakeRunner });
  assert.equal(calls.length, 3);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0], 'src/foo.tsx');
  assert.equal(diff.numstat.filesChanged, 1);
  assert.match(diff.patch, /^diff --git/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node --test test/bench-diff-capture.test.js
```

Expected: FAIL — `Cannot find module '../tests/lib/diff-capture.js'`.

- [ ] **Step 3: Implement the helper**

Create `chat-service/tests/lib/diff-capture.js`:

```js
import { execSync } from 'node:child_process';

const defaultRunner = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function parseNumstat(raw) {
  const perFile = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split('\t');
    const path = rest.join('\t');
    const added = a === '-' ? 0 : parseInt(a, 10) || 0;
    const removed = r === '-' ? 0 : parseInt(r, 10) || 0;
    perFile.push({ added, removed, path });
    linesAdded += added;
    linesRemoved += removed;
  }
  return { filesChanged: perFile.length, linesAdded, linesRemoved, perFile };
}

export function captureDiff(containerName, { runner = defaultRunner } = {}) {
  const wrap = (gitArgs) =>
    `docker exec ${containerName} sh -c "cd /app && git diff ${gitArgs} src/"`;
  const numstatRaw = runner(wrap('--numstat'));
  const namesRaw = runner(wrap('--name-only'));
  const patch = runner(wrap(''));
  return {
    numstat: parseNumstat(numstatRaw),
    files: namesRaw.split('\n').filter(Boolean),
    patch,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node --test test/bench-diff-capture.test.js
```

Expected: 4/4 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/tests/lib/diff-capture.js chat-service/test/bench-diff-capture.test.js && git commit -m "feat(bench): captureDiff helper for /app git diff after a case"
```

---

## Task 3: `evaluateFileSet` (A signal, TDD)

**Files:**
- Create: `chat-service/tests/lib/evaluate-files.js`
- Test: `chat-service/test/bench-evaluate-files.test.js`

Returns soft warnings only — never throws, never sets a fail flag.

- [ ] **Step 1: Write the failing test**

Create `chat-service/test/bench-evaluate-files.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFileSet, matchesGlob } from '../tests/lib/evaluate-files.js';

test('matchesGlob supports literal, **, and *.ext', () => {
  assert.equal(matchesGlob('src/foo.tsx', 'src/foo.tsx'), true);
  assert.equal(matchesGlob('src/foo.tsx', 'src/bar.tsx'), false);
  assert.equal(matchesGlob('src/atomic-crm/contacts/Foo.tsx', 'src/atomic-crm/contacts/**'), true);
  assert.equal(matchesGlob('src/atomic-crm/deals/Foo.tsx', 'src/atomic-crm/contacts/**'), false);
  assert.equal(matchesGlob('src/foo.tsx', '**/*.tsx'), true);
  assert.equal(matchesGlob('src/foo.css', '**/*.tsx'), false);
});

test('mustModify warns on missing expected file', () => {
  const diff = { files: ['src/foo.tsx'], numstat: { filesChanged: 1, linesAdded: 5, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(diff, { mustModify: ['src/foo.tsx', 'src/bar.tsx'] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /src\/bar\.tsx/);
});

test('mustModify silent when all expected files touched', () => {
  const diff = { files: ['src/foo.tsx', 'src/bar.tsx'], numstat: { filesChanged: 2, linesAdded: 5, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(diff, { mustModify: ['src/foo.tsx'] });
  assert.deepEqual(warnings, []);
});

test('mustNotModify warns per matched file', () => {
  const diff = { files: ['src/atomic-crm/contacts/Foo.tsx', 'src/foo.tsx'], numstat: { filesChanged: 2, linesAdded: 0, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(diff, { mustNotModify: ['src/atomic-crm/contacts/**'] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /contacts\/Foo\.tsx/);
});

test('expectedDiffStats accepts within ±100% (half to double)', () => {
  const within = { files: [], numstat: { filesChanged: 1, linesAdded: 10, linesRemoved: 2 } };
  const { warnings } = evaluateFileSet(within, {
    expectedDiffStats: { filesChanged: 1, linesAdded: 8, linesRemoved: 2 },
  });
  assert.deepEqual(warnings, []);
});

test('expectedDiffStats warns when linesAdded > 2× expected', () => {
  const explosion = { files: [], numstat: { filesChanged: 1, linesAdded: 50, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(explosion, {
    expectedDiffStats: { filesChanged: 1, linesAdded: 8, linesRemoved: 0 },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /linesAdded/);
});

test('absent expect keys produce no warnings', () => {
  const diff = { files: ['src/foo.tsx'], numstat: { filesChanged: 1, linesAdded: 5, linesRemoved: 0 } };
  const { warnings } = evaluateFileSet(diff, {});
  assert.deepEqual(warnings, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node --test test/bench-evaluate-files.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `chat-service/tests/lib/evaluate-files.js`:

```js
export function matchesGlob(path, pattern) {
  const re = new RegExp(
    '^' +
      pattern
        .split('**')
        .map((part) =>
          part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
        )
        .join('.*') +
      '$'
  );
  return re.test(path);
}

function withinTolerance(actual, expected, factor = 2) {
  if (expected === 0) return actual === 0;
  return actual >= expected / factor && actual <= expected * factor;
}

export function evaluateFileSet(diff, expect) {
  const warnings = [];
  const touched = new Set(diff.files || []);

  if (expect.mustModify) {
    for (const path of expect.mustModify) {
      if (!touched.has(path)) {
        warnings.push(`A: expected modification missing — ${path}`);
      }
    }
  }

  if (expect.mustNotModify) {
    for (const path of touched) {
      for (const pattern of expect.mustNotModify) {
        if (matchesGlob(path, pattern)) {
          warnings.push(`A: forbidden file modified — ${path} (matches ${pattern})`);
        }
      }
    }
  }

  if (expect.expectedDiffStats) {
    const e = expect.expectedDiffStats;
    const a = diff.numstat || { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
    for (const key of ['filesChanged', 'linesAdded', 'linesRemoved']) {
      if (e[key] != null && !withinTolerance(a[key], e[key])) {
        warnings.push(`A: ${key} ${a[key]} outside tolerance of expected ${e[key]} (±100%)`);
      }
    }
  }

  return { warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node --test test/bench-evaluate-files.test.js
```

Expected: 7/7 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/tests/lib/evaluate-files.js chat-service/test/bench-evaluate-files.test.js && git commit -m "feat(bench): evaluateFileSet — soft A signal (mustModify, mustNotModify, expectedDiffStats)"
```

---

## Task 4: `runPlaywrightCheck` (C runner, TDD)

**Files:**
- Create: `chat-service/tests/lib/run-check.js`
- Test: `chat-service/test/bench-run-check.test.js`
- Fixtures: `chat-service/test/fixtures/checks/passing.js`, `chat-service/test/fixtures/checks/failing.js`

Tests run against fixture checks that don't actually need a browser — they receive a fake `page` and pass/throw. The real chromium-launch path is exercised end-to-end in Task 9.

- [ ] **Step 1: Create fixtures**

Create `chat-service/test/fixtures/checks/passing.js`:

```js
export default async function check(page) {
  if (typeof page.goto !== 'function') throw new Error('no page.goto');
}
```

Create `chat-service/test/fixtures/checks/failing.js`:

```js
export default async function check(_page) {
  throw new Error('expected failure for test');
}
```

- [ ] **Step 2: Write the failing test**

Create `chat-service/test/bench-run-check.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runPlaywrightCheck } from '../tests/lib/run-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'checks');

const fakePage = { goto: () => {}, getByText: () => ({ waitFor: async () => {} }) };
const fakeBrowser = {
  async launch() {
    return {
      async newContext() {
        return { async newPage() { return fakePage; } };
      },
      async close() {},
    };
  },
};

test('runPlaywrightCheck returns ran:false when no file exists', async () => {
  const r = await runPlaywrightCheck('does-not-exist', { checksDir: FIXTURES, browser: fakeBrowser });
  assert.equal(r.ran, false);
});

test('runPlaywrightCheck returns success:true when check resolves', async () => {
  const r = await runPlaywrightCheck('passing', { checksDir: FIXTURES, browser: fakeBrowser });
  assert.equal(r.ran, true);
  assert.equal(r.success, true);
});

test('runPlaywrightCheck returns success:false with error when check throws', async () => {
  const r = await runPlaywrightCheck('failing', { checksDir: FIXTURES, browser: fakeBrowser });
  assert.equal(r.ran, true);
  assert.equal(r.success, false);
  assert.match(r.error, /expected failure for test/);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node --test test/bench-run-check.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `chat-service/tests/lib/run-check.js`:

```js
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function runPlaywrightCheck(caseId, { checksDir, browser } = {}) {
  if (!checksDir) throw new Error('checksDir is required');
  if (!browser) {
    const pw = await import('playwright');
    browser = pw.chromium;
  }
  const checkPath = join(checksDir, `${caseId}.js`);
  if (!existsSync(checkPath)) return { ran: false };

  const mod = await import(pathToFileURL(checkPath).href);
  const check = mod.default;
  if (typeof check !== 'function') {
    return { ran: true, success: false, error: `${caseId}.js: missing default export function` };
  }

  const launched = await browser.launch();
  try {
    const ctx = await launched.newContext();
    const page = await ctx.newPage();
    await check(page);
    return { ran: true, success: true };
  } catch (err) {
    return { ran: true, success: false, error: err.message };
  } finally {
    await launched.close();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node --test test/bench-run-check.test.js
```

Expected: 3/3 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/tests/lib/run-check.js chat-service/test/bench-run-check.test.js chat-service/test/fixtures/checks/ && git commit -m "feat(bench): runPlaywrightCheck — bloquant C signal driven by tests/checks/<id>.js"
```

---

## Task 5: Wire helpers into `run.js`

**Files:**
- Modify: `chat-service/tests/run.js`

Add diff capture after the WS turn settles, A evaluation, C runner (skipped if `--from-session`), patch archive, and surfaced output.

- [ ] **Step 1: Add imports**

In [chat-service/tests/run.js](../../../chat-service/tests/run.js), add after the existing imports (around line 14):

```js
import { captureDiff } from './lib/diff-capture.js';
import { evaluateFileSet } from './lib/evaluate-files.js';
import { runPlaywrightCheck } from './lib/run-check.js';
```

Add a constant near the top:

```js
const CHECKS_DIR = join(__dirname, 'checks');
const CONTAINER = process.env.BENCH_CONTAINER || 'atomic-crm-demo';
```

- [ ] **Step 2: Replace `runCase` to integrate the new signals**

Modify `runCase` (currently around line 138-200) so that after `metrics.durationMs = Date.now() - start;` and *before* `ws.close()`, we capture the diff, run A and C, archive the patch. Replace the trailing block:

```js
  metrics.durationMs = Date.now() - start;
  ws.close();

  validateExpectations(metrics, caseDef.expect || {});
  return metrics;
}
```

with:

```js
  metrics.durationMs = Date.now() - start;
  ws.close();

  metrics.warnings = [];
  metrics.result = { ran: false };

  let diff = null;
  try {
    diff = captureDiff(CONTAINER);
    metrics.diffStats = diff.numstat;
    metrics.modifiedFiles = diff.files;
  } catch (err) {
    metrics.warnings.push(`A: capture failed — ${err.message}`);
  }

  if (diff) {
    const { warnings } = evaluateFileSet(diff, caseDef.expect || {});
    metrics.warnings.push(...warnings);
  }

  try {
    metrics.result = await runPlaywrightCheck(caseDef.id, { checksDir: CHECKS_DIR });
    if (metrics.result.ran && !metrics.result.success) {
      metrics.success = false;
      metrics.errors.push(`C (Playwright): ${metrics.result.error}`);
    }
  } catch (err) {
    metrics.success = false;
    metrics.errors.push(`C (Playwright runner): ${err.message}`);
  }

  if (diff) metrics.patch = diff.patch;

  validateExpectations(metrics, caseDef.expect || {});
  return metrics;
}
```

- [ ] **Step 3: Skip A and C in `runCaseFromSession`**

In `runCaseFromSession` (around line 100-136), add the same default fields so downstream code doesn't NPE:

```js
  const metrics = {
    caseId: caseDef.id,
    category: caseDef.category,
    mode: caseDef.mode,
    durationMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    agents: [],
    tools: [],
    success: true,
    errors: [],
    warnings: [],
    result: { ran: false },
    sessionId,
  };
```

(Add `warnings: []` and `result: { ran: false }`. No actual capture — A/C require a live CRM.)

- [ ] **Step 4: Surface warnings + result in inline output**

Find the existing inline output block in `main()` (around line 274):

```js
      console.log(`${status} (${(m.durationMs / 1000).toFixed(1)}s, $${m.costUsd.toFixed(3)}, ${formatTokens(m.tokensIn)} in, agents: ${m.agents.join(',') || '-'})`);
      if (!m.success) m.errors.forEach((e) => console.log(`      - ${e}`));
```

Replace with:

```js
      console.log(`${status} (${(m.durationMs / 1000).toFixed(1)}s, $${m.costUsd.toFixed(3)}, ${formatTokens(m.tokensIn)} in, agents: ${m.agents.join(',') || '-'})`);
      const resultLabel = m.result?.ran
        ? (m.result.success ? '\x1b[32mOK\x1b[0m (Playwright)' : `\x1b[31mFAIL\x1b[0m — ${m.result.error}`)
        : '–';
      console.log(`      result: ${resultLabel}`);
      if (!m.success) m.errors.forEach((e) => console.log(`      - ${e}`));
      if (m.warnings?.length) m.warnings.forEach((w) => console.log(`      \x1b[33mWARN\x1b[0m ${w}`));
```

- [ ] **Step 5: Run smoke test**

The `runCase` path requires a live chat-service. For now, verify the file parses:

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node --check tests/run.js
```

Expected: no output, exit 0.

Also run the existing unit tests to make sure nothing broke:

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && npm test
```

Expected: all tests pass (including the 3 new bench-* test files from Tasks 2-4).

- [ ] **Step 6: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/tests/run.js && git commit -m "feat(bench): wire diff capture, A signal, and Playwright check into runCase"
```

---

## Task 6: Patch archive

**Files:**
- Modify: `chat-service/tests/run.js`

Write each case's full diff to `tests/results/<runTs>/<caseId>.patch`.

- [ ] **Step 1: Add patch-write logic in `main`**

In `main()`, after `await mkdir(RESULTS_DIR, { recursive: true });` and the `runPath` write (~line 286), add:

```js
  const patchDir = join(RESULTS_DIR, run.ts.replace(/[:.]/g, '-'));
  await mkdir(patchDir, { recursive: true });
  for (const c of results) {
    if (c.patch) {
      await writeFile(join(patchDir, `${c.caseId}.patch`), c.patch);
      delete c.patch;
    }
  }
```

(`delete c.patch` keeps the run.json small — patches live in their own files.)

- [ ] **Step 2: Verify the JSON shape doesn't include `patch`**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node --check tests/run.js
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/tests/run.js && git commit -m "feat(bench): archive per-case full diff to results/<runTs>/<id>.patch"
```

---

## Task 7: Show result column in baseline comparison

**Files:**
- Modify: `chat-service/tests/run.js`

Add a 4th column to `compareWithBaseline`.

- [ ] **Step 1: Update `compareWithBaseline`**

Find the function (around line 218). Replace:

```js
  const header = 'Case'.padEnd(28) + 'Duration'.padEnd(18) + 'Cost'.padEnd(18) + 'Tokens in'.padEnd(18);
```

with:

```js
  const header = 'Case'.padEnd(28) + 'Duration'.padEnd(18) + 'Cost'.padEnd(18) + 'Tokens in'.padEnd(18) + 'Result'.padEnd(10);
```

In the per-case loop, after the `tks` line, replace:

```js
    console.log(`${name}  ${dur.padEnd(26)}${cost.padEnd(26)}${tks}`);
```

with:

```js
    const resultCol = current.result?.ran
      ? (current.result.success ? 'OK' : 'FAIL')
      : '–';
    console.log(`${name}  ${dur.padEnd(26)}${cost.padEnd(26)}${tks.padEnd(26)}${resultCol}`);
```

- [ ] **Step 2: Verify parses**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node --check tests/run.js
```

Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/tests/run.js && git commit -m "feat(bench): add Result column to baseline comparison table"
```

---

## Task 8: Update `cases.json` with A expectations

**Files:**
- Modify: `chat-service/tests/cases.json`

Add `mustModify`, `mustNotModify`, and `expectedDiffStats` where they're knowable. (`edge-ambiguous` should not modify code at all — captured via existing `mustNotInvoke: [developer, planner]`, no need to add A there.)

- [ ] **Step 1: Verify the actual file paths used by Atomic CRM**

Inspect the real source tree to pick correct paths:

```bash
docker exec atomic-crm-demo sh -c "find /app/src -type f -name '*.tsx' | grep -i 'dashboard\|deal'" 2>/dev/null | head -20
```

Expected: a list of paths to confirm the values in this file. Adjust if the project layout differs.

- [ ] **Step 2: Update each case**

Replace [chat-service/tests/cases.json](../../../chat-service/tests/cases.json) content:

```json
[
  {
    "id": "simple-label-english",
    "category": "simple",
    "mode": "quick_edit",
    "prompt": "change the 'Hot Contacts' label on the dashboard to 'My Friends'",
    "expect": {
      "mustNotInvoke": ["planner"],
      "maxDurationMs": 150000,
      "maxCostUsd": 0.60,
      "mustModify": ["src/atomic-crm/dashboard/HotContacts.tsx"],
      "mustNotModify": ["src/atomic-crm/contacts/**", "src/atomic-crm/deals/**"],
      "expectedDiffStats": { "filesChanged": 1, "linesAdded": 1, "linesRemoved": 1 }
    }
  },
  {
    "id": "simple-color-primary",
    "category": "simple",
    "mode": "quick_edit",
    "prompt": "change the primary color of the CRM to purple",
    "expect": {
      "mustNotInvoke": ["planner"],
      "maxDurationMs": 180000,
      "maxCostUsd": 0.80,
      "mustModify": ["src/index.css"],
      "expectedDiffStats": { "filesChanged": 1, "linesAdded": 2, "linesRemoved": 2 }
    }
  },
  {
    "id": "simple-hide-element",
    "category": "simple",
    "mode": "quick_edit",
    "prompt": "hide the Refresh button in the CRM header",
    "expect": {
      "mustNotInvoke": ["planner"],
      "maxDurationMs": 180000,
      "maxCostUsd": 0.80,
      "mustModify": ["src/atomic-crm/layout/Header.tsx"],
      "expectedDiffStats": { "filesChanged": 1, "linesAdded": 0, "linesRemoved": 4 }
    }
  },
  {
    "id": "medium-new-field",
    "category": "medium",
    "mode": "quick_edit",
    "prompt": "add a 'priority' field (low/medium/high) to the deals entity, shown in the edit form and the deal card",
    "expect": {
      "mustInvoke": ["planner", "developer"],
      "maxDurationMs": 2700000,
      "maxCostUsd": 6.00,
      "mustModify": [
        "src/atomic-crm/deals/DealEdit.tsx",
        "src/atomic-crm/deals/DealCard.tsx"
      ],
      "expectedDiffStats": { "filesChanged": 4, "linesAdded": 30, "linesRemoved": 0 }
    }
  },
  {
    "id": "edge-ambiguous",
    "category": "edge",
    "mode": "quick_edit",
    "prompt": "make it better",
    "expect": {
      "mustNotInvoke": ["developer", "planner"],
      "maxDurationMs": 60000,
      "maxCostUsd": 0.30
    }
  }
]
```

> **Note:** the file paths above are best-effort — confirm with Step 1's output. If `HotContacts.tsx` doesn't exist at that path, adjust to the real location. The `expectedDiffStats` are rough estimates with ±100% tolerance, so they don't need to be exact.

- [ ] **Step 3: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/tests/cases.json && git commit -m "feat(bench): add mustModify, mustNotModify, expectedDiffStats to cases"
```

---

## Task 9: Write Playwright checks for the 3 simple cases

**Files:**
- Create: `chat-service/tests/checks/simple-label-english.js`
- Create: `chat-service/tests/checks/simple-color-primary.js`
- Create: `chat-service/tests/checks/simple-hide-element.js`

The medium and edge cases get no check yet — medium is too freeform (UI shape can vary), edge expects no change so the existing `mustNotInvoke` is enough.

- [ ] **Step 1: Write `simple-label-english.js`**

Create `chat-service/tests/checks/simple-label-english.js`:

```js
export default async function check(page) {
  await page.goto('http://localhost:5173/');
  await page.getByText('My Friends').waitFor({ state: 'visible', timeout: 15000 });
  const oldLabel = await page.getByText('Hot Contacts').count();
  if (oldLabel > 0) throw new Error('old "Hot Contacts" label still visible');
}
```

- [ ] **Step 2: Write `simple-color-primary.js`**

Create `chat-service/tests/checks/simple-color-primary.js`:

```js
export default async function check(page) {
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle');
  const isPurple = await page.evaluate(() => {
    const el = document.querySelector('button, [class*="primary"], [class*="MuiButton-contained"]');
    if (!el) return false;
    const c = getComputedStyle(el).backgroundColor;
    const m = c.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return false;
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    return b > r * 0.8 && r > g + 30;
  });
  if (!isPurple) throw new Error('primary color does not look purple');
}
```

- [ ] **Step 3: Write `simple-hide-element.js`**

Create `chat-service/tests/checks/simple-hide-element.js`:

```js
export default async function check(page) {
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle');
  const refresh = await page.locator('button[aria-label*="refresh" i], button:has-text("Refresh")').count();
  if (refresh > 0) throw new Error(`refresh button still present (count=${refresh})`);
}
```

- [ ] **Step 4: Smoke-launch one check against the running CRM**

Assumes the demo container is running and `:5173` is reachable.

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node -e "
import('./tests/lib/run-check.js').then(async (m) => {
  const r = await m.runPlaywrightCheck('simple-hide-element', { checksDir: './tests/checks' });
  console.log(JSON.stringify(r, null, 2));
});
"
```

Expected: `{ ran: true, success: false, error: 'refresh button still present (count=1)' }` *before* a real bench run modifies the CRM. (The check is correctly written when it FAILS against the unmodified CRM — that's the regression-detection direction.) If it returns `ran: true, success: true` against the unmodified CRM, the locator is wrong: tighten the selector.

- [ ] **Step 5: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/tests/checks/ && git commit -m "feat(bench): playwright C-checks for the 3 simple cases"
```

---

## Task 10: End-to-end bench run + baseline refresh

**Files:**
- Modify (potentially): `chat-service/tests/results/baseline.json`

This is the integration step. Requires the demo container running at `localhost:8080` and `:5173`.

- [ ] **Step 1: Pre-flight**

```bash
docker ps --format '{{.Names}}' | grep atomic-crm-demo
curl -sf http://localhost:8080/api/stats > /dev/null && echo "chat-service ok"
curl -sf http://localhost:5173/ > /dev/null && echo "vite ok"
```

Expected: container name printed, both `ok` lines.

- [ ] **Step 2: Run a single simple case end-to-end**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node tests/run.js --case simple-label-english
```

Expected output includes:
- `OK` or `FAIL` on the case line with duration/cost
- `result: OK (Playwright)` on success, or a Playwright-attributed FAIL
- 0 or more `WARN` lines for A signals
- a `Results saved:` line ending in a fresh `run-…json`
- a sibling directory `tests/results/run-…/simple-label-english.patch` containing the actual diff

Manually verify the patch file exists and is non-empty:

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && ls -la tests/results/$(ls -1 tests/results | grep -E '^run-' | tail -1)/
```

Expected: at least `simple-label-english.patch` listed.

- [ ] **Step 3: Run all cases**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node tests/run.js
```

Expected: each case shows the new `result:` line and any WARN lines. The Comparison-vs-baseline table now has a `Result` column. Some cases may FAIL on the new C check on first run — that's the point of the signal. Investigate failures: look at `tests/results/<runTs>/<caseId>.patch` to see what the IA produced, then either tighten the check or accept the case truly failed.

- [ ] **Step 4: Refresh baseline once you're confident the runs are representative**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test/chat-service && node tests/run.js --update-baseline
```

Expected: `Baseline updated: …/baseline.json`. The new baseline now records `result.ran` / `result.success` and `warnings` / `diffStats` / `modifiedFiles` per case.

- [ ] **Step 5: Commit baseline refresh**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add chat-service/tests/results/baseline.json && git commit -m "chore(bench): refresh baseline with result + warnings + diffStats"
```

---

## Task 11: README touch-up

**Files:**
- Modify: `CLAUDE.md` (the bench-harness section)

Brief note that the bench has a 4th dimension now.

- [ ] **Step 1: Update the bench section in CLAUDE.md**

In [CLAUDE.md](../../../CLAUDE.md), find the "Bench harness" sub-section (under "Chat-service"). After the existing paragraph, add:

```markdown
The harness records 4 dimensions per case:
- **cost / time / tokens** (always-on, bloquant on `maxCostUsd` / `maxDurationMs`)
- **agent shape** (`mustInvoke` / `mustNotInvoke`, bloquant)
- **A — file set + diff size** (`mustModify` / `mustNotModify` / `expectedDiffStats`, soft warnings)
- **C — Playwright check** (`tests/checks/<id>.js`, bloquant)

Per-case full diffs are archived to `chat-service/tests/results/<runTs>/<caseId>.patch` for inspection when something fails.
```

- [ ] **Step 2: Commit**

```bash
cd /home/jerome/Work/crm-builder/.worktrees/result-comparison-test && git add CLAUDE.md && git commit -m "docs: document bench's new result dimension (A soft, C bloquant)"
```

---

## Self-review notes

- **Spec coverage:** all spec sections (A, C, archive, output sample, edge cases) have a task. `runCaseFromSession` skip behavior is in Task 5 Step 3.
- **Type consistency:** `metrics.result = { ran, success, error }` is the same shape across `runCase`, `runCaseFromSession`, output rendering, and `compareWithBaseline`. `metrics.warnings: string[]` is consistent. `diff.numstat` matches `parseNumstat` return shape.
- **Glob matcher scope:** the inline matcher in Task 3 supports `**`, `*`, and literals — sufficient for `src/atomic-crm/contacts/**`, `**/*.tsx`, and exact paths used in Task 8.
- **No placeholders:** every code step contains complete code.
- **TDD ordering:** Tasks 2-4 follow test-first; Tasks 5-7 are integration glue (verified by `node --check` + the existing unit tests passing); Task 9 has its own integration smoke-check; Task 10 is the full e2e validation.
