# Bench harness: result validation signal

**Status**: design approved 2026-04-28
**Worktree**: `.worktrees/result-comparison-test`
**Files of interest**: [run.js](../../../chat-service/tests/run.js), [cases.json](../../../chat-service/tests/cases.json)

## Context

The current bench harness ([chat-service/tests/run.js](../../../chat-service/tests/run.js)) measures **cost** (`tokensIn`, `tokensOut`, `costUsd`), **time** (`durationMs`), and **agent shape** (`mustInvoke` / `mustNotInvoke`). It does not measure whether the modification *actually worked*: a case can come in under budget, invoke the right agents, and still produce code that doesn't implement the user's prompt.

We want a fourth dimension — **result** — answering: did the right files change, and does the running app behave as expected?

A previous iteration considered LLM-as-judge (Anthropic eval-tool style). Rejected: the dev model and the judge model would near-always agree that the prompt was satisfied (judge sees the diff post-hoc, dev model controls what the diff looks like). We need signals that can disagree with the dev model.

## Goals

- Add a binary pass/fail signal anchored in **observable behavior** of the running CRM (Playwright e2e per case).
- Add a soft regression signal anchored in **what code the IA touched** (file-set + diff size budget).
- Archive each run's actual diff for human inspection when something fails.
- Keep the existing `mustInvoke` / `maxDurationMs` / `maxCostUsd` checks unchanged.

## Non-goals

- LLM-as-judge over the diff or the UI (rejected — see Context).
- Diff-of-diffs textual comparison (rejected — high false-negative rate from semantically-equivalent rewrites).
- Per-case Playwright spec runner with full Playwright Test features (`describe` / `it` / fixtures). We use the bare `playwright` library to keep the harness self-contained.

## Design

### Signal taxonomy

| Signal | Weight | Source | Existing? |
|---|---|---|---|
| `mustInvoke` / `mustNotInvoke` agents | bloquant | `debug_raw` events | yes |
| `maxDurationMs` / `maxCostUsd` | bloquant | aggregator | yes |
| **A — file-set match + size budget** | **soft (warnings, no fail)** | `git diff` in `/app` | **new** |
| **C — Playwright behavioral check** | **bloquant** | `tests/checks/<case-id>.js` | **new** |

A is intentionally soft: file-set is a coarse signal that produces noise on legitimate alternative implementations. C is the source of truth because it checks the user-observable outcome of the change.

### A — file-set + size budget

Extend the per-case `expect` block in [cases.json](../../../chat-service/tests/cases.json):

```json
"expect": {
  "mustInvoke": ["planner", "developer"],
  "maxDurationMs": 2700000,
  "maxCostUsd": 6.00,
  "mustModify": ["src/atomic-crm/deals/DealEdit.tsx", "src/atomic-crm/deals/DealCard.tsx"],
  "mustNotModify": ["src/atomic-crm/contacts/**"],
  "expectedDiffStats": { "filesChanged": 3, "linesAdded": 30, "linesRemoved": 5 }
}
```

All three keys are **optional**. If absent, A produces no signal for that dimension.

- **`mustModify`** (string[]): exact file paths (relative to `/app`). Soft warning if any listed path is missing from the actual diff.
- **`mustNotModify`** (string[]): glob patterns. Soft warning per matched file in the diff.
- **`expectedDiffStats`** (`{ filesChanged, linesAdded, linesRemoved }`): tolerance ±100% (i.e. actual within `[expected/2, expected*2]`). Outside that range → soft warning.

Signal collection: after the case turn ends and before the next `resetCrmSource()`, run:

```bash
docker exec atomic-crm-demo sh -c "cd /app && git diff --numstat src/"
docker exec atomic-crm-demo sh -c "cd /app && git diff --name-only src/"
```

Soft warnings are surfaced in the run output as `WARN` lines (yellow), do not affect the `success` flag, and are recorded under `metrics.warnings: string[]` in the per-case result.

### C — Playwright behavioral check

For a case `<id>`, if the file `chat-service/tests/checks/<id>.js` exists, it is loaded and run as the bloquant result check.

**Contract** — the file default-exports an async function:

```js
// chat-service/tests/checks/simple-label-english.js
export default async function check(page) {
  await page.goto('http://localhost:5173/');
  await page.getByText('My Friends').waitFor({ state: 'visible', timeout: 10000 });
}
```

The function receives a Playwright `Page` and **must throw** on failure (Playwright's `waitFor`, `expect` from `@playwright/test`, or any thrown error all qualify).

Runner code (added to `run.js`):

```js
import { chromium } from 'playwright';

async function runPlaywrightCheck(caseId) {
  const checkPath = join(__dirname, 'checks', `${caseId}.js`);
  if (!existsSync(checkPath)) return { ran: false };

  const { default: check } = await import(checkPath);
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await check(page);
    return { ran: true, success: true };
  } catch (err) {
    return { ran: true, success: false, error: err.message };
  } finally {
    await browser.close();
  }
}
```

Failure of C sets `metrics.success = false` and pushes to `metrics.errors` (matching the existing convention for hard failures).

`@playwright/test` is not required — the bare `playwright` package, already pulled in transitively by the Atomic CRM e2e setup, exposes `chromium.launch()`. We do **not** introduce a Playwright config or test runner.

### Diff archival (artifact, not check)

After each case (regardless of success), capture the full diff:

```bash
docker exec atomic-crm-demo sh -c "cd /app && git diff src/" > tests/results/<runTs>/<caseId>.patch
```

These files are not compared automatically. They exist for `git log`-style human inspection when a case fails: open the `.patch`, see exactly what the IA produced.

The existing `tests/results/run-<ts>.json` continues to be written; the per-case `.patch` files live in a sibling directory `tests/results/<runTs>/` to keep the results dir tidy.

### Per-case flow

```
for each case:
  1. resetCrmSource()                             # existing
  2. WS: send mode → wait turn                    # existing
  3. WS: send prompt → wait turn                  # existing
  4. capture metrics from debug_raw               # existing
  5. NEW: capture git diff (numstat + name-only + full patch)
  6. NEW: evaluate A (mustModify, mustNotModify, expectedDiffStats) → warnings
  7. NEW: if checks/<id>.js exists → runPlaywrightCheck → bloquant
  8. NEW: write <runTs>/<caseId>.patch
  9. validateExpectations()                       # existing (mustInvoke etc.)
```

### Baseline & comparison

`baseline.json` and `compareWithBaseline()` get one new column: `result` showing the C check status (`OK` / `FAIL` / `–` if no check). A's warnings are not part of the comparison table — they're surfaced in the inline run output only. The existing duration/cost/tokens columns are unchanged.

The baseline file gains nothing structurally beyond what's already in `metrics`: `result` derives from `errors` content, and `warnings` is included in case results but not compared to baseline (warnings are advisory, not regression-tracked).

### Output sample

```
[1/5] simple-label-english          OK    (12.4s, $0.142, 18.2k in, agents: -)
                                    result: OK (Playwright)
                                    WARN: file mismatch — expected src/atomic-crm/dashboard/Dashboard.tsx, none touched
[2/5] medium-new-field              FAIL  (480.1s, $4.21, 312.0k in, agents: planner,developer)
                                    result: FAIL — TimeoutError: locator('text=Priority') exceeded 10000ms
                                    WARN: diff size 8× expected (62 lines vs 8)
```

## Edge cases

- **Case with no `checks/<id>.js`**: C returns `{ ran: false }`, success unaffected, output shows `result: –`.
- **Playwright check times out**: caught by the function's own `timeout`s (e.g. `waitFor({ timeout: 10000 })`), reported as a normal failure. We don't wrap a global timeout — the case-level `maxDurationMs` is the WS turn budget, not the e2e budget.
- **`runCaseFromSession` (replay mode)**: A and C both skipped (no live CRM, no live diff). Only existing checks run, as today.
- **Reset failure**: existing behavior (warning, continue) preserved. If reset fails, the next case's diff will include leftover changes — A's warnings will catch this loudly.
- **`/app` is dirty before run**: same risk. Out of scope for this design; the existing reset is best-effort.
- **Forbidden file glob match**: implemented with a small glob matcher — `picomatch` if it's already a transitive dependency, otherwise a ~20-line inline matcher (the patterns we need are simple — `dir/**`, `*.tsx`).

## Out of scope

- Migrating cases.json → cases.yml or splitting per-case files.
- Running A as bloquant or C as soft (we considered, the user chose this weighting).
- Headed Playwright runs / video capture / screenshot diffing.
- Parallelising the bench (Playwright launches per case must remain sequential against the single shared CRM at :5173).
- Auto-generating `mustModify` from a "good run" (would lock cases into one solution shape).

## Implementation outline

(For the implementation plan to expand.)

1. **Capture diff** — extend `runCase` to call `docker exec` for `git diff --numstat`, `--name-only`, and full patch after the turn settles. Wire results into `metrics`.
2. **A signal** — implement `evaluateFileSet(metrics, expect)` producing `metrics.warnings`. Glob via small inline matcher or `picomatch` if available.
3. **C signal** — implement `runPlaywrightCheck(caseId)` with dynamic `import()`. Wire bloquant failure into `metrics.errors` / `metrics.success`.
4. **Patch archive** — write `<runTs>/<caseId>.patch` next to the run JSON.
5. **Output** — extend the inline log line and `compareWithBaseline()` to include the result column.
6. **Cases** — add `mustModify` / `expectedDiffStats` to the 5 existing cases (where applicable) and write `checks/<id>.js` for at least the 3 simple cases.
7. **Baseline refresh** — `node run.js --update-baseline` after the implementation lands.
