---
name: test-validation-protocol
description: Per-cycle workflow for the test-validator agent — idle on dispatch, wait for the developer's "ready" SendMessage, check test presence + pertinence, return GREEN / GREEN_WITH_SANDBOX_LIMITATIONS / RED. Auto-loaded by test-validator.
---

## When

Auto-loaded by the `test-validator` agent via its frontmatter. The detailed verification steps (Step 1 integration, Step 2 screenshots, Step 3 e2e spec sanity) live in the agent's own prose; this skill covers only the loop and the verdict format.

## Inputs (from spawn prompt)

| Variable | Source |
|---|---|
| `TASK_ID` | spawn prompt |
| `WORKTREE_PATH` | `/app/worktrees/<SESSION_SHORT_ID>/<TASK_ID>` — from spawn prompt |
| `TICKET_FILE` | `${TICKETS_DIR}/<TASK_ID>.json` |
| `COUNTERPART` | `developer-<TASK_ID>` (the only sender you respond to) |
| `TEAM_LEAD` | `team-lead` |

## Initial action on dispatch

**Stop immediately. Do NOT call any tool — including `Skill`.** Idle until you receive your first SendMessage from `COUNTERPART` (NOT from `team-lead` — team-lead's GO message goes to the developer; you wait for the dev's `"ready, please validate"` specifically).

Rationale: same as quality-reviewer — exploring an empty worktree before the dev commits wastes tokens and produces stale verdicts.

## Workflow (loop, only after the developer's first SendMessage)

1. **Read** ticket spec at `TICKET_FILE` and the worktree (including new test files).
2. **PRESENCE** — every new behavior in the diff has at least one test (unit or e2e per [testing.md](../../rules/testing.md) and the auto-loaded `e2e-conventions` skill).
3. **PERTINENCE** — assertions actually cover the failure modes that matter. A test that always passes (`expect(true).toBe(true)`) is not pertinent.
4. **Apply** the agent's Step 1 (integration), Step 2 (screenshots if reachable), Step 3 (e2e spec sanity) — see test-validator.md for the detail.
5. **Verdict** — SendMessage to `COUNTERPART` (always the suffixed name):
   - `Verdict: GREEN\n\nStep 1 — integration: …\nStep 2 — …\nStep 3 — …\nSummary: …` — clean.
   - `Verdict: GREEN_WITH_SANDBOX_LIMITATIONS\n…` — Steps 1 + 3 clean, Step 2 skipped because of sandbox (auth required, no display, etc.). Treated as approval by the team-lead.
   - `Verdict: RED\n\nIssues:\n- …\nSummary: …` — Step 1 missing or any blocking issue.
6. **Idle** for the next message (re-review after fix). Do NOT stop after one verdict — loop until `shutdown_request`.

**Critical**: Going idle without sending a verdict is a failure mode. The developer is waiting on you.

## DO NOT

- Invoke `Skill({skill: "agent-team"})` — it's for the team-lead.
- Act on dispatch — wait for the developer's message first.
- React to any sender other than `COUNTERPART` (ignore `team-lead` except for `shutdown_request`).
- Run tests (`npx vitest`, `npx playwright test`) — `validate-before-review` PreToolUse hook does this on the dev's side, and `npx vitest` hangs in non-TTY contexts anyway.
- Run `npx playwright install --with-deps` — heavy network + sudo.
- SendMessage other reviewers / merger / other tickets' agents.
