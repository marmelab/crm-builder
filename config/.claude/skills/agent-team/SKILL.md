---
name: agent-team
description: Multi-agent team workflow for implementing tickets. Use when dispatching agents, reviewing PRs, arbitrating conflicts, or following the ticket lifecycle (spec → impl → review → merge).
---

## Per-ticket workflow

```
make spin TASK=XXX NAME=yyy
  → ERWAN   — spec validation             @.claude/agents/ERWAN.md
  → JEROME  — code plan                   @.claude/agents/JEROME.md
  → ERWAN   — plan approval
  → JEROME  — implementation
    ↓ (in parallel)
  JIBE          FRANCIS         GUILLAUME       ALEXANDRA
  code+spec     security        green tests     UI/UX visual demo
    ↓
  Conflict? → BENOIT arbitrates  @.claude/agents/BENOIT.md
  → JEROME  — docs/reflections/TASK-XXX-reflection.md
  → JULIEN  — make merge + gh pr merge --auto + gh pr checks --watch
make clean TASK=XXX NAME=yyy
```

## Model routing

| Agent    | Model                     | Definition                        |
|----------|---------------------------|-----------------------------------|
| ERWAN    | claude-sonnet-4-6         | @.claude/agents/ERWAN.md          |
| JEROME   | claude-opus-4-6           | @.claude/agents/JEROME.md         |
| JIBE     | claude-sonnet-4-6         | @.claude/agents/JIBE.md           |
| FRANCIS  | claude-sonnet-4-6         | @.claude/agents/FRANCIS.md        |
| GUILLAUME| claude-haiku-4-5-20251001 | @.claude/agents/GUILLAUME.md      |
| ALEXANDRA| claude-haiku-4-5-20251001 | @.claude/agents/ALEXANDRA.md      |
| BENOIT   | claude-sonnet-4-6         | @.claude/agents/BENOIT.md         |
| JULIEN   | claude-haiku-4-5-20251001 | @.claude/agents/JULIEN.md         |

## Spawning agents (visible tmux)

```js
TeamCreate({ team_name: "project-phase1", description: "..." })
TaskCreate({ subject: "TASK-XXX: ...", description: "..." })
TaskUpdate({ taskId: "N", owner: "JEROME-XXX", status: "in_progress" })

// Read the agent file and include it in the prompt
Agent({ name: "JEROME-XXX", team_name: "project-phase1", model: "opus",
  prompt: `[contents of .claude/agents/JEROME.md]\n\nTicket context:\n...` })
```

**Shutdown:** always manual — `{"type":"shutdown_request"}` after receiving the completion message.

## Global rules

- **Circuit-breaker:** agent stuck after 3 iterations → kill and reassign
- **Plan approval:** ERWAN validates BEFORE JEROME codes
- **Parallel reviews:** JIBE, FRANCIS, GUILLAUME, ALEXANDRA simultaneously
- **BENOIT:** only on conflict, not on every ticket
- **Reflection:** after reviews, not before merge
- **CI:** branch protection + `--auto` + `--watch` = double lock
- **PR title:** task subject, never the last commit message
- **e2e tests:** mandatory for any UI/filter/interaction task (unless noted in acceptance_criteria)
- **Silent mode:** enforced by `.claude/hooks/silent-mode-check.sh`