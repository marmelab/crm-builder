---
name: developer-protocol
description: Per-cycle workflow for the COMPLEX developer agent — read ticket, implement, commit, request review, handle BLOCKED / APPROVED / APPROVED WITH RESERVATIONS, write reflection, hand off to merger. Auto-loaded by the developer agent.
---

## When

Auto-loaded by the `developer` agent via its frontmatter. Contains the loop body that runs after the orchestrator's GO message.

## Inputs (from spawn prompt)

| Variable | Source |
|---|---|
| `TASK_ID` | spawn prompt |
| `WORKTREE_PATH` | `/app/worktrees/<SESSION_SHORT_ID>/<TASK_ID>` — from spawn prompt |
| `BRANCH_NAME` | `<SESSION_SHORT_ID>/<branch>` — from spawn prompt |
| `TICKET_FILE` | `${TICKETS_DIR}/<TASK_ID>.json` |
| `COUNTERPARTS.reviewers` | `[quality-reviewer-<TASK_ID>, test-validator-<TASK_ID>]` |
| `COUNTERPARTS.merger` | `merger` (shared singleton — bare name) |
| `TEAM_LEAD` | `team-lead` |

## Workflow

1. **Read ticket spec** at `TICKET_FILE` and any reflections in `/app/docs/reflections/` for the same domain.
2. **Implement** in the worktree (Edit / Write / Bash). Commit when ready. Atomic commits per logical step, every subject prefixed `feat(TASK-XXX): …` or `fix(TASK-XXX): …`. See [coding-style.md](../../rules/coding-style.md), [worktree-scope.md](../../rules/worktree-scope.md).
3. **Request review**:
   - `SendMessage(quality-reviewer-<TASK_ID>, "ready, please review")`
   - `SendMessage(test-validator-<TASK_ID>, "ready, please validate")`
   - `approvals_needed = 2`, `approvals_received = 0`.
4. **Wait for replies** (suffixed counterparts only):
   - `APPROVED` → `approvals_received++`
   - `APPROVED WITH RESERVATIONS` → counts as approval (`approvals_received++`). The reviewer flagged optional improvements; for each issue listed, decide:
     - **fix it inline** if (a) it's clearly correct AND (b) the fix is small (<5 lines, no architectural change)
     - **skip it** if it's a nit, a "nice to have", out-of-scope for the ticket, or the reviewer explicitly said "not blocking"

     Apply trivial fixes in the same commit (silently — no need to re-notify reviewers, this verdict already approved). Skipped items are noted in the reflection if they suggest follow-up work.
   - `BLOCKED: …` → `approvals_received = 0`, fix, commit, re-notify ALL reviewers (the diff has changed). Loop.
5. **When `approvals_received == 2`** — Mode 2 reflection:
   - Apply the auto-loaded `reflection-writing` skill (already in your context — no `Skill({…})` call needed).
   - Read existing reflections in same domain (`/app/docs/reflections/`) and build on them.
   - Write `<WORKTREE_PATH>/docs/reflections/<TASK_ID>-reflection.md` and commit.
6. **Hand off to merger**:
   - `SendMessage(merger, "ready: TASK-XXX, branch=<BRANCH_NAME>, all approved + reflection committed")`.
   - The first 16 chars of the message MUST be `ready: TASK-XXX` — the merger parses it.
7. **Stop**. The merger and team-lead handle cleanup.

## Timeouts

- Reviewer silent for more than 180s → `SendMessage(team-lead, "TASK-XXX stuck on <reviewer>: no reply for 180s")`.
- Same fix-cycle iterated more than 5 times → `SendMessage(team-lead, "TASK-XXX stuck: <N> cycles")`.

## Critical addressing

Only SendMessage:
- Your `COUNTERPARTS.reviewers` (own ticket's suffixed names)
- The bare `merger`
- `team-lead`

Never SendMessage other tickets' agents — `developer-TASK-Y`, `quality-reviewer-TASK-Y`, etc. are off-limits.

## NEVER

- Run `git merge`, `git push`, `gh` commands — that's the merger's job.
- Run validation manually (typecheck, prettier, unit, e2e) — `validate-before-review` PreToolUse hook does it.
- Edit anything outside `<WORKTREE_PATH>/` — see worktree-scope rule.
- Commit on `master` / `main` — always on `BRANCH_NAME`.
- Add features outside the ticket scope.
