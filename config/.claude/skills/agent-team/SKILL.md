---
name: agent-team
description: Multi-agent team workflow for implementing tickets. Use when dispatching agents or following the full lifecycle (bootstrap → planning → spec → impl → review → merge).
---

## Full lifecycle

### Phase 0 — Bootstrap (once per project)

Check project-context.json at project root:

- Does not exist or validated: false
    → PROJECT-MANAGER  @.claude/agents/project-manager.md
    → produces project-context.json with validated: true

- validated: true, bootstrapped: false
    → DEVOPS  @.claude/agents/devops.md
    → fork + supabase + env + deploy → bootstrapped: true

- validated: true, bootstrapped: true
    → proceed to Phase 1

---

### Phase 1 — Ticket planning (once per feature/need)

    → PLANNER  @.claude/agents/planner.md
    → produces ordered list of TASK-XXX tickets

---

### Phase 2 — Per-ticket cycle

    make spin TASK=XXX NAME=yyy

    → ARCHITECT  @.claude/agents/architect.md
         mode: spec validation
         APPROVED  → continue
         BLOCKED   → back to PLANNER

    → DEVELOPER  @.claude/agents/developer.md
         mode: plan

    → ARCHITECT  @.claude/agents/architect.md
         mode: plan approval
         APPROVED  → continue
         REJECTED  → back to DEVELOPER

    → DEVELOPER  @.claude/agents/developer.md
         mode: implementation
         make test must pass before notifying team-lead

    → parallel reviews (simultaneously):
         CODE-REVIEWER      @.claude/agents/code-reviewer.md
         SECURITY-REVIEWER  @.claude/agents/security-reviewer.md
         TEST-VALIDATOR     @.claude/agents/test-validator.md

    All APPROVED:
         → DEVELOPER  mode: reflection
              docs/reflections/TASK-XXX-reflection.md
         → MERGER  @.claude/agents/merger.md
              make merge + gh pr merge --squash --auto + gh pr checks --watch
         make clean TASK=XXX NAME=yyy

    Any BLOCKED:
         → DEVELOPER  fix issues
         → re-run parallel reviews

---

## Model routing

| Agent              | Model                     | Definition                           |
|--------------------|---------------------------|--------------------------------------|
| PROJECT-MANAGER    | claude-sonnet-4-6         | @.claude/agents/project-manager.md   |
| DEVOPS             | claude-sonnet-4-6         | @.claude/agents/devops.md            |
| PLANNER            | claude-sonnet-4-6         | @.claude/agents/planner.md           |
| ARCHITECT          | claude-opus-4-6           | @.claude/agents/architect.md         |
| DEVELOPER          | claude-opus-4-6           | @.claude/agents/developer.md         |
| CODE-REVIEWER      | claude-sonnet-4-6         | @.claude/agents/code-reviewer.md     |
| SECURITY-REVIEWER  | claude-sonnet-4-6         | @.claude/agents/security-reviewer.md |
| TEST-VALIDATOR     | claude-haiku-4-5-20251001 | @.claude/agents/test-validator.md    |
| MERGER             | claude-haiku-4-5-20251001 | @.claude/agents/merger.md            |

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
    )

Agents become idle after sending their summary.
Team-lead sends shutdown_request to terminate them.

---

## Global rules

- **Circuit-breaker:** agent stuck after 3 iterations → kill and reassign
- **Spec first:** ARCHITECT validates spec BEFORE DEVELOPER plans
- **Plan approval:** ARCHITECT approves plan BEFORE DEVELOPER codes
- **Tests before reviews:** DEVELOPER runs make test before notifying
  team-lead — do not dispatch reviews on broken code
- **Parallel reviews:** CODE-REVIEWER, SECURITY-REVIEWER, TEST-VALIDATOR
  run simultaneously
- **Any BLOCKED = no merge:** one blocking verdict from any reviewer
  stops the merge — security always wins over code style
- **Reflection:** after all reviews approved, before merge
- **CI:** branch protection + --auto + --watch = double lock
- **PR title:** task subject, never the last commit message
- **e2e tests:** mandatory for any UI/filter/interaction task unless
  explicitly noted otherwise in acceptance_criteria
- **Silent mode:** enforced by .claude/hooks/silent-mode-check.sh
- **Port isolation:** each agent running a local server derives its port
  from the task number — 5180 + TASK_NUM — to avoid conflicts
- **project-context.json:** available to all agents — read it for
  project conventions, entities, roles, and constraints