# Deferred Migration Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the developer from ever writing Supabase migrations; generate them on demand at deploy time from an isolated per-session integration branch, gated by a non-technical satisfaction question.

**Architecture:** Two phases. **Phase 1** introduces a per-session git integration branch (`session/<id>`) forked from main, with a fixed anchor ref (`session-base/<id>`) and a dedicated `_session` worktree; tasks fork from and merge into the session branch, which is promoted to main once per request under a lock, with auto conflict resolution. **Phase 2** removes migration authoring from the dev flow and adds a deploy-time migration round (`simple-developer` → `quality-reviewer` → `merger`) that derives SQL from `git diff session-base/<id>..session/<id>`.

**Tech Stack:** Bash hooks, Node.js (chat-service + `.mjs` scripts), Claude agent prompt files (`.md`), git worktrees/branches, Supabase CLI, Vite/FakeRest demo.

**Spec:** `docs/superpowers/specs/2026-05-27-deferred-migration-generation-design.md`

---

## Testing reality for this repo

This codebase is prompt/script-heavy. "Tests" therefore mean different things per artifact, and each task states which applies:

- **Node scripts** (`pending-deploys.mjs`): real `node:test` files under `chat-service/test/`, run with `cd chat-service && npm test`.
- **Bash hooks** (`setup-worktree.sh`, `member-idle-gate.sh`): shell test scripts under `claudeConfig/.claude/hooks/test/` following the existing `restrict-documentator-write.test.sh` pattern (pipe JSON stdin, assert exit code). Run with `bash claudeConfig/.claude/hooks/test/<name>.test.sh`.
- **Agent prompt / rule / skill `.md` files**: not unit-testable. Verification = `grep` assertions that removed strings are gone and added anchors are present, plus a manual review checklist. Behavior is validated by the **end-of-phase runtime smoke test** (run a real session in the container).
- **`apply-migrations.sh`**: needs Docker/Supabase; verified by review + a `bash -n` syntax check, exercised in the runtime smoke test.

`SESSION_SHORT` / `<id>` always denotes the session short id (first segment of the session uuid). In file paths the literal directory is `/app/worktrees/<SESSION_SHORT>/...`.

---

## File Structure

| File | Phase | Responsibility after change |
|---|---|---|
| `claudeConfig/.claude/hooks/setup-worktree.sh` | 1 | Create `session/<id>` + `session-base/<id>` + `_session` worktree once; fork task worktrees from `session/<id>`. |
| `claudeConfig/.claude/hooks/test/setup-worktree.test.sh` | 1 (new) | Assert branch/ref/worktree creation and fork source. |
| `claudeConfig/.claude/agents/developer.md` | 1+2 | Rebase onto `session/<id>` (P1); stop writing migrations (P2). |
| `claudeConfig/.claude/agents/merger.md` | 1 | Two-stage: task→`session/<id>` in `_session`; promote `session/<id>`→main under lock. |
| `claudeConfig/.claude/agents/chat-orchestrator.md` | 1+2 | Promotion handshake + conflict-resolver dispatch (P1); satisfaction question + migration round states (P2). |
| `claudeConfig/.claude/rules/worktree-scope.md` | 1 | Document session-branch topology + `_session` + resolver exception. |
| `claudeConfig/.claude/hooks/cleanup-worktree.sh` | 1 | Leave session branch/ref/`_session` intact on task cleanup (document). |
| `claudeConfig/.claude/agents/planner.md` | 2 | Remove `requires_supabase_migration` + migration-ticket rules. |
| `claudeConfig/.claude/skills/writing-migrations/SKILL.md` | 2 (new) | Guide the migration round (diff → SQL). |
| `claudeConfig/.claude/agents/quality-reviewer.md` | 2 | Single-shot migration-review mode. |
| `claudeConfig/.claude/hooks/member-idle-gate.sh` | 2 | Bypass for the migration-round reviewer. |
| `claudeConfig/.claude/hooks/test/member-idle-gate.test.sh` | 2 (new) | Assert the migration-review bypass. |
| `scripts/apply-migrations.sh` | 2 | Drop promotion phase; apply only. |
| `scripts/pending-deploys.mjs` | 2 | Session-branch diff detection. |
| `chat-service/test/pending-deploys.test.js` | 2 (new) | Test diff-based detection. |
| `CLAUDE.md` | 2 | Update topology + gotchas; remove migration-pending/flag references. |

---

# PHASE 1 — Session-branch git topology

## Task 1: setup-worktree creates the session branch, anchor ref, and `_session` worktree

**Files:**
- Modify: `claudeConfig/.claude/hooks/setup-worktree.sh`
- Test: `claudeConfig/.claude/hooks/test/setup-worktree.test.sh` (new)

- [ ] **Step 1: Write the failing hook test**

Create `claudeConfig/.claude/hooks/test/setup-worktree.test.sh`:

```bash
#!/bin/bash
# Tests for setup-worktree.sh session-branch topology.
# Uses a throwaway git repo as a fake /app via APP_DIR override.
set -u

HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/setup-worktree.sh"
PASS=0; FAIL=0
assert() { # label, condition-exit
  if [ "$2" = "0" ]; then echo "PASS — $1"; PASS=$((PASS+1));
  else echo "FAIL — $1"; FAIL=$((FAIL+1)); fi
}

TMP=$(mktemp -d)
export APP_DIR="$TMP/app"
mkdir -p "$APP_DIR"
git -C "$APP_DIR" init -q -b main
git -C "$APP_DIR" config user.email t@t.t; git -C "$APP_DIR" config user.name t
echo seed > "$APP_DIR/seed.txt"; git -C "$APP_DIR" add .; git -C "$APP_DIR" commit -qm seed
mkdir -p "$APP_DIR/node_modules"

export CHAT_SESSION_DIR="$TMP/logs/ab12cd34-xxxx"
mkdir -p "$CHAT_SESSION_DIR"

# Dispatch a COMPLEX developer for TASK-001
echo '{"agent_type":"developer-TASK-001"}' | bash "$HOOK" >/dev/null 2>&1

git -C "$APP_DIR" show-ref --verify --quiet refs/heads/session/ab12cd34; assert "session branch created" $?
git -C "$APP_DIR" show-ref --verify --quiet refs/heads/session-base/ab12cd34; assert "session-base anchor created" $?
test -d "$APP_DIR/worktrees/ab12cd34/_session"; assert "_session worktree created" $?
test -d "$APP_DIR/worktrees/ab12cd34/TASK-001"; assert "task worktree created" $?
# Task branch must fork from the session branch, not main directly:
git -C "$APP_DIR" merge-base --is-ancestor session/ab12cd34 ab12cd34/TASK-001 2>/dev/null; assert "task branch forked from session branch" $?

echo "PASS=$PASS FAIL=$FAIL"
rm -rf "$TMP"
[ "$FAIL" = "0" ]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash claudeConfig/.claude/hooks/test/setup-worktree.test.sh`
Expected: FAIL — the hook still branches from `HEAD` and never creates `session/…`, `session-base/…`, or `_session`.

- [ ] **Step 3: Add session-branch + anchor + `_session` creation, and fork tasks from the session branch**

In `setup-worktree.sh`, after the `SESSION_SHORT` guard block (current line ~31, right after the `if [ -z "$SESSION_SHORT" ]` block) insert:

```bash
APP_DIR=${APP_DIR:-/app}
BASE=$(git -C "$APP_DIR" symbolic-ref --short HEAD 2>/dev/null || echo main)

# Create the per-session integration branch, its fixed fork anchor, and the
# integration worktree exactly once. The anchor ref never moves and is the
# stable diff baseline for migrations (Phase 2).
if ! git -C "$APP_DIR" show-ref --verify --quiet "refs/heads/session/${SESSION_SHORT}"; then
  git -C "$APP_DIR" branch "session/${SESSION_SHORT}"      "$BASE" 2>/dev/null || true
  git -C "$APP_DIR" branch "session-base/${SESSION_SHORT}" "$BASE" 2>/dev/null || true
  SESSION_WT="${APP_DIR}/worktrees/${SESSION_SHORT}/_session"
  if [ ! -d "$SESSION_WT" ]; then
    mkdir -p "$(dirname "$SESSION_WT")"
    git -C "$APP_DIR" worktree add "$SESSION_WT" "session/${SESSION_SHORT}" 2>/dev/null || true
    [ -e "$SESSION_WT/node_modules" ] || cp -al "${APP_DIR}/node_modules" "$SESSION_WT/node_modules" 2>/dev/null || true
  fi
  echo "[$(date -Iseconds)] setup-worktree SESSION-BRANCH created session/${SESSION_SHORT} from $BASE" >> "$LOG" 2>/dev/null || true
fi
```

Then change the task worktree creation (current line ~71) from forking `HEAD` to forking the session branch:

```bash
if git -C "$APP_DIR" worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "session/${SESSION_SHORT}" 2>/tmp/wt-err; then
```

(Replace the trailing `HEAD` with `"session/${SESSION_SHORT}"`. Keep every other line of that block, including the existing `git -C /app` calls — only the literal `/app` references already there stay, but prefer the new `$APP_DIR` in the lines you add.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash claudeConfig/.claude/hooks/test/setup-worktree.test.sh`
Expected: `PASS=5 FAIL=0` and exit 0.

- [ ] **Step 5: Guard `_session` against orphan-recovery deletion**

The orphan-recovery block (current lines ~57-61) does `rm -rf "$WORKTREE_PATH"` when the dir exists but is unregistered. Confirm it only targets the *task* `$WORKTREE_PATH` (`…/TASK-XXX` or `…/simple`), never `…/_session`. No code change if so; add a one-line comment above that block: `# Never targets _session (different path; created in the session-branch block above).`

- [ ] **Step 6: Commit**

```bash
git add claudeConfig/.claude/hooks/setup-worktree.sh claudeConfig/.claude/hooks/test/setup-worktree.test.sh
git commit -m "feat(topology): create session branch, anchor ref and _session worktree in setup-worktree"
```

## Task 2: developer rebases onto the session branch

**Files:**
- Modify: `claudeConfig/.claude/agents/developer.md:39-43` and `:56-60`

- [ ] **Step 1: Replace the rebase target in workflow step 3**

Find (step 3 "Rebase onto current master before review"):

```
3. **Rebase onto current master before review** — other tasks may have merged while you were implementing:
   ```bash
   cd <WORKTREE_PATH> && git fetch origin && git rebase origin/master
   ```
   Resolve any conflicts, then `git add` + `git rebase --continue`. Commit the result if needed.
   Only proceed once `git status` shows a clean tree on top of the latest master.
```

Replace with:

```
3. **Rebase onto the session branch before review** — sibling tasks merge into `session/<SESSION_SHORT_ID>` (not main) while you work, so rebase onto it. Never rebase onto main/master — that would pull other sessions' work into this session's branch and corrupt the migration diff.
   ```bash
   cd <WORKTREE_PATH> && git rebase session/<SESSION_SHORT_ID>
   ```
   Resolve any conflicts, then `git add` + `git rebase --continue`. Commit the result if needed.
   Only proceed once `git status` shows a clean tree on top of the latest `session/<SESSION_SHORT_ID>`.
```

- [ ] **Step 2: Replace the rebase target in workflow step 7**

Find (step 7 "Rebase onto current master before merger"):

```
7. **Rebase onto current master before merger** — reviews may have taken time; other tasks may have merged since step 3:
   ```bash
   cd <WORKTREE_PATH> && git fetch origin && git rebase origin/master
   ```
```

Replace with:

```
7. **Rebase onto the session branch before merger** — reviews may have taken time; sibling tasks may have merged into `session/<SESSION_SHORT_ID>` since step 3:
   ```bash
   cd <WORKTREE_PATH> && git rebase session/<SESSION_SHORT_ID>
   ```
```

- [ ] **Step 3: Verify both rebase targets changed and none remain**

Run: `grep -n "origin/master\|origin && git rebase" claudeConfig/.claude/agents/developer.md`
Expected: no output (no remaining master-rebase). 
Run: `grep -c "git rebase session/" claudeConfig/.claude/agents/developer.md`
Expected: `2`.

- [ ] **Step 4: Commit**

```bash
git add claudeConfig/.claude/agents/developer.md
git commit -m "feat(topology): developer rebases onto the session branch, not master"
```

## Task 3: merger does two-stage merge (task→session, promote session→main)

**Files:**
- Modify: `claudeConfig/.claude/agents/merger.md`

- [ ] **Step 1: Rewrite the MERGE STEPS for Stage A (task → session)**

Replace the current "MERGE STEPS" block (steps 1-3) with:

```
### MERGE STEPS — Stage A (task → session branch)

1. **Verify worktree clean**
   ```bash
   cd <WORKTREE_PATH> && git status --porcelain
   ```
   Non-empty → developer left uncommitted changes. Report failed, do not merge.

2. **Merge the task branch into the session branch, in the `_session` worktree.**
   The integration worktree is `/app/worktrees/<SESSION_SHORT_ID>/_session` (checked out on `session/<SESSION_SHORT_ID>`). `/app` stays on main for the demo.
   ```bash
   cd /app/worktrees/<SESSION_SHORT_ID>/_session \
     && git merge --no-ff <BRANCH_NAME> -m "<type>(<TASK_ID>): <ticket title>"
   ```
   On `CONFLICT`: `git merge --abort`, report failed with conflicting files. Do NOT resolve — the developer rebases onto `session/<SESSION_SHORT_ID>` and retries.
```

- [ ] **Step 2: Add Stage B (promotion) as a new section after the per-mode table**

Insert a new section (after MERGE STEPS, before "NEVER"):

```
### PROMOTION — Stage B (session branch → main)

Triggered only by an explicit orchestrator message starting `promote: session=<SESSION_SHORT_ID>`. Run once per request, after all the request's tickets have merged into the session branch.

```bash
cd /app && flock /app/.promote.lock bash -c '
  BASE=$(git symbolic-ref --short HEAD)
  git reset --hard HEAD && /entrypoint-helpers/apply-app-variant.sh
  git merge --no-ff session/<SESSION_SHORT_ID> -m "merge(session): <SESSION_SHORT_ID>"
'
```

- Success → report `promoted: session=<SESSION_SHORT_ID>, commit=<short sha>`.
- On `CONFLICT` → `git merge --abort` (still inside the lock), report `promote conflict: files=[<paths>]`. Do NOT resolve — the orchestrator dispatches a resolver.
- The `flock` serialises promotions across concurrent sessions sharing main.
```

- [ ] **Step 3: Update the COMPLEX/SIMPLE mode descriptions**

In the COMPLEX mode description, change "merge serially, report each merge to team-lead" to note merges go into the session worktree, and add: "When the team-lead sends `promote: session=…`, run PROMOTION (Stage B), then continue idling until `shutdown_request`."

In the SIMPLE mode description, add: "After Stage A, immediately run PROMOTION (Stage B) for `session/<SESSION_SHORT_ID>`, then return `DONE: commit=<promotion sha>`."

- [ ] **Step 4: Verify the merger no longer merges task branches directly into main**

Run: `grep -n "_session\|flock /app/.promote.lock\|promote: session=" claudeConfig/.claude/agents/merger.md`
Expected: lines present for all three anchors.
Run: `grep -n "git merge --no-ff <BRANCH_NAME>" claudeConfig/.claude/agents/merger.md`
Expected: appears only inside the Stage A `_session` block (one occurrence), not a bare `/app` merge.

- [ ] **Step 5: Commit**

```bash
git add claudeConfig/.claude/agents/merger.md
git commit -m "feat(topology): merger two-stage (task->session in _session, promote session->main under lock)"
```

## Task 4: orchestrator promotion handshake at end of request

**Files:**
- Modify: `claudeConfig/.claude/agents/chat-orchestrator.md` (STATE D, and SIMPLE STATE S-MERGE)

- [ ] **Step 1: Insert a promotion step into STATE D before teardown**

In STATE D, before the `SendMessage({type: "shutdown_request"})` step, add a numbered step 0:

```
0. **Promote the session branch to main** (once, after the request's last wave). Send the shared merger:
   `SendMessage(merger, "promote: session=<SESSION_SHORT_ID>")`
   Wait for the reply:
   - `promoted: session=…` → continue to shutdown (step 1).
   - `promote conflict: files=[…]` → emit ONE non-technical line ("Synchronising your changes…") and go to STATE PD-PROMOTE-FIX (see below). Do NOT shut the team down yet.
   This step runs only on the final wave (the same condition that gates POST-DEV). For intermediate waves, skip promotion and loop back to STATE B.
```

- [ ] **Step 2: Add STATE PD-PROMOTE-FIX (conflict resolver dispatch)**

After STATE D, add:

```
### STATE PD-PROMOTE-FIX — resolve a promotion conflict

Reached when the merger reports `promote conflict`. ONE assistant message:

1. Dispatch a resolver (no team):
   ```
   Agent({
     subagent_type: "developer",
     description: "Resolve session->main promotion conflict",
     prompt: "ROLE: promotion-conflict-resolver (gated /app exception)\nSESSION_SHORT_ID: <id>\nUnder the lock, in /app on main, re-run `git merge --no-ff session/<id>`, resolve the conflict honouring BOTH sides, then `git add` + `git commit` the merge. Run: cd /app && flock /app/.promote.lock bash -c 'git merge --no-ff session/<id> || true'. Resolve files, git add, git commit. Output: RESOLVED: commit=<sha> or FAILED: <reason>. Touch nothing under session/<id>."
   })
   ```
2. One text line: *"Synchronising your changes…"*

**End this turn.** → On `RESOLVED` next turn: continue to STATE D shutdown then POST-DEV. On `FAILED`: non-technical "hit a snag" + stop.
```

- [ ] **Step 3: Update SIMPLE STATE S-MERGE note**

In STATE S-MERGE, add a sentence: "The SIMPLE merger does Stage A then PROMOTION (Stage B) in one shot, so its `DONE` sha is the promotion commit. No separate promote handshake is needed for SIMPLE."

- [ ] **Step 4: Add the resolver worktree-scope exception note**

Add to the "NEVER DO" / exceptions area: "✅ Exception: a `promotion-conflict-resolver` developer may `git add`/`git commit` a merge resolution directly in `/app` on main, under `/app/.promote.lock`. This is the only case a developer touches `/app`."

- [ ] **Step 5: Verify anchors present**

Run: `grep -n "promote: session=\|PD-PROMOTE-FIX\|promotion-conflict-resolver" claudeConfig/.claude/agents/chat-orchestrator.md`
Expected: all three anchors present.

- [ ] **Step 6: Commit**

```bash
git add claudeConfig/.claude/agents/chat-orchestrator.md
git commit -m "feat(topology): orchestrator promotes session->main and resolves promotion conflicts"
```

## Task 5: worktree-scope rule documents the topology + resolver exception

**Files:**
- Modify: `claudeConfig/.claude/rules/worktree-scope.md`

- [ ] **Step 1: Add a topology section**

After the "## Why" section, insert:

```
## Session-branch topology

Each session owns an integration branch `session/<SESSION_SHORT_ID>` (forked from main at session start) and a fixed anchor ref `session-base/<SESSION_SHORT_ID>`. Task worktrees fork from `session/<SESSION_SHORT_ID>`. The merger merges task branches into the session branch inside the dedicated `/app/worktrees/<SESSION_SHORT_ID>/_session` worktree, then promotes `session/<SESSION_SHORT_ID>` into main once per request under `/app/.promote.lock`.

- Developers rebase onto `session/<SESSION_SHORT_ID>`, never onto main/master.
- The `_session` worktree is the merger's; developers/reviewers never touch it.
- Only a `promotion-conflict-resolver` developer may edit `/app` on main, and only to resolve a `session->main` merge conflict under the lock.
```

- [ ] **Step 2: Verify**

Run: `grep -n "session-branch topology\|_session\|promotion-conflict-resolver" claudeConfig/.claude/rules/worktree-scope.md`
Expected: anchors present.

- [ ] **Step 3: Commit**

```bash
git add claudeConfig/.claude/rules/worktree-scope.md
git commit -m "docs(topology): document session-branch topology in worktree-scope rule"
```

## Task 6: cleanup-worktree leaves the session branch/ref/_session intact

**Files:**
- Modify: `claudeConfig/.claude/hooks/cleanup-worktree.sh`

- [ ] **Step 1: Read the current hook**

Run: `cat claudeConfig/.claude/hooks/cleanup-worktree.sh`
Confirm what it removes on merger SubagentStop (task worktrees/branches).

- [ ] **Step 2: Ensure it never removes the session branch, anchor, or `_session`**

Add a guard near the top of the removal logic:

```bash
# Never clean the session branch, its anchor, or the _session integration
# worktree here — they persist for the whole session and are torn down only
# when the session ends (or recreated by orphan-recovery).
case "${WORKTREE_PATH:-}" in
  */_session) echo "[cleanup-worktree] skip _session"; exit 0 ;;
esac
```

If the hook deletes branches by pattern, ensure the pattern excludes `session/*` and `session-base/*` (only `<SESSION_SHORT>/TASK-*` and `simple/<SESSION_SHORT>` are eligible).

- [ ] **Step 3: Syntax check + verify guard**

Run: `bash -n claudeConfig/.claude/hooks/cleanup-worktree.sh && grep -n "_session" claudeConfig/.claude/hooks/cleanup-worktree.sh`
Expected: no syntax error; guard present.

- [ ] **Step 4: Commit**

```bash
git add claudeConfig/.claude/hooks/cleanup-worktree.sh
git commit -m "fix(topology): cleanup-worktree preserves session branch/anchor/_session"
```

## Task 7: Phase 1 runtime smoke verification (CHECKPOINT — no code)

- [ ] **Step 1: Boot the demo container and run a COMPLEX request end-to-end**

Run: `docker compose --profile demo up -d` then drive one multi-file change through the chat UI (or `make claude`). 

- [ ] **Step 2: Verify the topology in the running container**

Run:
```bash
docker exec atomic-crm bash -lc 'cd /app && git worktree list && git branch --list "session/*" "session-base/*" && git log --oneline -5 main'
```
Expected: a `session/<id>` branch, a `session-base/<id>` ref, a `_session` worktree, and a `merge(session): <id>` commit on main after the request finished.

- [ ] **Step 3: Confirm the demo reflects the change and no work leaked onto main mid-wave**

Verify the feature is visible in the demo at :5173 and that main advanced only via the promotion merge (not per-ticket). If anything is off, fix the relevant Phase 1 task before starting Phase 2.

- [ ] **Step 4: Run the existing test suites**

Run: `cd chat-service && npm test` then `bash claudeConfig/.claude/hooks/test/setup-worktree.test.sh`
Expected: all green.

---

# PHASE 2 — Deferred migration generation

## Task 8: developer stops writing migrations

**Files:**
- Modify: `claudeConfig/.claude/agents/developer.md` (Environment + Supabase-migration flag sections, ~104-131)

- [ ] **Step 1: Replace the Environment section**

Find:

```
## Environment

Always produce the runtime artefacts the project needs:
- TypeScript types + fake-data generators (what the FakeRest demo serves).
- A SQL migration when the ticket flag `requires_supabase_migration: true`
  is set (see *Supabase-migration flag* below).

Never run `supabase` CLI commands yourself. The orchestrator promotes and
applies migrations after the user explicitly agrees.
```

Replace with:

```
## Environment

Always produce the runtime artefacts the project needs:
- TypeScript types + fake-data generators (what the FakeRest demo serves).

**Never write SQL migrations.** Migrations are generated on demand at deploy
time by a dedicated migration round (see the `writing-migrations` skill), not
during feature tickets. Never run `supabase` CLI commands. Never touch
`supabase/migrations*/`.
```

- [ ] **Step 2: Delete the entire "Supabase-migration flag on the ticket" section**

Delete from `## Supabase-migration flag on the ticket` through the end of the **View update rule** paragraph and the `If the planner's flag is wrong…` paragraph (the whole block ending just before `## File editing — HARD RULE`). The view-recreation knowledge now lives in the `writing-migrations` skill (Task 10).

- [ ] **Step 3: Verify removal**

Run: `grep -n "requires_supabase_migration\|migrations-pending\|migration" claudeConfig/.claude/agents/developer.md`
Expected: no remaining references to `requires_supabase_migration`, `migrations-pending`, or migration authoring.

- [ ] **Step 4: Commit**

```bash
git add claudeConfig/.claude/agents/developer.md
git commit -m "feat(migrations): developer no longer writes Supabase migrations"
```

## Task 9: planner drops the migration flag and migration tickets

**Files:**
- Modify: `claudeConfig/.claude/agents/planner.md`

- [ ] **Step 1: Remove the flag from the ticket format**

In the JSON ticket template, delete the line `"requires_supabase_migration": false,`.

- [ ] **Step 2: Remove the field semantics paragraph**

Delete the `**`requires_supabase_migration`**: set `true` when…` paragraph (lines ~112-118).

- [ ] **Step 3: Remove the "migrations are separate tickets" rule and the migration half of "what every data-shaped ticket must produce"**

- In Step 3 rules, delete: `- Supabase migrations are always separate tickets from UI components.`
- In SETUP_MODE specifics, change each `one ticket for the Supabase migration (requires_supabase_migration: true) + one ticket for the TypeScript types…` to a single ticket producing TypeScript types + components + routes (no migration ticket). Same for the `extend` and cleanup bullets — drop the `requires_supabase_migration: true` migration tickets; cleanup drops the table later via the deploy-time migration round.
- In "What every data-shaped ticket must produce", replace the migration bullet with: "Schema-shaped changes (new entity, new column, dropped table) still only produce TypeScript types + fake-data here; the SQL migration is derived later at deploy time."

- [ ] **Step 4: Verify removal**

Run: `grep -n "requires_supabase_migration\|migrations-pending\|migration ticket\|Supabase migration" claudeConfig/.claude/agents/planner.md`
Expected: no remaining migration-authoring references.

- [ ] **Step 5: Commit**

```bash
git add claudeConfig/.claude/agents/planner.md
git commit -m "feat(migrations): planner drops migration flag and migration tickets"
```

## Task 10: new `writing-migrations` skill

**Files:**
- Create: `claudeConfig/.claude/skills/writing-migrations/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `claudeConfig/.claude/skills/writing-migrations/SKILL.md`:

```markdown
---
name: writing-migrations
description: Generate Supabase SQL migrations at deploy time from the session branch diff. Used by simple-developer in the deploy-time migration round only.
---

# Writing Migrations (deploy-time round)

You are `simple-developer` in migration mode. Your worktree is
`/app/worktrees/<SESSION_SHORT_ID>/simple` on `simple/<SESSION_SHORT_ID>`,
forked from `session/<SESSION_SHORT_ID>`. Produce SQL migrations that make the
real Supabase schema match what this session's app expects — nothing more.

## 1. Compute the session's net change

```bash
cd <WORKTREE_PATH>
git diff session-base/<SESSION_SHORT_ID>..session/<SESSION_SHORT_ID>
```

This is the branch's full diff since creation. Do NOT use `git merge-base`
(it collapses after the first promotion). Do NOT diff against main (other
sessions pollute it).

## 2. Identify schema-relevant changes

From that diff, keep only changes that imply a database schema change:
- Entity TypeScript types (e.g. `src/**/types.ts`, resource type defs).
- Fake-data generators that add/remove fields.
- dataProvider resource registrations (new resource = new table).
Ignore CSS, component layout, copy, tests.

## 3. Compute the delta against what is already deployed

For each changed entity, compare the desired schema (from the TS types) with the
schema already in `supabase/migrations/` and `supabase/schemas/`. Emit ONLY the
incremental delta. Anything already represented in `supabase/migrations/` is
already deployed — do not re-emit it. If the net diff has no schema impact,
write **nothing** (a no-op deploy is valid) and report `NO_MIGRATION_NEEDED`.

## 4. Write idempotent SQL

Write to `supabase/migrations/<YYYYMMDDHHMMSS>_<SESSION_SHORT_ID>_migration_<slug>.sql`
(timestamp via `date -u +%Y%m%d%H%M%S`). Use `IF NOT EXISTS` / `IF EXISTS`,
correct column types matching the TS types, FKs, and RLS for new tables (RLS
enabled + policies, never `USING (true)`).

## 5. View-recreation rule (BLOCKING correctness)

When a migration adds or removes a column, check `supabase/schemas/03_views.sql`
for any view selecting from that table. Recreate it with `CREATE OR REPLACE
VIEW`, the new column appended at the **absolute end** of the SELECT list —
after all existing columns including computed AS aliases. PostgreSQL rejects any
ordinal shift (error 42P16). PostgREST queries the view, not the table — a
missing update makes the column invisible to the app.

## 6. Commit and hand off

Commit the SQL on `simple/<SESSION_SHORT_ID>`. Stop. SubagentStop hooks
(typecheck/prettier/unit/e2e) run automatically. The orchestrator then sends you
to quality-reviewer (migration mode) and the merger.

For Postgres correctness you may load `Skill({skill: "supabase-postgres-best-practices"})`.
```

- [ ] **Step 2: Verify the skill is discoverable**

Run: `test -f claudeConfig/.claude/skills/writing-migrations/SKILL.md && grep -c "session-base/" claudeConfig/.claude/skills/writing-migrations/SKILL.md`
Expected: file exists; `session-base/` referenced (≥1).

- [ ] **Step 3: Commit**

```bash
git add claudeConfig/.claude/skills/writing-migrations/SKILL.md
git commit -m "feat(migrations): add writing-migrations skill for the deploy-time round"
```

## Task 11: quality-reviewer single-shot migration mode

**Files:**
- Modify: `claudeConfig/.claude/agents/quality-reviewer.md`

- [ ] **Step 1: Add a migration-mode section after "## Role"**

Insert:

```
## Migration mode (single-shot, no team)

When your spawn prompt contains `MODE: migration-review`, you are dispatched
standalone (no team, no `COUNTERPART`) to review SQL migration files written by
the deploy-time migration round. Do NOT idle for a "ready" message; review
immediately. Return a TEXT verdict (no `SendMessage`):

`Verdict: APPROVED` or `Verdict: BLOCKED` + the issues list (file/line/description/fix).

Migration checklist (BLOCKING):
- Idempotent (`IF [NOT] EXISTS`), no destructive change without intent.
- Column types/constraints/FKs match the TS types the migration is derived from.
- RLS enabled + real policies on every new table (never `USING (true)`).
- View-recreation rule respected (`03_views.sql`, new column at absolute end,
  error 42P16 avoided).
- No data loss on existing tables; reversible where feasible.

Files to review are listed in the spawn prompt. Read them in
`/app/worktrees/<SESSION_SHORT_ID>/simple/supabase/migrations/`.
```

- [ ] **Step 2: Verify**

Run: `grep -n "MODE: migration-review\|View-recreation rule respected" claudeConfig/.claude/agents/quality-reviewer.md`
Expected: anchors present.

- [ ] **Step 3: Commit**

```bash
git add claudeConfig/.claude/agents/quality-reviewer.md
git commit -m "feat(migrations): quality-reviewer single-shot migration-review mode"
```

## Task 12: member-idle-gate bypass for the migration reviewer

**Files:**
- Modify: `claudeConfig/.claude/hooks/member-idle-gate.sh`
- Test: `claudeConfig/.claude/hooks/test/member-idle-gate.test.sh` (new)

- [ ] **Step 1: Write the failing hook test**

Create `claudeConfig/.claude/hooks/test/member-idle-gate.test.sh`:

```bash
#!/bin/bash
# Tests the migration-review bypass for quality-reviewer.
set -u
HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/member-idle-gate.sh"
PASS=0; FAIL=0
export CHAT_SESSION_DIR="/tmp/logs/ab12cd34-xxxx"; mkdir -p "$CHAT_SESSION_DIR"
run() { # label expected_exit stdin
  echo "$3" | CLAUDE_AGENT_NAME="quality-reviewer" bash "$HOOK" >/dev/null 2>&1
  local e=$?
  if [ "$e" = "$2" ]; then echo "PASS — $1"; PASS=$((PASS+1)); else echo "FAIL — $1 (exp $2 got $e)"; FAIL=$((FAIL+1)); fi
}
# A quality-reviewer reading the migration worktree must be ALLOWED (exit 0):
run "migration-review on _simple worktree → allowed" 0 \
  '{"agent_type":"quality-reviewer","tool_input":{"command":"cat /app/worktrees/ab12cd34/simple/supabase/migrations/x.sql"}}'
# A plain quality-reviewer with no flag and no migration path stays BLOCKED (exit 2):
run "premature review, no flag, no migration path → blocked" 2 \
  '{"agent_type":"quality-reviewer","tool_input":{"command":"ls"}}'
echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" = "0" ]
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash claudeConfig/.claude/hooks/test/member-idle-gate.test.sh`
Expected: FAIL — the first case is currently blocked (no flag, no bypass).

- [ ] **Step 3: Add the bypass in the qr no-flag path**

In `member-idle-gate.sh`, inside the `if [ -z "$TASK_ID" ]` block (after the merger special-case, before the conservative `BLOCK-NOTASK`), add:

```bash
  # Migration-round reviewer bypass: a quality-reviewer operating on the
  # migration worktree (/worktrees/<SESSION_SHORT>/simple) is dispatched
  # sequentially AFTER the SQL is written — the empty-worktree race the gate
  # guards against cannot happen. Allow it.
  if [ "$GATE_TYPE" = "qr" ] && [ -n "$SESSION_SHORT" ]; then
    IS_MIG=$(node -e "
try { const i=JSON.parse(process.argv[1]||'{}');
  const s=JSON.stringify(i.tool_input||{});
  process.stdout.write(s.includes('/worktrees/${SESSION_SHORT}/simple') ? '1' : '');
} catch { process.stdout.write(''); }" "$STDIN" 2>/dev/null || echo "")
    if [ -n "$IS_MIG" ]; then
      echo "[$(date -Iseconds)] member-idle-gate PASS agent=$AGENT task=migration (migration-review bypass)" >> "$LOG" 2>/dev/null || true
      exit 0
    fi
  fi
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash claudeConfig/.claude/hooks/test/member-idle-gate.test.sh`
Expected: `PASS=2 FAIL=0`.

- [ ] **Step 5: Commit**

```bash
git add claudeConfig/.claude/hooks/member-idle-gate.sh claudeConfig/.claude/hooks/test/member-idle-gate.test.sh
git commit -m "feat(migrations): member-idle-gate bypass for the migration-round reviewer"
```

## Task 13: pending-deploys detects via session-branch diff

**Files:**
- Rewrite: `scripts/pending-deploys.mjs`
- Test: `chat-service/test/pending-deploys.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `chat-service/test/pending-deploys.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../../scripts/pending-deploys.mjs', import.meta.url).pathname;

function git(cwd, ...args) { return execFileSync('git', args, { cwd }).toString(); }

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pd-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t'); git(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'supabase/migrations'), { recursive: true });
  writeFileSync(join(dir, 'src/types.ts'), 'export type Contact = { id: string };\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'seed');
  git(dir, 'branch', 'session-base/ab12cd34', 'main');
  git(dir, 'branch', 'session/ab12cd34', 'main');
  return dir;
}

test('empty when session branch made no schema-relevant change', () => {
  const dir = setupRepo();
  const out = execFileSync('node', [SCRIPT, '--app', dir, '--session', 'ab12cd34']).toString().trim();
  assert.equal(out, '');
  rmSync(dir, { recursive: true, force: true });
});

test('non-empty when the session branch adds an entity field', () => {
  const dir = setupRepo();
  // advance the session branch with a schema-relevant change
  git(dir, 'checkout', '-q', 'session/ab12cd34');
  writeFileSync(join(dir, 'src/types.ts'), 'export type Contact = { id: string; priority: number };\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'add priority');
  git(dir, 'checkout', '-q', 'main');
  const out = execFileSync('node', [SCRIPT, '--app', dir, '--session', 'ab12cd34']).toString().trim();
  assert.notEqual(out, '');
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd chat-service && node --test test/pending-deploys.test.js`
Expected: FAIL — current script takes `<TICKETS_DIR>` and reads ticket flags; it does not accept `--app/--session` or diff the branch.

- [ ] **Step 3: Rewrite the script**

Replace `scripts/pending-deploys.mjs` with:

```js
#!/usr/bin/env node
// pending-deploys — decide whether the session has schema-relevant changes
// not yet covered by supabase/migrations/.
//
//   pending-deploys --app <APP_DIR> --session <SESSION_SHORT>
//
// Prints a non-empty marker (the changed schema-relevant paths) when a deploy
// is worth offering; prints nothing otherwise. Exit code always 0.
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const get = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const APP = get('--app', '/app');
const SESSION = get('--session', '');
if (!SESSION) { process.stderr.write('--session <SESSION_SHORT> required\n'); process.exit(0); }

// Schema-relevant path heuristic: entity types, fake-data generators, resource
// registrations. Tune the globs to the real repo layout.
const SCHEMA_RE = /(types?\.ts$|dataProvider|fake|resources?\/.*\.(ts|tsx)$)/i;

let changed = '';
try {
  changed = execFileSync('git', [
    '-C', APP, 'diff', '--name-only',
    `session-base/${SESSION}..session/${SESSION}`,
  ]).toString();
} catch { process.exit(0); }

const relevant = changed.split('\n').filter(Boolean).filter((p) => SCHEMA_RE.test(p));
// (Idempotency against already-applied schema is enforced later by the
// migration round, which cross-checks supabase/migrations/ and may no-op.)
if (relevant.length) console.log(relevant.join('\n'));
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd chat-service && node --test test/pending-deploys.test.js`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/pending-deploys.mjs chat-service/test/pending-deploys.test.js
git commit -m "feat(migrations): pending-deploys detects schema changes via session-branch diff"
```

## Task 14: apply-migrations applies only (no promotion phase)

**Files:**
- Modify: `scripts/apply-migrations.sh`

- [ ] **Step 1: Replace the argument contract and delete Phase 1 (promotion)**

Change the usage to `apply-migrations` (no args needed; the SQL is already on main after the migration round's merge). Delete the entire "Phase 1 — promote pending files" block (the `PROMOTED` loop, the `git mv`, the commit, and the strays check). Keep only Phase 2 (apply): start Supabase if not running, else `npx supabase migration up`, then reload the PostgREST schema cache.

- [ ] **Step 2: Update the header comment**

Replace the header to describe the new behavior: "Apply migrations already committed to `supabase/migrations/` on main. No promotion; the deploy-time migration round wrote and merged them."

- [ ] **Step 3: Syntax check**

Run: `bash -n scripts/apply-migrations.sh && grep -c "migrations-pending\|git mv" scripts/apply-migrations.sh`
Expected: no syntax error; `0` (no remaining promotion logic).

- [ ] **Step 4: Commit**

```bash
git add scripts/apply-migrations.sh
git commit -m "feat(migrations): apply-migrations applies only, no migrations-pending promotion"
```

## Task 15: orchestrator POST-DEV — satisfaction question + migration round

**Files:**
- Modify: `claudeConfig/.claude/agents/chat-orchestrator.md` (POST-DEV section + STATE machine)

- [ ] **Step 1: Replace STATE PD-ASK wording with the open satisfaction question**

Replace the PD-ASK text with (template, translated at runtime):

```
### STATE PD-ASK — open satisfaction question (every COMPLEX/SETUP request)

Always ask, in the user's language, plain words only — never mention database,
saving, migration, Supabase:
> *"Here are your changes — does everything look the way you want, or should I adjust something?"*

**End this turn.** → STATE PD-RESPOND on the next user turn.
```

- [ ] **Step 2: Replace STATE PD-RESPOND routing**

```
### STATE PD-RESPOND

| Meaning | Next |
|---|---|
| Wants to adjust / new request | Re-enter CLASSIFICATION (new request, accumulates on session/<id>); ask PD-ASK again after. |
| Satisfied (yes, perfect, looks good…) | Run `Bash("pending-deploys --app /app --session <SESSION_SHORT_ID>")`. Empty output → reply "Great, everything's set." and STATE DONE. Non-empty → emit "Saving your changes — this can take a moment." and enter STATE PD-MIG-DEV. |
| Ambiguous | Re-ask the open question once; stay in PD-RESPOND. |
```

- [ ] **Step 3: Add the migration round states**

```
### STATE PD-MIG-DEV — write the migration

Dispatch ONE simple-developer (no team) in migration mode:
```
Agent({ subagent_type: "simple-developer",
  description: "Generate migrations from session diff",
  prompt: "ROLE: simple-developer (MIGRATION MODE)\nSESSION_SHORT_ID: <id>\nWORKTREE_PATH: /app/worktrees/<id>/simple\nBRANCH_NAME: simple/<id>\nInvoke Skill({skill: \"writing-migrations\"}) and follow it. If no schema change, output NO_MIGRATION_NEEDED." })
```
One line: *"Saving your changes…"*. **End turn.** SubagentStop hooks run.
→ If the dev returned `NO_MIGRATION_NEEDED` → reply "Everything's set." → STATE DONE. Else → STATE PD-MIG-REVIEW.

### STATE PD-MIG-REVIEW — review the SQL

Dispatch ONE quality-reviewer (no team) with `MODE: migration-review` and the migration file paths. **End turn.**
→ `APPROVED` → STATE PD-MIG-MERGE. `BLOCKED` → re-dispatch simple-developer (PD-MIG-DEV) with the issues; loop.

### STATE PD-MIG-MERGE — merge + promote

Dispatch the SIMPLE merger for branch `simple/<id>` (does Stage A into session + promotion to main). **End turn.**
→ `DONE` → STATE PD-DEPLOY. `FAILED`/`promote conflict` → STATE PD-PROMOTE-FIX.

### STATE PD-DEPLOY — apply

One line: *"Applying your changes — this can take a moment on first run."*
`Bash("apply-migrations")` (timeout 240000 ms).
→ exit 0: demo mode → STATE PD-LIVE-ASK; full mode → STATE PD-DONE ("Your changes are saved."). Non-zero → PD-DONE with non-technical failure.
```

- [ ] **Step 4: Delete the old pending-migration/`.deploy-applied` detection and old PD-ASK deploy wording**

Remove the old `Bash("pending-deploys ${TICKETS_DIR}")` detection, the `.deploy-applied` read/write steps, and the "these changes affect how your data is stored" phrasing throughout POST-DEV. PD-LIVE-ASK / PD-LIVE-SWITCH / PD-DONE keep their existing non-technical wording.

- [ ] **Step 5: Verify**

Run: `grep -n "deploy-applied\|affect how your data is stored\|migrations-pending" claudeConfig/.claude/agents/chat-orchestrator.md`
Expected: no output.
Run: `grep -n "PD-MIG-DEV\|pending-deploys --app /app --session\|does everything look the way you want" claudeConfig/.claude/agents/chat-orchestrator.md`
Expected: all anchors present.

- [ ] **Step 6: Commit**

```bash
git add claudeConfig/.claude/agents/chat-orchestrator.md
git commit -m "feat(migrations): POST-DEV satisfaction question + deploy-time migration round"
```

## Task 16: cleanup references in CLAUDE.md and rules

**Files:**
- Modify: `CLAUDE.md`
- Modify: `claudeConfig/.claude/rules/validation-commands.md` (if it mentions migration-pending)

- [ ] **Step 1: Update CLAUDE.md gotchas and agent table**

- In the agent table, update the `developer` row to drop "+ SQL migration"; note migrations are deploy-time only.
- In Gotchas, remove any `migrations-pending` mention; add: "Migrations are generated at deploy time from `git diff session-base/<id>..session/<id>`; the developer never writes them."
- Add a one-line topology note: "Each session works on `session/<id>` (forked from main), promoted to main once per request under `/app/.promote.lock`."

- [ ] **Step 2: Grep the whole repo for stragglers**

Run: `grep -rn "requires_supabase_migration\|migrations-pending\|\.deploy-applied" claudeConfig CLAUDE.md scripts | grep -v docs/superpowers`
Expected: no output. Fix any remaining reference (rules, agents, scripts) inline.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md claudeConfig/.claude/rules/validation-commands.md
git commit -m "docs(migrations): update CLAUDE.md and rules for deferred migrations + session topology"
```

## Task 17: Phase 2 runtime smoke verification (CHECKPOINT — no code)

- [ ] **Step 1: Run unit + hook tests**

Run: `cd chat-service && npm test` then `bash claudeConfig/.claude/hooks/test/setup-worktree.test.sh` and `bash claudeConfig/.claude/hooks/test/member-idle-gate.test.sh`
Expected: all green.

- [ ] **Step 2: Demo-mode end-to-end with a schema change**

Boot `docker compose --profile full up -d` (Supabase needed to actually apply). Drive a request that adds a field to an entity. Verify:
- During dev, no SQL file is written (developer produced only types + fake-data).
- At end of dev, the satisfaction question appears (non-technical).
- On "yes", the migration round writes one SQL file, it passes review + merge, and `apply-migrations` applies it (column visible via PostgREST).

- [ ] **Step 3: Retake idempotency**

In the same session, change the field again, answer "yes" again. Verify the migration round emits only the new delta (or `NO_MIGRATION_NEEDED`), never re-creating the already-applied column.

- [ ] **Step 4: No-schema-change path**

Make a pure cosmetic change; answer "yes". Verify the flow ends with "everything's set" and runs no migration.

---

## Self-Review

**Spec coverage** (each spec component → task):
- 1A setup-worktree branch/anchor/`_session` → Task 1. 1A-bis rebase → Task 2. 1B merger two-stage → Task 3. 1C orchestrator promotion → Task 4. 1D worktree-scope → Task 5. 1E teardown → Task 6. 1F concurrency (worktree/lock/resolver) → Tasks 1, 3, 4. 
- 2A developer no migrations → Task 8. 2B planner → Task 9. 2C writing-migrations skill → Task 10. 2D quality-reviewer → Task 11. 2D-bis member-idle-gate → Task 12. 2E POST-DEV → Task 15. 2F apply-migrations → Task 14. 2G pending-deploys → Task 13. 2H cleanup → Task 16.
- Runtime validation → Tasks 7, 17.

**Open spec details deferred to execution** (flagged in spec, decided here):
- Conflict resolver = `developer` agent, gated `/app` exception (Task 4).
- Schema-relevant globs = the `SCHEMA_RE` regex in pending-deploys + the prose list in the skill (Tasks 13, 10) — tune against the real repo in Task 17.
- Promotion lock = `/app/.promote.lock` via `flock` (Task 3).
- App.tsx variant: the promotion block keeps `git reset --hard HEAD && apply-app-variant.sh` before merging (Task 3) — verified in Task 7.

**Placeholder scan:** no "TBD/handle appropriately"; every edit shows exact old/new text or full code.

**Naming consistency:** `session/<id>`, `session-base/<id>`, `_session`, `/app/.promote.lock`, `MODE: migration-review`, `NO_MIGRATION_NEEDED`, `pending-deploys --app … --session …` used consistently across tasks.
```
