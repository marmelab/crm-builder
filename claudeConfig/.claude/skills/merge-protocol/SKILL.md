---
name: merge-protocol
description: Authoritative merge procedure for the local merger agent. 7 sequential steps to fast-forward a feature branch into the base branch, clean up the worktree, update ticket status, and report. Same protocol for COMPLEX (loop in shared singleton) and SIMPLE (single-shot).
---

## When

Auto-loaded by the `merger` agent via its frontmatter. Loaded once at spawn; the steps below apply to every merge the agent performs (one in SIMPLE, N in COMPLEX).

## Inputs per merge

| Variable | COMPLEX source | SIMPLE source |
|---|---|---|
| `TASK_ID` | parsed from `from:` of the dev's SendMessage (`developer-TASK-006` → `TASK-006`) | not applicable — slug-based branch instead |
| `BRANCH_NAME` | parsed from the SendMessage body (`branch=<branch>`); fallback to `${TICKETS_DIR}/<TASK_ID>.json#branch_name` | provided in the spawn prompt |
| `WORKTREE_PATH` | `/app/worktrees/<SESSION_SHORT_ID>/<TASK_ID>` — derive `SESSION_SHORT_ID` from `TICKETS_DIR` (first segment before `-`) | provided in the spawn prompt |

## MERGE STEPS — run in order, stop at the first failure

1. **Verify worktree clean**
   ```
   cd <WORKTREE_PATH> && git status --porcelain
   ```
   Non-empty → developer left uncommitted changes. Report failed, do not merge.

2. **Return to base + reset stale debris in `/app`** (mandatory, idempotent)
   ```
   cd /app && BASE=$(git symbolic-ref --short HEAD)
   git pull --ff-only 2>/dev/null || true
   git reset --hard HEAD && /entrypoint-helpers/apply-app-variant.sh
   ```
   - `reset` discards stale tracked-file changes (debris from previous runs).
   - `apply-app-variant.sh` re-copies `App.fakerest.tsx` (demo) or `App.supabase.tsx` (full) over `src/App.tsx` — without it, the reset reverts `App.tsx` to the upstream stub and the dev server breaks.
   - `docs/project-context.json` is now **tracked**, so `git reset --hard HEAD` keeps the version that was committed on main by `project-manager` / `planner` (SETUP_MODE). Ticket JSONs in `${TICKETS_DIR}` are outside `/app` — untouched by the reset.

3. **Merge**
   ```
   git merge --no-ff <BRANCH_NAME> -m "<type>(<TASK_ID>): <ticket title>"
   ```
   `<type>` matches the ticket's `type` field (feat / fix / chore). On conflict (`CONFLICT` in output): `git merge --abort`, report failed with the conflicting files. Do **NOT** resolve — that's the developer's job.

4. **Cleanup**
   ```
   git worktree remove <WORKTREE_PATH> && git branch -d <BRANCH_NAME>
   ```
   On worktree-remove failure (leftover files): `git worktree remove --force <WORKTREE_PATH>`.

5. **Update ticket status** (COMPLEX only — `TASK_ID` starts with `TASK-`)
   Use the **Edit tool**, NOT shell (`cat | jq > tmp && mv` is blocked by `block-bash-file-write`):
   ```
   Edit(
     file_path: "${TICKETS_DIR}/<TASK_ID>.json",
     old_string: '"status": "pending"',
     new_string: '"status": "merged"'
   )
   ```
   If `status` was `"in_progress"`, substitute. Verify with `Read`. Skip this step in SIMPLE (no ticket JSON).

6. **Report**
   - COMPLEX: `SendMessage(team-lead, "merged TASK-XXX, commit=<short sha>")`
   - SIMPLE: return text `DONE: commit=<short sha>. files=[...]`

7. **On any failure of steps 1–4**:
   - COMPLEX: `SendMessage(team-lead, "TASK-XXX merge failed: <reason>")`, then idle for the next message.
   - SIMPLE: return text `FAILED: <reason>`.

## NEVER

- `git add` / `git commit` / `git stash` / `git clean -fd` / `git checkout -- <file>`.
- `git push`, `gh` commands.
- `--no-verify`, `--force`, `-f` on git.
- Force-merge on conflict — abort and report failed.
- Spawn agents, `TeamCreate`, `TeamDelete`.
- Edit any file in `/app` or any worktree (only the Step 5 ticket JSON edit is allowed).
- Stop after one merge in COMPLEX (loop until `shutdown_request`).

## Failure modes

- Worktree path doesn't exist or branch is gone → BLOCKED / FAILED (likely team was killed and cleanup ran). Don't retry silently.
- `.git/index.lock` contention (rare — external process touching `/app/.git/`): wait 2s, retry once. If still locked: COMPLEX → report failed and continue with next ticket; SIMPLE → return FAILED.
