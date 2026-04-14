---
name: pr-creation
description: How to create a PR, enable auto-merge, and monitor CI for a task branch. Used by MERGER.
---

## Standard workflow

# 1. From the task worktree
cd worktrees/TASK-XXX

# 2. Create the PR
make merge TASK=XXX TITLE="feat/fix: <ticket description>"
# TITLE always comes from the task subject — never the last commit message
# Use TaskGet if you need to retrieve the subject

# 3. Watch CI first — never merge before CI is green
    gh pr checks <PR_NUMBER> --watch
    EXIT=$?

    if [ $EXIT -ne 0 ]; then
      echo "CI failed — merge blocked. Report to team-lead."
      exit 1
    fi

# 4. Enable auto-merge only if CI passed
    gh pr merge --squash --auto <PR_NUMBER>


## Interpreting the result

| Exit code | Meaning | Action |
|-----------|---------|--------|
| 0 | All checks green | Report success to team-lead |
| 1 | One or more checks failed | Report failures + log links to team-lead. Do not fix — JEROME fixes, then re-run `gh pr checks --watch` |

## Constraints

- Never force a merge if CI is red.
- If auto-merge fails due to branch protection, report to team-lead — do not bypass.
- PR title = task subject. Always. Not the last commit message.