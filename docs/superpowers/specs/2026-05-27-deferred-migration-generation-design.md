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
   **removed entirely** from the ticket schema, planner, developer, and scripts
   (no inert metadata kept).
7. **End-of-dev message** — the old technical offer ("these changes affect how
   your data is stored, want to deploy?") is removed. At the end of every dev
   cycle the orchestrator asks an **open, non-technical satisfaction question**
   (e.g. "Here are your changes — does everything look the way you want, or
   should I adjust something?"). On an affirmative reply, a second non-technical
   message signals that the work is being saved ("Saving your changes — this can
   take a moment"), and the migration round runs behind it. The words
   "database", "migration", "deploy", "Supabase" are never shown to the user.
8. **Concurrency boundary** — the clean isolation boundary is the **container**.
   One container = one `/app` volume = one git history = one Vite. Parallel work
   is run as separate containers (the altports pattern), each with an independent
   baseline, so `git diff <baseline>..HEAD` never sees another container's
   merges. Multiple chat sessions inside a *single* container share main by
   design (shared app, shared App.tsx variant) and are therefore not isolated —
   this is out of scope and not a supported parallel model.

## Flow

```
Regular dev waves (COMPLEX / SETUP)
   developer / simple-developer produce ONLY TypeScript types + fake-data.
   No SQL migration is ever written here.
        │
        ▼
STATE PD-ASK  → open, non-technical satisfaction question, always asked at
                end of dev:
                "Here are your changes — does everything look the way you
                 want, or should I adjust something?"
        │
        ├─ user wants to adjust / new request → re-enter CLASSIFICATION
        │                                        (new wave), then ask again
        │
        └─ user is satisfied
                │
                ▼
        detection: pending-deploys — does the session diff touch
        schema-relevant files not yet covered by supabase/migrations/ ?
                │
                ├─ no  → "Great, everything's set." → DONE
                │
                └─ yes → non-technical "Saving your changes — this can take a
                         moment." then:
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
demo mode → PD-LIVE-ASK ("Want to see your real data in the app now?")
full mode → PD-DONE ("Your changes are saved.")
```

SIMPLE (single cosmetic) keeps its current terminal report — it cannot touch
the schema, so there is nothing to persist. (Open: whether to also append the
satisfaction question there; default is no.)

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
- **Remove `requires_supabase_migration` entirely** from the ticket format,
  field semantics, and the "what every data-shaped ticket must produce"
  section. Schema-shaped changes fold into the feature ticket (types +
  fake-data). No migration tickets, no migration flag.

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

Rework POST-DEV around the open satisfaction question:
- **STATE PD-ASK** — no longer gated on a pending-migration detection. At the
  end of every COMPLEX/SETUP dev cycle, ask the open, non-technical satisfaction
  question. No technical words.
- **STATE PD-RESPOND**:
  - Adjustment / new request → re-enter CLASSIFICATION (new wave); POST-DEV
    asks the satisfaction question again afterward.
  - Affirmative → run `pending-deploys`. Empty → acknowledge ("everything's
    set") and DONE. Non-empty → emit the non-technical "saving your changes"
    message and enter the migration round.
  - Ambiguous → re-ask the open question.
- **Migration round states** (only when there is something to persist):
  - PD-MIG-DEV — dispatch simple-developer (migration mode).
  - PD-MIG-REVIEW — dispatch quality-reviewer (migration mode); loop to
    PD-MIG-DEV on BLOCKED.
  - PD-MIG-MERGE — dispatch merger (SIMPLE mode).
- **STATE PD-DEPLOY** — the (simplified) apply step, then PD-LIVE-ASK (demo) /
  PD-DONE (full).

The migration round derives content from the diff, so it can legitimately
produce zero files even after a non-empty `pending-deploys` (e.g. a change the
schema already covers). In that case skip the apply and go to "everything's
set". All POST-DEV user-facing strings stay non-technical.

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
- Remove every `requires_supabase_migration` reference (planner, developer,
  worktree-scope rule, pending-deploys, CLAUDE.md).
- Update CLAUDE.md and any rule files (e.g. worktree-scope, validation-commands)
  that mention the old migration-writing behavior or the old deploy-offer
  wording.

## Open implementation details (resolve in the plan)

- Exact dispatch identity for the quality-reviewer single-shot so that
  `member-idle-gate` does not block a team-less reviewer.
- The precise heuristic in `writing-migrations` / `pending-deploys` for
  "schema-relevant files" (which globs under `src/` count).
- Whether `.session-base` should also be captured for the SETUP path (planner
  dispatch) — confirm the first `setup-worktree` of a SETUP session fires before
  any merge.
- `.deploy-applied` ledger: with detection now diff-based and idempotency from
  cross-checking `supabase/migrations/`, decide whether the ledger is still
  needed or can be dropped.

## Non-goals

- No change to the demo (FakeRest) runtime behavior.
- No change to how COMPLEX waves implement features (only the removal of
  migration authoring from them).
- No automatic deploy — the user still explicitly opts in.
```
