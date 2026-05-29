---
name: delete-resource
description: Complete checklist to remove a CRM resource (e.g. deals, contacts, companies, tasks) end-to-end — React-Admin resource registration, Supabase schema + migration, types, i18n, dashboard widgets, activity feed, cross-resource references, tests. Load when the user asks to "delete", "remove", "drop", "supprimer" an entire entity (not a single field). simple-developer: load to recognize the request is out of scope and refuse fast. developer (COMPLEX): load to execute the full removal.
---

# DELETE-RESOURCE — Removing a CRM entity end-to-end

A "resource" in Atomic-CRM = a React-Admin `<Resource>` backed by a Supabase table + view, with types, i18n, navigation, activity log, dashboard widgets and (often) child entities (notes, tasks tied by FK). Removing one is **always** multi-file and cross-layer.

## Scope gate (read first)

**If you are `simple-developer`**: STOP. Deleting a resource cascades across:
- ≥ 8 frontend files (CRM.tsx, types.ts, consts.ts, i18n × 2, layout × 2, dashboard, activity)
- ≥ 4 provider files (fakerest generator + provider, supabase provider, activity, canAccess)
- ≥ 4 Supabase schema files (tables, views, policies, grants — often functions/triggers too)
- 1 migration file with FK-ordered DROPs
- cross-resource references (FK columns on other tables, merge/join logic)

This is not a "single-field change on an existing entity". Refuse and output:

```
FAILED: out of scope — needs COMPLEX flow (delete-resource is structural, multi-file, cross-entity)
```

**If you are `developer`**: proceed. Treat the resource name as a parameter (`<R>` = singular PascalCase `Deal`, `<r>` = lowercase plural `deals`, `<R_UPPER>` = upper-snake `DEAL` used in event consts). The checklist below is the canonical reference — work through it in order, verify nothing is missed via the grep commands at the end.

---

## Step 0 — Identify scope

Before touching anything, list every file that mentions the resource. The grep is the source of truth for what to delete; the checklist below is the map.

```bash
cd <WORKTREE_PATH> && grep -rln "\"<r>\"\|'<r>'\|from \"\.\./<r>\"\|<R>\b" \
  src/components/atomic-crm \
  src/components/atomic-crm/providers \
  supabase/schemas \
  e2e \
  2>/dev/null
```

Also check child entities — `deals` owns `deal_notes`; `contacts` owns `contact_notes`. Children must be deleted in lockstep (you cannot drop a parent table while children FK-reference it).

```bash
cd <WORKTREE_PATH> && grep -rln "<r>_notes\|<r>_tasks" supabase/schemas src/components/atomic-crm 2>/dev/null
```

---

## Step 1 — Frontend: resource registration

### 1a. Delete the resource directory

```bash
cd <WORKTREE_PATH> && git rm -r src/components/atomic-crm/<r>/
```

This removes the index.ts (default export), List/Edit/Create/Show, helpers, unit tests — all in one shot.

### 1b. Unregister from `CRM.tsx`

`src/components/atomic-crm/root/CRM.tsx` has TWO things to remove:

1. The import: `import <r> from "../<r>";`
2. Every `<Resource name="<r>" ...>` line — there are usually **two**: one in `DesktopAdmin` (~line 268) and one in `MobileAdmin` (~line 340). Mobile may also import a specific view component (e.g. `MobileTasksList`) — remove its import too.

If the resource owns a child entity registered as a bare `<Resource name="<r>_notes" />`, remove it too.

### 1c. Type definitions

In `src/components/atomic-crm/types.ts`:
- Remove `export type <R> = { ... }`
- Remove `export type <R>NoteFormData`, `<R>Note`, etc. (any related types)
- Remove the resource from union types (e.g. `Activity = ActivityDealCreated | ...`)

### 1d. Event consts

`src/components/atomic-crm/consts.ts`:
- Remove `export const <R_UPPER>_CREATED = "...";`
- Remove `<R_UPPER>_NOTE_CREATED` if applicable.

Then update the import in `types.ts` (the union refers to these consts).

### 1e. i18n catalogs

`src/components/atomic-crm/providers/commons/englishCrmMessages.ts` AND `frenchCrmMessages.ts` (same dir):
- Remove the `resources.<r>` block (name, fields, empty.title…).
- Remove `nb_<r>` smart_count entry.
- Remove any settings-page block (`dealStages.title`, `dealCategories.helper_text`…) tied to the resource's config knobs.
- Remove cross-resource translations that mention the deleted name (e.g. an error message like "Cannot remove %{display_name} that are still used by deals: ...").

Both files must stay structurally aligned — never delete from English without French.

### 1f. Navigation

`src/components/atomic-crm/layout/Header.tsx` AND `layout/MobileNavigation.tsx`:
- Remove the `matchPath("/<r>/*", ...)` branch.
- Remove the nav `<Link to="/<r>">` block in Header.
- Remove the bottom-tab entry in MobileNavigation.

### 1g. Dashboard widgets

`src/components/atomic-crm/dashboard/`:
- Delete widgets named `<R>sPipeline.tsx`, `<R>sChart.tsx`, etc.
- Remove their imports + JSX usage from `Dashboard.tsx` and `MobileDashboard.tsx`.

### 1h. Activity feed

`src/components/atomic-crm/activity/`:
- Delete `ActivityLog<R>Created.tsx`, `ActivityLog<R>NoteCreated.tsx`.
- In `ActivityLogIterator.tsx`: remove imports and the `if (activity.type === <R_UPPER>_CREATED) return <ActivityLog<R>Created ...>` branches.

### 1i. Default configuration

`src/components/atomic-crm/root/defaultConfiguration.ts`:
- Remove `defaultDealStages`, `defaultDealCategories`, `defaultDealPipelineStatuses`, etc. — every default tied to the resource.
- Update the type in `ConfigurationContext.ts` (the `ConfigurationContextValue` type lists these props).
- In `CRM.tsx`, remove the prop entries from the `CRM` component signature, defaults, and the `store.setItem(CONFIGURATION_STORE_KEY, { ... })` block.

### 1j. Settings page

`src/components/atomic-crm/settings/`:
- If the resource has a settings panel (e.g. deal stages editor), remove its component file and unregister it from `SettingsPage.tsx` + `SettingsPageMobile.tsx`.

---

## Step 2 — Providers (data layer)

### 2a. Fakerest data generator

`src/components/atomic-crm/providers/fakerest/dataGenerator/`:
- `git rm <r>.ts` and `<r>Notes.ts` if present.
- In `types.ts`: remove the entry from the `Db` type.
- In `index.ts`: remove the call to `generate<R>s(db)` and the `<r>:` field from the returned object.
- In `finalize.ts`: remove any cross-linking code that touches the deleted entity.

### 2b. Fakerest dataProvider

`src/components/atomic-crm/providers/fakerest/dataProvider.ts`:
- Remove custom methods specific to the resource (e.g. `unarchiveDeal`).
- Remove cases in `update`/`delete` switches that reference `"<r>"`.
- Remove cleanup loops that fetch and update other resources by FK to this one.

### 2c. Supabase dataProvider

`src/components/atomic-crm/providers/supabase/dataProvider.ts`:
- Same as 2b, mirror-image for the Supabase side. Look for `"<r>"` strings and resource-specific helper functions.

### 2d. Activity & merge helpers

`src/components/atomic-crm/providers/commons/activity.ts`:
- Remove the `dataProvider.getList<<R>>("<r>", ...)` blocks.
- Remove `<r>NoteIds` aggregation.

`src/components/atomic-crm/providers/commons/mergeContacts.ts` (and similar merge helpers):
- Remove FK reassignment for the deleted resource.

### 2e. canAccess (RBAC)

`src/components/atomic-crm/providers/commons/canAccess.ts`:
- Remove any `if (params.resource === "<r>")` branch.

### 2f. Provider types

`src/components/atomic-crm/providers/types.ts`:
- Remove resource-specific methods from the `CrmDataProvider` interface (e.g. `unarchiveDeal: (deal: Deal) => Promise<void>`).

---

## Step 3 — Backend (Supabase)

### 3a. Write the DROP migration

New file under `supabase/migrations-pending/`. **Use the developer's canonical migration filename**, `<YYYYMMDDHHMMSS>_<SESSION_SHORT_ID>_<TASK-XXX>_<short-slug>.sql` (e.g. `..._drop-deals.sql`) — this is the pattern `apply-migrations.sh` matches when the orchestrator promotes pending → applied. A simpler ad-hoc name risks never being picked up for deploy. See `developer.md` (migration section) for the exact convention. **Order matters** — Postgres rejects DROPs that leave FK references dangling.

```sql
-- Drop views first (PostgREST queries views; they hold column-level dependencies)
drop view if exists public.<r>_summary cascade;
drop view if exists public.<r>_notes_summary cascade;

-- Drop child tables before parent (deal_notes references deals.id)
drop table if exists public.<r>_notes cascade;

-- Drop the resource table
drop table if exists public.<r> cascade;

-- Drop triggers / functions that exist solely for this resource
drop function if exists public.<r>_after_insert() cascade;
drop function if exists public.update_<r>_search_vector() cascade;

-- Remove FK columns from other tables that reference this resource
-- (only when no column would survive — otherwise alter, don't drop)
alter table public.tasks drop column if exists <r>_id;
```

Use `cascade` deliberately — it auto-drops dependent objects (policies, grants, indexes). Be aware: cascade silently removes things, so the migration is also documentation of what got dropped.

Per the `simple-developer` protocol (§3.5, pseudo-ticket): **if you are the COMPLEX `developer`, the real ticket already owns the pending-deploy plumbing — no pseudo-ticket needed**. If for any reason this skill is invoked from a path that needs one (e.g. orchestrator-routed cleanup), follow that recipe.

### 3b. Update declarative schemas

PostgREST exposes views, not tables — both layers must drop in sync.

`supabase/schemas/01_tables.sql`:
- Delete `create table public.<r> (...)` block.
- Delete `create table public.<r>_notes (...)` block.
- In other tables, remove FK columns: `<r>_id bigint references public.<r>(id)` and any composite indexes that include them.

`supabase/schemas/02_functions.sql`:
- Delete functions that operate on the resource (`create or replace function public.<r>_...`).

`supabase/schemas/03_views.sql`:
- Delete the `<r>_summary` view block.
- In other views (e.g. `activity_log`), remove `UNION ALL` branches that select from the deleted table.

`supabase/schemas/04_triggers.sql`:
- Delete triggers attached to the dropped tables.

`supabase/schemas/05_policies.sql`:
- Delete `create policy "..." on public.<r>` blocks.

`supabase/schemas/06_grants.sql`:
- Delete `grant ... on public.<r> to ...` lines.

`supabase/schemas/07_storage.sql`:
- Only if the resource owns storage objects (attachments) — delete the bucket policy block.

---

## Step 4 — Tests

### 4a. Unit tests

Tests colocated in the resource directory (`<r>Utils.test.ts` etc.) are removed with the `git rm -r src/components/atomic-crm/<r>/` in step 1a.

Find stragglers in other test files:

```bash
cd <WORKTREE_PATH> && grep -rln "<r>\|<R>" src --include="*.test.ts" --include="*.test.tsx" 2>/dev/null
```

For each file, remove the `describe`/`it` blocks that exercise the deleted resource. Do not delete entire test files unless their only purpose was the deleted resource.

### 4b. E2E tests

`e2e/`:
- `git rm` spec files whose entire purpose was the deleted resource (e.g. `dealKanban.spec.ts`).
- In multi-resource specs: remove the affected `test(...)` blocks.
- In `e2e/fixtures.ts`: remove fixture helpers that create the deleted resource.

---

## Step 5 — MEMORY.md

If `/app/MEMORY.md` documents domain rules tied to the deleted resource (custom field semantics, workflow constraints), the COMPLEX `developer` should not touch it directly — the `documentator` agent auto-runs at end-of-session and reconciles against the diff. Note any deletions in your commit message so documentator picks them up.

---

## Step 6 — Verification (grep is the oracle)

After the implementation, **nothing matching the resource name should remain** outside test fixtures for unrelated entities. Run:

```bash
cd <WORKTREE_PATH> && grep -rn "\"<r>\"\|'<r>'\|<R>\b\|<R_UPPER>_" \
  src supabase e2e \
  --exclude-dir=node_modules \
  2>/dev/null | grep -v migrations-pending
```

Expected: empty (or only matches inside your DROP migration, which is allowed). If matches remain, you missed a touchpoint — go back to Step 0 and grep wider.

**Caveat — common-word resources.** When the resource name is a generic English word (`tasks`, `notes`, `tags`), the patterns above will surface false positives from unrelated code (`task_id` on other entities, a generic `tags` prop, etc.). The quoted-literal (`"<r>"`) and word-boundary (`<R>\b`) forms keep most of this out, but you must eyeball each remaining match rather than assume a non-empty result means failure. "Expected empty" is a strong signal for distinctive names (`deals`, `companies`), a weaker one for common words.

Do NOT run typecheck / unit / e2e yourself — `block-bash-validation` blocks it and the COMPLEX flow's `test-validator` (e2e) plus the SubagentStop `typecheck` hook run after you stop. They will catch dangling type references and runtime breakage, including a migration that fails against a fresh DB. Your job is to make the grep oracle come back clean and commit; let the hooks validate.

---

## Commit strategy

Multiple atomic commits per area, all prefixed with the ticket id:

```
feat(TASK-XXX): drop deals frontend (resource, types, i18n, nav)
feat(TASK-XXX): drop deals providers (fakerest, supabase, activity)
feat(TASK-XXX): drop deals supabase schema + migration
feat(TASK-XXX): drop deals tests + dashboard widgets
```

Smaller atoms make reviewer diff easier and let the merger bisect if a regression appears.

---

## ADR check

This change usually does NOT warrant an ADR — it is structural cleanup, not a structural decision. Skip the ADR by default.

**Write one only if** the deletion documents a deliberate departure (e.g. "we are removing the tags system because we replaced it with PostgreSQL array columns" — that's a new pattern worth recording). Then load `Skill({skill: "adr-writing"})`.

---

## Gotchas

- **PostgREST queries views, not tables**: dropping the table without dropping `<r>_summary` first errors out. Always view → table.
- **Cascade hides dependencies**: `drop table public.<r> cascade` silently drops every policy, grant, view, FK that referenced it. Cheap, but inspect what got swept; you may need to recreate dependencies that touched the deleted resource only incidentally.
- **Mobile vs Desktop**: every resource may have TWO `<Resource>` registrations in `CRM.tsx`. Removing only one leaves a broken half-app on the other layout.
- **Cross-entity FK columns**: deleting `deals` does NOT mean every other table loses its `deal_id`. Inspect each FK column: drop it only if no future entity will need that relationship. When in doubt, ask the user.
- **Activity log UNION**: `activity_log` view is a `UNION ALL` of per-resource subqueries — removing the resource's branch is mandatory or the view won't recreate.
- **i18n parity**: every key removed from English must be removed from French. The two files share structure; drift triggers `i18nProvider.test.ts`.
- **Settings store**: `defaultConfiguration` values are persisted to `localStorage` under `CRM`. Existing users will keep stale keys until logout — annoying but not breaking. Document in the PR.
- **canAccess special cases**: removing a resource that had RBAC carve-outs (sales-only) means existing role JWTs may still grant access to the (now-404) URL. Server-side it's a non-issue; UI may flash. Acceptable.
