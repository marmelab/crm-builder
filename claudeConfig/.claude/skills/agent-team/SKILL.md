---
name: agent-team
description: Multi-agent team workflow for implementing tickets. Use when dispatching agents or following the full lifecycle (bootstrap → planning → spec → impl → review → merge).
---

## Full lifecycle

### Phase 0 — Bootstrap (once per project)

Check project-context.json at project root:

  Does not exist or validated: false
    → PROJECT-MANAGER  @.claude/agents/project-manager.md
        ↓ (produces project-context.json with validated: true)

  validated: true
    → proceed to Phase 1

### Phase 1 — Ticket planning (once per feature/need)

    → PLANNER            @.claude/agents/planner.md
        ↓ produces ordered list of TASK-XXX tickets
        ↓ writes each ticket to docs/tickets/TASK-XXX.json
        ↓ writes ticket list to project-context.json under "tickets" key

### Phase 1b — Session resume (if ~/.claude/tasks/ is empty)

On session start, check if tasks exist in ~/.claude/tasks/:

  Tasks missing but docs/tickets/ contains tickets
    → read project-context.json tickets array
    → recreate each pending ticket via TaskCreate
    → resume from last incomplete ticket

  No tickets at all
    → proceed to Phase 1 (new planning session)

### Phase 2 — Per-ticket cycle

    make spin TASK=XXX NAME=yyy

    → DEVELOPER          @.claude/agents/developer.md
         mode: implementation
         reads ticket from docs/tickets/TASK-XXX.json

    → parallel reviews (simultaneously):
         CODE-REVIEWER      @.claude/agents/code-reviewer.md
         SECURITY-REVIEWER  @.claude/agents/security-reviewer.md
         TEST-VALIDATOR     @.claude/agents/test-validator.md

    All APPROVED:
         → DEVELOPER  mode: reflection
              docs/reflections/TASK-XXX-reflection.md
         → update docs/tickets/TASK-XXX.json status to "merged"
         make clean TASK=XXX NAME=yyy

    Any BLOCKED:
         → DEVELOPER  fix issues
         → re-run parallel reviews

---

## Ticket persistence

Tickets are stored in two places:

- ~/.claude/tasks/ — native agent teams storage (session-scoped, lost on sandbox restart)
- docs/tickets/TASK-XXX.json — permanent project storage (source of truth)

All agents read tickets from docs/tickets/TASK-XXX.json.
The team-lead reads project-context.json on session start and recreates
tasks via TaskCreate if ~/.claude/tasks/ is empty.

---

## Ticket format in docs/tickets/TASK-XXX.json

``````json
{
  "ticket_id": "TASK-001",
  "title": "Short imperative title",
  "description": "What needs to be done and why",
  "type": "feature|fix|migration|config",
  "risk_level": "low|medium|high",
  "acceptance_criteria": [
    "Specific, testable, verifiable statement"
  ],
  "non_functional_requirements": {
    "performance": "...",
    "security": "...",
    "scalability": "..."
  },
  "dependencies": ["TASK-000"],
  "status": "pending|in_progress|merged"
}
``````

---

## Model routing

| Agent              | Definition                               |
|--------------------|------------------------------------------|
| PROJECT-MANAGER    | @.claude/agents/project-manager.md       |
| DEVOPS             | @.claude/agents/devops.md                |
| PLANNER            | @.claude/agents/planner.md               |
| ARCHITECT          | @.claude/agents/architect.md             |
| DEVELOPER          | @.claude/agents/developer.md             |
| CODE-REVIEWER      | @.claude/agents/code-reviewer.md         |
| SECURITY-REVIEWER  | @.claude/agents/security-reviewer.md     |
| TEST-VALIDATOR     | @.claude/agents/test-validator.md        |
| MERGER             | @.claude/agents/merger.md                |

---

## Spawning agents

TeamCreate with team_name and description.
TaskCreate with subject "TASK-XXX: ..." and description.
TaskUpdate with taskId, owner "AGENT-XXX", status "in_progress".

Always read the agent file and include its contents in the prompt:

    Agent(
      name: "DEVELOPER-XXX",
      team_name: "project-phase1",
      model: "opus",
      prompt: contents of .claude/agents/developer.md + ticket context
              + contents of docs/tickets/TASK-XXX.json
    )

Agents become idle after sending their summary.
Team-lead sends shutdown_request to terminate them.

---

## Global rules

- **Circuit-breaker:** agent stuck after 3 iterations → kill and reassign
- **Parallel reviews:** CODE-REVIEWER, SECURITY-REVIEWER, TEST-VALIDATOR
  run simultaneously
- **Any BLOCKED = no merge:** one blocking verdict from any reviewer
  stops the merge — security always wins over code style
- **Reflection:** after all reviews approved, before merge
- **e2e tests:** mandatory for any UI/filter/interaction task unless
  explicitly noted otherwise in acceptance_criteria
- **Silent mode:** enforced by .claude/hooks/silent-mode-check.sh
- **Port isolation:** each agent running a local server derives its port
  from the task number — 5180 + TASK_NUM — to avoid conflicts
- **project-context.json:** available to all agents — read it for
  project conventions, entities, roles, and constraints
- **Ticket source of truth:** docs/tickets/TASK-XXX.json — always read
  tickets from here, never rely solely on ~/.claude/tasks/