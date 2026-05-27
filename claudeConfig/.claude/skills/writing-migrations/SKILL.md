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
