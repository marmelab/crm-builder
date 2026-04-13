---
name: pr-creation
description: How to create a PR, enable auto-merge, and monitor CI for a task branch. Used by JULIEN.
---

## Standard workflow

```bash
# 1. From the task worktree
cd worktrees/TASK-XXX

# 2. Create the PR
make merge TASK=XXX TITLE="feat/fix: <ticket description>"
# TITLE always comes from the task subject — never the last commit message
# Use TaskGet if you need to retrieve the subject

# 3. Enable auto-merge (squash)
gh pr merge --squash --auto <PR_NUMBER>

# 4. Watch CI
gh pr checks <PR_NUMBER> --watch
```

## Interpreting the result

| Exit code | Meaning | Action |
|-----------|---------|--------|
| 0 | All checks green | Report success to team-lead |
| 1 | One or more checks failed | Report failures + log links to team-lead. Do not fix — JEROME fixes, then re-run `gh pr checks --watch` |

## Constraints

- Never force a merge if CI is red.
- If auto-merge fails due to branch protection, report to team-lead — do not bypass.
- PR title = task subject. Always. Not the last commit message.