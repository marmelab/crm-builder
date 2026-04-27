# Worktree scope — strict file access for ticket work

Applies to: developer, quality-reviewer, test-validator. Any agent working on a specific ticket dispatched into a `ticket-TASK-XXX` team.

Not applicable to: planner (searches /app/src/ for file discovery), merger (operates in /app to merge), chat-orchestrator (doesn't touch files).

## Why

Each ticket gets its own git worktree at `/worktrees/TASK-XXX/`, which is a **complete copy** of the base branch plus the feature branch's changes. Reading/editing `/app/src/...` while you have the same file at `/worktrees/TASK-XXX/src/...` is:

1. Duplicate work — same bytes, twice the token cost
2. Incorrect — `/app` is on the base branch, missing the ticket's changes
3. Dangerous — editing `/app/src/App.tsx` pollutes the base branch with changes outside the ticket's scope. This happened in a past session and left 20+ files uncommitted on `master`.

## Allowed paths

| Path prefix | Read | Write/Edit | Bash cwd |
|---|---|---|---|
| `/worktrees/TASK-XXX/**` | ✅ | ✅ | ✅ |
| `${TICKETS_DIR}/TASK-XXX.json` (per-session folder, e.g. `/chat-service/logs/<uuid>/TASK-XXX.json`) | ✅ (ticket source of truth) | ⚠️ merger only, status field | — |
| `/app/docs/reflections/**` | ✅ (learn from past) | ⚠️ only in Mode 2 reflection, only `/app/docs/reflections/TASK-XXX-reflection.md` | — |
| `/home/developer/.claude/**` | ✅ (skills, rules) | ❌ | — |

Everything else under `/app/` — `/app/src/`, `/app/e2e/`, `/app/supabase/`, `/app/package.json`, `/app/*.ts`, `/app/*.json` — is **off-limits**. If you need information from these, read the copy inside your worktree.

## Bash — every call needs `cd`

Bash tool invocations are **stateless shells**. `cd /worktrees/TASK-XXX` in one call does NOT persist to the next — the next call starts again in `/app` by default.

**Mandatory prefix for every Bash in ticket mode:**

```bash
cd /worktrees/TASK-XXX && <your command>
```

Replace `TASK-XXX` with your actual ticket ID (from `WORKTREE_PATH` in your prompt).

## Violation examples

```
Read("/app/src/components/atomic-crm/types.ts")
```
❌ The worktree has this file at `/worktrees/TASK-XXX/src/components/atomic-crm/types.ts`. Read there instead.

```
Bash("npm run typecheck")
```
❌ Runs in `/app` (default cwd), not your worktree. Use `Bash("cd /worktrees/TASK-XXX && npm run typecheck")`.

```
Edit("/app/src/App.tsx", ...)
```
❌ Never edit inside `/app/`. Always your worktree. If `App.tsx` genuinely belongs to the ticket, edit `/worktrees/TASK-XXX/src/App.tsx`.

```
Bash("npm run prettier:apply")
```
❌ No `cd` prefix → runs in `/app`, reformats the base branch. Use `Bash("cd /worktrees/TASK-XXX && npm run prettier:apply")`.

## When you genuinely need `/app` state

You (almost) never do. Specific exceptions:
- Reading the ticket JSON: `Read("${TICKETS_DIR}/TASK-XXX.json")` — source of truth, read-only. `TICKETS_DIR` is the absolute per-session path passed in your prompt; substitute the literal value (e.g. `/chat-service/logs/<uuid>/TASK-XXX.json`).
- Reading past reflections: `Read("/app/docs/reflections/TASK-XXX-reflection.md")` (research)

If you think you need something else from `/app/`, stop and flag it to the caller. Do not silently edit `/app/` or run commands there.
