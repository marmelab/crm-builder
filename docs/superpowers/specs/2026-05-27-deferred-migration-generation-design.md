# Deferred Migration Generation (on a Session-Branch Topology) — Design

Date: 2026-05-27
Branch: fix/Supabasemode

## Problem

Today the `developer` writes a Supabase SQL migration into
`supabase/migrations-pending/` during the ticket that touches the schema
(driven by the planner's `requires_supabase_migration` flag). The orchestrator
later promotes and applies those files when the user agrees to deploy.

This forces migration authoring on the *first* pass of every schema-shaped
feature. In a demo-first workflow the user iterates several times in FakeRest
before settling on a design — each retake re-writes migrations or leaves stale
pending files describing abandoned intentions (e.g. a "priority on companies"
field the user later dropped). Migrations are friction on every iteration, and
the ticket flags drift out of sync with what was actually built.

Determining "what this session actually changed" is also unreliable today:
every ticket merges straight into `main`, so on a shared `/app` the history is a
soup of whatever work has landed.

## Goal

1. The user iterates freely in demo mode. SQL migrations are generated **once**,
   **on demand**, only when the user is satisfied — and they reflect the
   **actual final state** of the session's work.
2. "What this session changed" is isolated **by construction**, so the migration
   diff can never pick up another session's work.

## Two parts

- **Part 1 — Session-branch git topology.** A per-session integration branch
  makes each session's contribution a clean, isolated unit. This is a core
  change to the team workflow (affects COMPLEX, SETUP, SIMPLE).
- **Part 2 — Deferred migration generation.** Built on Part 1: at "the user is
  satisfied", a migration round derives SQL from the session branch.

---

# Part 1 — Session-branch git topology

## Branches

| Branch | Forked from | Purpose |
|---|---|---|
| `session/<SESSION_SHORT_ID>` | `main` at session start | Per-session integration accumulator. |
| `<SESSION_SHORT_ID>/<TASK_ID>` | `session/<id>` | One ticket's work (COMPLEX). |
| `simple/<SESSION_SHORT_ID>` | `session/<id>` | SIMPLE / migration-round work. |

## Lifecycle

1. **Session start (first dev dispatch).** Create `session/<id>` from `main` if
   it does not exist.
2. **Per task.** Worktree + task branch forked from `session/<id>`. Developer
   commits on the task branch.
3. **Task done.** Merger merges the task branch **into `session/<id>`** (not
   main). All tickets across all waves of a request accumulate here; wave-2
   tasks fork from `session/<id>` and so naturally see wave-1's merges.
4. **Request done (last wave merged).** Merger **promotes**: `git merge --no-ff
   session/<id>` into `main`. `/app` (on main) now reflects the whole request,
   so the demo shows it. No per-promotion SHA is recorded.
5. **Satisfaction question** (Part 2). If the user wants to adjust, the next
   request's tasks fork from `session/<id>` again (it persists and keeps
   advancing); another promotion follows. If satisfied, the migration round
   runs.

`/app` stays checked out on `main` throughout — the merger keeps doing
`git reset --hard HEAD && apply-app-variant.sh` on `/app`. "Switching back to
`session/<id>`" means *new task work integrates there again*; it is not a
checkout of `/app`.

## Components (Part 1)

### 1A. `setup-worktree.sh` (modify)

- Before creating a task worktree, ensure the session branch **and** its
  fork-anchor ref exist (both created from the same base, only once):
  ```
  git -C /app show-ref --verify --quiet refs/heads/session/<SESSION_SHORT> || {
    git -C /app branch session/<SESSION_SHORT>      <base>   # accumulator (advances)
    git -C /app branch session-base/<SESSION_SHORT> <base>   # fork anchor (never moves)
    git -C /app worktree add /app/worktrees/<SESSION_SHORT>/_session session/<SESSION_SHORT>
  }
  ```
  (use the dynamically detected base, main/master). The `_session` worktree is
  the integration checkout where task→session merges happen, so `/app` can stay
  on main for the demo (see 1F).
- The diff baseline for migrations is the **anchor ref**, not `git merge-base`:
  after the first promotion the merge-base of main and the session branch
  collapses onto the session tip (the session becomes an ancestor of main's
  merge commit), yielding an empty diff. The anchor ref stays correct across
  any number of promotions and is robust to other sessions merging into main
  (the diff `session-base/<id>..session/<id>` never references main).
- Create the task worktree branched from `session/<SESSION_SHORT>` instead of
  `HEAD`. COMPLEX: `<SESSION_SHORT>/<TASK_ID>`. SIMPLE/migration:
  `simple/<SESSION_SHORT>`.
- The existing orphan-recovery logic is preserved.

### 1A-bis. `developer.md` rebase target (modify) — keeps the branch pure

The developer currently rebases onto `origin/master` (workflow steps 3 and 7).
The branch's isolation guarantee depends on `session/<id>` receiving **only**
this session's work, so tasks must rebase onto **`session/<id>`**, not master —
otherwise a task would pull another session's main work into the session branch
and contaminate the diff. Change both rebase steps to target the session branch.

### 1B. `merger.md` (modify) — two stages

- **Stage A — task merge (per task).** In the `_session` integration worktree:
  `cd /app/worktrees/<SESSION_SHORT>/_session && git merge --no-ff <task branch>`
  → merges the task into `session/<id>`. `/app` (main) is not touched. COMPLEX:
  loop over developer messages as today; merge target is the session worktree.
  Update ticket status as today. On conflict: abort + report (developer's job).
- **Stage B — promotion (end of request).** On a promotion instruction from the
  orchestrator (`SendMessage(merger, "promote: session=<id>")`): in `/app` (on
  main), **under the promotion lock** (1F), `git merge --no-ff session/<id>`,
  then report `promoted: session=<id>, commit=<sha>` or `promote conflict:
  files=[...]`. SIMPLE single-shot: Stage A (in `_session`) then Stage B.
- The merger still never does `git add`/`git commit` and writes no files. On a
  promote conflict it aborts the merge and reports — it does **not** resolve.

### 1C. `chat-orchestrator.md` (modify) — promotion step

- After a request's final wave teardown (STATE D, last wave), before POST-DEV:
  send the merger the **promote** instruction and wait.
  - `promoted: …` → run the satisfaction question.
  - `promote conflict: …` → emit a non-technical "syncing changes" line and
    dispatch a **conflict resolver** (1F). On resolver success → satisfaction
    question. On resolver failure → non-technical "hit a snag" + stop.
- SIMPLE: the single-shot merger already does Stage A + B.

### 1D. `worktree-scope.md` + rules (modify)

- Document the new fork source (`session/<id>`), the `_session` integration
  worktree as the task-merge target, and that the session branch is promoted to
  main once per request under the promotion lock.

### 1E. Session branch teardown

- `session/<id>`, `session-base/<id>`, and the `_session` worktree persist for
  the session's lifetime (accumulator + anchor + integration checkout). All
  cleaned up when the session is torn down; leftovers are harmless and
  re-created from base by orphan-recovery on the next session with the same
  short id.

### 1F. Same-container concurrency (multiple sessions share main)

Multiple sessions can run in one container, each with its own merger, all
promoting into the same `main`. Three mechanisms:

1. **Integration worktree (per session).** Task→session merges run in
   `/app/worktrees/<SESSION_SHORT>/_session` (checked out on `session/<id>`), so
   `/app` stays on main for the single Vite demo and sessions never fight over
   `/app`'s checkout. Distinct worktrees/branches → task merges of different
   sessions don't contend.
2. **Promotion lock.** All promotions target the one `/app` main worktree, so
   they must serialize. Wrap the Stage-B merge in a container-global `flock`
   (e.g. `/app/.promote.lock`): one session promotes at a time, preventing
   `.git/index.lock` corruption.
3. **Conflict resolver.** Two sessions touching the same lines make the
   `session→main` merge conflict. The merger aborts + reports; the orchestrator
   dispatches a **developer-type resolver** that, under the promotion lock and in
   `/app` on main (an explicit, gated exception to worktree-scope), re-runs the
   merge, resolves the conflict honoring both sides, `git add` + `git commit`s
   the merge, and reports. `session/<id>` is never modified, so the migration
   diff stays pure. (Resolver agent + model: open detail.)

The migration feature (Part 2) is unaffected by all of this: promotion merges
the session branch **into** main and never modifies the session branch, so
`session-base/<id>..session/<id>` remains exact even under concurrent
promotions and conflict resolution.

---

# Part 2 — Deferred migration generation

## Decisions (settled with the maintainer)

1. **Scope** — the `developer` never writes migrations, in demo *or* full mode.
2. **Producer** — at deploy time, the `simple-developer` agent runs a dedicated
   "migration mode" (new skill), then `quality-reviewer` (aware it reviews SQL),
   then `merger`. The `simple-developer` SubagentStop test hooks run after it
   stops.
3. **Source of truth** — the **session branch** (`session/<id>`), not ticket
   flags. The diff against its fork point gives this session's net work,
   isolated by construction.
4. **Idempotency** — the migration writer cross-checks the schema already in
   `supabase/migrations/`; anything already deployed is not re-emitted. The
   round may legitimately produce zero migrations.
5. **Staging folder** — `supabase/migrations-pending/` is removed. The round
   writes straight to `supabase/migrations/`; `apply-migrations.sh` is
   simplified (no `git mv` promotion, just apply).
6. **`requires_supabase_migration`** — removed entirely (planner, developer,
   rules, scripts, CLAUDE.md). No inert metadata kept.
7. **End-of-dev message** — the technical deploy offer is gone. At the end of
   every COMPLEX/SETUP request the orchestrator asks an **open, non-technical
   satisfaction question** ("Here are your changes — does everything look the
   way you want, or should I adjust something?"). On an affirmative reply a
   second non-technical message signals saving ("Saving your changes — this can
   take a moment") and the migration round runs behind it. The words database,
   migration, deploy, Supabase are never shown.
8. **Concurrency** — same-container multi-session is in scope (each session has
   its own merger, all promoting into one shared main). Handled in Part 1 (1F):
   integration worktree, promotion lock, auto conflict resolver. The migration
   diff is unaffected because promotion never modifies the session branch.

## Flow (Part 2)

```
Request's final wave promoted to main (Part 1); demo reflects it.
        │
        ▼
STATE PD-ASK  → open, non-technical satisfaction question (always).
        │
        ├─ adjust / new request → re-enter CLASSIFICATION (new request,
        │                          accumulates on session/<id>), then ask again
        │
        └─ satisfied
                │
                ▼
        detection: pending-deploys — does session/<id> carry schema-relevant
        changes not yet covered by supabase/migrations/ ?
                │
                ├─ no  → "Great, everything's set." → DONE
                │
                └─ yes → "Saving your changes — this can take a moment." then:
        ▼
╔════════════════════ MIGRATION ROUND ══════════════════════════╗
║ 1. simple-developer (migration mode, skill: writing-migrations) ║
║      worktree from session/<id>                                 ║
║      - diff session/<id> against its fork point (schema files)  ║
║      - compare desired schema (TS types) vs supabase/migrations ║
║      - write incremental SQL to supabase/migrations/, commit    ║
║      → SubagentStop hooks run (typecheck/prettier/unit/e2e)     ║
║ 2. quality-reviewer (migration mode, single-shot)               ║
║      reviews SQL: idempotency, types/constraints, FK, RLS,      ║
║      view-recreation rule, no data loss, reversibility          ║
║      BLOCKED → back to 1 ; APPROVED → 3                         ║
║ 3. merger → task branch → session/<id> → promote to main        ║
╚════════════════════════════════════════════════════════════════╝
        │
        ▼
STATE PD-DEPLOY → apply-migrations (supabase migration up)
        │
        ▼
demo mode → PD-LIVE-ASK ("Want to see your real data in the app now?")
full mode → PD-DONE ("Your changes are saved.")
```

Migration round is orchestrator-sequenced and team-free (mirrors SIMPLE with a
review step). It can produce zero files even after a non-empty `pending-deploys`
(a change the schema already covers) → skip apply, go to "everything's set". All
POST-DEV strings stay non-technical. SIMPLE (single cosmetic) keeps its current
terminal report — it cannot touch the schema. (Open: whether to also append the
satisfaction question to SIMPLE; default no.)

## Components (Part 2)

### 2A. `developer.md` (modify)

- Remove the *Supabase-migration flag* section and all
  `supabase/migrations-pending/` writing. Remove `requires_supabase_migration`.
- The *view-update rule* knowledge moves into the migration skill.
- Data deliverable is now: TypeScript types + fake-data generators only.

### 2B. `planner.md` (modify)

- Remove `requires_supabase_migration` from the ticket format, field semantics,
  and "what every data-shaped ticket must produce". Drop the rule "Supabase
  migrations are always separate tickets". Schema-shaped changes fold into the
  feature ticket (types + fake-data).

### 2C. New skill `writing-migrations`

Guides `simple-developer` in migration mode:
1. `git diff session-base/<SESSION_SHORT>..session/<SESSION_SHORT>` — the
   branch's full diff since creation (do NOT use `git merge-base` — it breaks
   after the first promotion; do NOT diff against main — other sessions pollute
   it).
2. From that diff, identify schema-relevant changes (TS entity types, fake-data
   generators, dataProvider resource configs).
3. For each changed entity, compare the desired schema (TS types) against the
   schema already in `supabase/migrations/` + `supabase/schemas/`; emit only the
   incremental delta.
4. Write idempotent, correctly-typed SQL to `supabase/migrations/` with the
   timestamped naming convention.
5. Apply the **view-recreation rule** (new/removed column → `CREATE OR REPLACE
   VIEW`, column appended at the absolute end of the SELECT list; PostgreSQL
   rejects ordinal shifts, error 42P16).
6. Zero files when the net diff has no schema impact (no-op is valid).

May load `supabase` / `supabase-postgres-best-practices` for SQL correctness.

### 2D. `quality-reviewer.md` (modify)

Add a single-shot migration-review mode (mirrors the merger's SIMPLE mode):
dispatched standalone (no team), receives the migration file paths + a
migration-specific checklist, returns a text verdict (APPROVED / BLOCKED +
issues). No `SendMessage`. **No new redundant agent** — the same
`quality-reviewer` is reused.

### 2D-bis. `member-idle-gate.sh` (modify)

The gate blocks any `quality-reviewer*` until a `/tmp/notified-qr-…` flag exists
(written by `validate-before-review` on a developer's "ready for review"). In
the team-free migration round no such flag is written, so the reviewer would be
blocked. Add a bypass mirroring the existing SIMPLE-merger bypass: when a
`quality-reviewer` operates on the migration worktree
(`/worktrees/<SESSION_SHORT>/simple`), pass. This is correct, not a hack — the
gate exists to stop a reviewer dispatched *concurrently* with a developer from
reviewing an empty worktree; in the sequential migration round the SQL is
already written and merged before the reviewer runs.

### 2E. `chat-orchestrator.md` (modify) — POST-DEV

- STATE PD-ASK: open satisfaction question at end of every COMPLEX/SETUP
  request (no longer gated on a pending-migration detection).
- STATE PD-RESPOND: adjust → re-classify; affirmative → run `pending-deploys`,
  empty → acknowledge + DONE, non-empty → "saving" message + migration round;
  ambiguous → re-ask.
- Migration round states PD-MIG-DEV → PD-MIG-REVIEW (loop on BLOCKED) →
  PD-MIG-MERGE (task→session→promote), then PD-DEPLOY (apply), then PD-LIVE-ASK
  (demo) / PD-DONE (full).

### 2F. `apply-migrations.sh` (simplify)

Drop the promotion phase (`git mv` from migrations-pending). The migration file
is already in `supabase/migrations/` on main after the merge. Keep: start
Supabase if needed, `supabase migration up`, reload PostgREST schema cache.

### 2G. `pending-deploys.mjs` (rework)

Replace flag-based detection with a session-branch diff check: does
`session-base/<id>..session/<id>` touch schema-relevant paths whose delta is not
yet in `supabase/migrations/`? Output non-empty when a deploy is worth offering.

### 2H. Cleanup

- Remove `supabase/migrations-pending/` references (agents, rules, scripts,
  CLAUDE.md).
- Remove every `requires_supabase_migration` reference.
- Update CLAUDE.md (runtime/topology section, gotchas) and rule files
  (worktree-scope, validation-commands) for the new topology and wording.

---

## Resolved since first draft

- **No SHA ledger.** Per-promotion merge SHAs are not recorded — the migration
  diff is the branch's full diff since creation
  (`git diff session-base/<id>..session/<id>`), anchored by a git ref set at
  branch creation. Robust to other sessions merging into main, since main is
  never referenced. Requires tasks to rebase onto `session/<id>` (not master)
  so the branch stays pure (component 1A-bis).
- **No new reviewer agent.** Reuse `quality-reviewer` single-shot + a targeted
  `member-idle-gate` bypass (component 2D-bis).
- **`.deploy-applied` removed.** Idempotency now comes from cross-checking
  `supabase/migrations/`; the ledger is redundant and dropped.

## Open implementation details (resolve in the plan)

- **Promotion trigger mechanics:** exact orchestrator↔merger handshake to
  promote `session/<id>` → main after the request's last wave, given the merger
  is normally being torn down at that point (STATE D).
- **Conflict resolver agent:** which agent type/model resolves a `session→main`
  promotion conflict in `/app` (developer/opus vs simple-developer/sonnet), and
  the gated worktree-scope exception that lets it edit `/app` on main.
- **Promotion lock scope:** confirm a single container-global lock
  (`/app/.promote.lock` via `flock`) is sufficient and does not deadlock with
  the per-session mergers' own `.git/index.lock` retries.
- **Schema-relevant file heuristic** in `writing-migrations` / `pending-deploys`:
  pin the exact globs under `src/` that imply a schema change (entity types,
  fake-data generators, dataProvider resource configs) against the real CRM repo
  layout.
- **App.tsx variant interaction:** confirm the `git reset --hard HEAD +
  apply-app-variant.sh` dance behaves under the new promote-to-main step (no
  App.tsx conflict, correct variant after promotion).
- **Anchor-ref capture point:** confirm the first `setup-worktree` of every
  flow (COMPLEX wave, SETUP planner-driven wave, SIMPLE) creates
  `session/<id>` + `session-base/<id>` before any merge.

## Non-goals

- No change to the demo (FakeRest) runtime behavior.
- No change to how features are implemented inside a ticket (only migration
  authoring is removed and the merge target changes).
- No automatic deploy — the user still explicitly opts in via the satisfaction
  question.
```
