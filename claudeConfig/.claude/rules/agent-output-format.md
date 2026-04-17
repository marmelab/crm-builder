---
paths: []
---

# Agent output format

All agents read their ticket from docs/tickets/TASK-XXX.json before starting.

## Reviewer agents (code-reviewer, security-reviewer, test-validator)

Output structured text — no JSON blocks:

Verdict: APPROVED / APPROVED WITH RESERVATIONS / BLOCKED / GREEN / RED

Issues:
  - severity: blocking / warning / suggestion
  - file: path/to/file
  - line: N
  - description: what is wrong
  - fix: how to fix it

Summary: one line — N blocking issues, action required or not.

## Action agents (developer, merger)

Output structured text:

  - ticket_id: TASK-XXX
  - files_modified: list
  - commits: list
  - notes: any blocking points

## Status updates

After merge: update docs/tickets/TASK-XXX.json status to "merged".
After implementation starts: update status to "in_progress".