# TASK-042

## Gotchas
- `useFieldArray` requires explicit `control` when inside `FormProvider`,
  otherwise the array stays empty and silently fails on submit.
- Supabase row-level transforms must run BEFORE the request, not after —
  the `transformParams` slot in dataProvider is the only correct hook.

## Reusable
- `src/components/atomic-crm/providers/transformParams.ts` — generic
  param-strip helper, accepts a list of fields to drop.
- `src/components/atomic-crm/contacts/useNestedFieldArray.ts` — wrapper
  for nested form arrays that auto-binds `control`.
