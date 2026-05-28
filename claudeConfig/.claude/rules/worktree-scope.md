# Worktree scope — strict file access for ticket work

Applies to: developer, quality-reviewer, test-validator. Any agent working on a specific ticket dispatched into the shared `tickets` team with a suffixed name (e.g. `developer-TASK-006`).

Not applicable to: planner (searches /app/src/ for file discovery), merger (operates in /app to merge), chat-orchestrator (doesn't touch files), project-manager (operates on /app/docs/project-context.json directly on main — config only, no code), documentator (writes /app/MEMORY.md directly on main in Mode 2; never touches application code).

Developer ADRs follow the standard worktree rule: write `<WORKTREE_PATH>/adr/ADR-<TASK-XXX>-<slug>.md` inside your worktree, commit alongside the implementation, the merger ships it to `/app/adr/` like any other change. See `Skill({skill: "adr-writing"})` for the full rules and template.

## Why

Each ticket gets its own git worktree at `/app/worktrees/<SESSION_SHORT_ID>/TASK-XXX/` (session-scoped to prevent stale worktrees from a previous stopped session from interfering). Reading/editing `/app/src/...` while you have the same file at `<WORKTREE_PATH>/src/...` is:

1. Duplicate work — same bytes, twice the token cost
2. Incorrect — `/app` is on the base branch, missing the ticket's changes
3. Dangerous — editing `/app/src/App.tsx` pollutes the base branch with changes outside the ticket's scope. This happened in a past session and left 20+ files uncommitted on `master`.

## Allowed paths

| Path prefix | Read | Write/Edit | Bash cwd |
|---|---|---|---|
| `<WORKTREE_PATH>/**` (i.e. `/app/worktrees/<SESSION_SHORT_ID>/TASK-XXX/`) | ✅ | ✅ | ✅ |
| `${TICKETS_DIR}/TASK-XXX.json` (per-session folder, e.g. `/chat-service/logs/<uuid>/TASK-XXX.json`) | ✅ (ticket source of truth) | ⚠️ merger writes the `status` field; developer may flip `requires_supabase_migration` if the planner was wrong — no other writes | — |
| `/app/adr/**` | ✅ (learn from past structural decisions) | ❌ (developer writes ADRs inside the worktree at `<WORKTREE_PATH>/adr/`; the merger ships them to `/app/adr/`) | — |
| `/home/developer/.claude/**` | ✅ (skills, rules) | ❌ | — |

Everything else under `/app/` — `/app/src/`, `/app/e2e/`, `/app/supabase/`, `/app/package.json`, `/app/*.ts`, `/app/*.json` — is **off-limits**. If you need information from these, read the copy inside your worktree.

## Bash — every call needs `cd`

Bash tool invocations are **stateless shells**. `cd <WORKTREE_PATH>` in one call does NOT persist to the next — the next call starts again in `/app` by default.

**Mandatory prefix for every Bash when working inside a worktree:**

```bash
cd <WORKTREE_PATH> && <your command>
```

`WORKTREE_PATH` is provided in your spawn prompt (e.g. `/app/worktrees/46bc14c5/TASK-XXX`).

## Violation examples

```
Read("/app/src/components/atomic-crm/types.ts")
```
❌ The worktree has this file at `<WORKTREE_PATH>/src/components/atomic-crm/types.ts`. Read there instead.

```
Bash("npm run typecheck")
```
❌ Runs in `/app` (default cwd), not your worktree. Use `Bash("cd <WORKTREE_PATH> && npm run typecheck")`.

```
Edit("/app/src/App.tsx", ...)
```
❌ Never edit inside `/app/`. Always your worktree. If `App.tsx` genuinely belongs to the ticket, edit `<WORKTREE_PATH>/src/App.tsx`.

```
Bash("npm run prettier:apply")
```
❌ No `cd` prefix → runs in `/app`, reformats the base branch. Use `Bash("cd <WORKTREE_PATH> && npm run prettier:apply")`.

## When you genuinely need `/app` state

You (almost) never do. Specific exceptions:
- Reading the ticket JSON: `Read("${TICKETS_DIR}/TASK-XXX.json")` — source of truth, read-only. `TICKETS_DIR` is the absolute per-session path passed in your prompt; substitute the literal value (e.g. `/chat-service/logs/<uuid>/TASK-XXX.json`).
- Reading past ADRs: `Read("/app/adr/ADR-<TASK-XXX>-<slug>.md")` (research)

If you think you need something else from `/app/`, stop and flag it to the caller. Do not silently edit `/app/` or run commands there.
