---
name: quality-review-protocol
description: Per-cycle workflow for the quality-reviewer agent — idle on dispatch, wait for the developer's "ready" SendMessage, read diff, return APPROVED / APPROVED WITH RESERVATIONS / BLOCKED. Auto-loaded by quality-reviewer.
---

## When

Auto-loaded by the `quality-reviewer` agent via its frontmatter. The detailed review rubric (code quality + security checks) lives in the agent's own prose; this skill covers only the loop and the verdict format.

## Inputs (from spawn prompt)

| Variable | Source |
|---|---|
| `TASK_ID` | spawn prompt |
| `WORKTREE_PATH` | `/app/worktrees/<TASK_ID>` |
| `TICKET_FILE` | `${TICKETS_DIR}/<TASK_ID>.json` |
| `COUNTERPART` | `developer-<TASK_ID>` (the only sender you respond to) |
| `TEAM_LEAD` | `team-lead` |

## Initial action on dispatch

**Stop immediately. Do NOT call any tool — including `Skill`.** Idle until you receive your first SendMessage from `COUNTERPART` (NOT from `team-lead` — team-lead's GO message goes to the developer; you wait for the dev's `"ready, please review"` specifically).

Rationale: dispatching the reviewer puts a prompt in your context but the diff doesn't exist yet. Reading the worktree, running `git diff`, doing exploratory Greps — all wasted work, the developer hasn't committed.

## Workflow (loop, only after the developer's first SendMessage)

1. **Read** ticket spec at `TICKET_FILE` and the worktree diff:
   ```
   git -C <WORKTREE_PATH> diff <base>..HEAD
   ```
2. **Apply the rubric** from the agent's own prompt (Parts A and B). Skim [security-triggers.md](../../rules/security-triggers.md) and apply [coding-style.md](../../rules/coding-style.md), [agent-output-format.md](../../rules/agent-output-format.md).
3. **Verdict** — SendMessage to `COUNTERPART` (always the suffixed name, never bare `developer`):
   - `APPROVED` — zero blocking issues, nothing to flag.
   - `APPROVED WITH RESERVATIONS` — zero blocking issues, but one or more warnings/suggestions worth surfacing for the dev to consider. Be explicit when a warning is "not blocking" so the dev can skip it without re-iterating.
   - `BLOCKED:\n- file: …\n  line: …\n  description: …\n  fix: …\n- …\nSummary: N blocking issues.` — at least one blocking issue.
4. **Idle** for the next message (re-review after fix). Do NOT stop after one verdict — loop until `shutdown_request`.

## DO NOT

- Invoke `Skill({skill: "agent-team"})` — it's for the team-lead.
- Act on dispatch — wait for the developer's message first.
- React to any sender other than `COUNTERPART` (ignore `team-lead` except for `shutdown_request`).
- Run validations (typecheck, e2e, unit, prettier) — `validate-before-review` PreToolUse hook does this on the dev's side.
- SendMessage anyone other than `COUNTERPART` (and `team-lead` for `shutdown_response`).
- Re-spawn agents or call `TeamCreate` / `TeamDelete`.
