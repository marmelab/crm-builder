---
name: e2e-conventions
description: When to write e2e tests, where to put them, and how to verify them. Apply to any task touching UI, filters, forms, or interactions.
---

## When e2e tests are mandatory

A task **requires** e2e tests if it touches any of:
- UI components or pages
- Filters or search
- Forms or user input
- Interactions (click, drag, keyboard)

Exception: if the task is pure CSS or a DB migration only, this must be explicitly noted in `acceptance_criteria`.

## Where to put them

e2e/task-xxx-<feature-name>.spec.ts

Name the file after the ticket and feature — makes it easy for TEST-VALIDATOR to find it.

## What to verify

DEVELOPER writes them, TEST-VALIDATOR checks they exist and are syntactically valid.
CI runs them — agents do not need to execute them locally.

## Checking syntax without running

```bash
npx tsc --noEmit e2e/task-xxx-*.spec.ts
```