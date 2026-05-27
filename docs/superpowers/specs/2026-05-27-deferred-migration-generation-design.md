# Deferred Migration Generation — Design

Date: 2026-05-27
Branch: fix/Supabasemode

## Problem

Today the `developer` agent writes a Supabase SQL migration into
`supabase/migrations-pending/` during the ticket that touches the schema
(driven by the planner's `requires_supabase_migration: true` flag). The
orchestrator later promotes and applies those files when the user agrees to
deploy (POST-DEV flow).

This forces migration authoring on the *first* pass of every schema-shaped
feature. In a demo-first workflow the user iterates several times in FakeRest
mode before settling on a design — and each retake either re-writes migrations
or leaves stale pending files describing abandoned intentions (e.g. a
"priority on companies" field the user later dropped in favor of something
else). Migrations are friction on every iteration and the ticket flags drift
out of sync with what was actually built.

## Goal

The user iterates freely in demo mode. SQL migrations are generated **once**,
**on demand**, only when the user decides to deploy to the real database — and
they reflect the **actual final state** of the session's work, not the
sequence of intentions captured in ticket flags.

## Principle

TypeScript types + fake-data generators are the source of truth for the schema
throughout the demo cycle. The `developer` never writes SQL migrations. At
deploy time, a dedicated migration round derives the SQL from the **git diff of
all merges performed in the session**, cross-checked against the schema already
present in `supabase/migrations/`.

## Decisions (settled with the maintainer)

1. **Scope** — the `developer` never writes migrations, in demo *or* full mode.
   Migrations are produced only in the deploy-time migration round.
2. **Producer** — the migration round reuses the existing `simple-developer`
   agent in a dedicated "migration mode" (driven by a new skill), then passes
   through `quality-reviewer` (aware it is reviewing SQL), then `merger`. The
   `simple-developer` SubagentStop test hooks must run after it stops.
3. **Source of truth** — `git diff` of all merges in the session, *not* the
   ticket flags (which go stale across retakes).
4. **Baseline** — diff against the session start. The session baseline commit
   is recorded automatically at the first dev dispatch; the round diffs
   `<baseline>..HEAD`. Idempotency across repeated deploys in one session comes
   from cross-checking the schema already present in `supabase/migrations/` —
   anything already deployed is not re-emitted; the round may legitimately
   produce zero migrations.
5. **Staging folder** — `supabase/migrations-pending/` is removed. The round
   writes straight to `supabase/migrations/`; `apply-migrations.sh` is
   simplified (no `git mv` promotion, just apply).
6. **Deploy detection** — `pending-deploys` switches to a git-diff check (does
   the session's merged work touch schema-relevant files not yet covered by
   `supabase/migrations/`?). The `requires_supabase_migration` ticket flag is
   no longer used for this.

## Flow

```
Regular dev waves (COMPLEX / SIMPLE / SETUP)
   developer / simple-developer produce ONLY TypeScript types + fake-data.
   No SQL migration is ever written here.
        │
        ▼
POST-DEV detection (STATE PD)
   pending-deploys: does the session diff touch schema-relevant files
   not yet covered by supabase/migrations/ ?
        │  yes
        ▼
STATE PD-ASK  → "Some of these changes affect how your data is stored.
                 Want me to apply them to your real database now?"
        │  user agrees
        ▼
╔════════════════════ MIGRATION ROUND (new) ════════════════════╗
║ 1. simple-developer (migration mode, skill: writing-migrations) ║
║      - reads the session baseline                               ║
║      - git diff <baseline>..HEAD                                ║
║      - identifies net schema-relevant changes                   ║
║      - cross-references existing supabase/migrations + schemas  ║
║      - writes SQL to supabase/migrations/ in its worktree       ║
║      - commits, stops                                           ║
║      → SubagentStop hooks run (typecheck/prettier/unit/e2e)     ║
║ 2. quality-reviewer (migration mode, single-shot)               ║
║      - reviews SQL: idempotency, correct column types &         ║
║        constraints, FKs, RLS, view-recreation rule, no data     ║
║        loss, reversibility                                      ║
║      - returns verdict text                                     ║
║      - BLOCKED → back to step 1 with the issues                 ║
║      - APPROVED → step 3                                        ║
║ 3. merger (SIMPLE mode) → git merge --no-ff into main           ║
╚════════════════════════════════════════════════════════════════╝
        │
        ▼
STATE PD-DEPLOY → apply-migrations (supabase migration up)
        │
        ▼
record deployed state, then existing PD-LIVE-ASK / PD-DONE branches
```

The migration round is **orchestrator-sequenced and team-free**, mirroring the
SIMPLE flow (S-DEV → … → S-MERGE) with a review step inserted. No `TeamCreate`,
no inter-agent `SendMessage`; the orchestrator reads each agent's output and
dispatches the next.

## Components

### A. `developer.md` (modify)

- Remove the *Supabase-migration flag* section and all
  `supabase/migrations-pending/` writing.
- Remove the `requires_supabase_migration` "contract" language.
- Keep the *View update rule* knowledge in the new migration skill, not here.
- The developer's data deliverable is now: TypeScript types + fake-data
  generators only.

### B. `planner.md` (modify)

- Drop the rule "Supabase migrations are always separate tickets".
- Drop `requires_supabase_migration` as a content-driving flag. Schema-shaped
  changes fold into the feature ticket (types + fake-data).
- (The field may remain in the ticket JSON schema as inert metadata, but
  nothing reads it for migration authoring or deploy detection. Prefer removing
  it to avoid confusion — to be finalized in the plan.)

### C. New skill `writing-migrations`

Guides `simple-developer` in migration mode:
1. Locate the session baseline (see Baseline capture).
2. `git diff <baseline>..HEAD` and identify schema-relevant changes (TS entity
   types, fake-data generators, dataProvider resource configs).
3. For each changed entity, compare the desired schema (from TS types) against
   the schema already in `supabase/migrations/` + `supabase/schemas/`; emit
   only the incremental delta.
4. Write idempotent, correctly-typed SQL to `supabase/migrations/` with the
   timestamped naming convention.
5. Apply the **view-recreation rule** (new/removed column → `CREATE OR REPLACE
   VIEW` with the column appended at the absolute end of the SELECT list;
   PostgreSQL rejects ordinal shifts, error 42P16).
6. Produce zero files when the net diff has no schema impact (no-op is valid).

Consider loading the `supabase` / `supabase-postgres-best-practices` skills for
SQL correctness.

### D. Baseline capture — `setup-worktree.sh` (modify)

On the first dev dispatch of a session, record the base commit:

```
BASE_FILE="/app/worktrees/${SESSION_SHORT}/.session-base"
[ -f "$BASE_FILE" ] || git -C /app rev-parse HEAD > "$BASE_FILE"
```

Written before any merge happens, so it captures main's HEAD at session start.
Subsequent dispatches (including the migration round's) leave it untouched.

### E. Migration round worktree

The migration writer runs as the `simple-developer` agent and reuses the
SIMPLE worktree/branch (`/app/worktrees/<SESSION_SHORT>/simple`,
`simple/<SESSION_SHORT>`). The orchestrator runs flows sequentially, so there
is no concurrency with a real SIMPLE change; setup-worktree's existing
orphan-recovery handles any leftover branch. The `simple-developer` SubagentStop
matcher therefore fires unchanged.

### F. `quality-reviewer.md` (modify)

Add a single-shot migration-review mode (mirrors the merger's SIMPLE mode):
dispatched standalone (no team), receives the migration file paths and a
migration-specific checklist, returns a text verdict (APPROVED / BLOCKED +
issues). No `SendMessage`.

### G. `chat-orchestrator.md` (modify)

Insert the migration round into the POST-DEV deploy path. New states between
"user agreed to deploy" and the apply step:
- PD-MIG-DEV — dispatch simple-developer (migration mode).
- PD-MIG-REVIEW — dispatch quality-reviewer (migration mode); loop to PD-MIG-DEV
  on BLOCKED.
- PD-MIG-MERGE — dispatch merger (SIMPLE mode).
- then existing PD-DEPLOY runs the (simplified) apply step.

If the migration round produces zero files, skip straight to "already up to
date" without an apply.

### H. `apply-migrations.sh` (simplify)

Remove the promotion phase (`git mv` from migrations-pending). The migration
file is already in `supabase/migrations/` on main after the merge. Keep only:
start Supabase if needed, `supabase migration up`, reload PostgREST schema
cache.

### I. `pending-deploys.mjs` (rework)

Replace the flag-based detection with a git-diff check: using the session
baseline, determine whether the merged work touches schema-relevant paths whose
delta is not yet represented in `supabase/migrations/`. Output non-empty when a
deploy is worth offering.

### J. Cleanup

- Remove `supabase/migrations-pending/` references across agents, rules,
  scripts, CLAUDE.md.
- Update CLAUDE.md and any rule files (e.g. worktree-scope, validation-commands)
  that mention the old migration-writing behavior.

## Open implementation details (resolve in the plan)

- Exact dispatch identity for the quality-reviewer single-shot so that
  `member-idle-gate` does not block a team-less reviewer.
- Whether `requires_supabase_migration` is fully removed from the ticket schema
  or left inert.
- The precise heuristic in `writing-migrations` / `pending-deploys` for
  "schema-relevant files" (which globs under `src/` count).
- Whether `.session-base` should also be captured for the SETUP path (planner
  dispatch) — confirm the first `setup-worktree` of a SETUP session fires before
  any merge.

## Non-goals

- No change to the demo (FakeRest) runtime behavior.
- No change to how COMPLEX waves implement features (only the removal of
  migration authoring from them).
- No automatic deploy — the user still explicitly opts in.
```
