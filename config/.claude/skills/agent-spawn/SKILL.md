---
name: agent-spawn
description: How to spawn, configure, and shut down agents in a Claude Code Agent Team. Use when dispatching any agent in the multi-agent workflow.
---

## Spawn sequence

```js
// 1. Create the team (once per ticket lifecycle)
TeamCreate({ team_name: "project-phase1", description: "..." })

// 2. Create and assign the task
TaskCreate({ subject: "TASK-XXX: ...", description: "..." })
TaskUpdate({ taskId: "N", owner: "JEROME-XXX", status: "in_progress" })

// 3. Spawn the agent
// Always read the agent file first and include its contents in the prompt
Agent({
  name: "JEROME-XXX",
  team_name: "project-phase1",
  model: "opus", // see model routing table in agent-team skill
  prompt: `[contents of .claude/agents/JEROME.md]\n\nTicket context:\n...`
})
```

## Shutdown

Always manual — never automatic. Send after receiving the agent's final summary:

```json
{"type": "shutdown_request"}
```

## Model routing

| Agent    | Model                     |
|----------|---------------------------|
| ERWAN    | claude-sonnet-4-6         |
| JEROME   | claude-opus-4-6           |
| JIBE     | claude-sonnet-4-6         |
| FRANCIS  | claude-sonnet-4-6         |
| GUILLAUME| claude-haiku-4-5-20251001 |
| ALEXANDRA| claude-haiku-4-5-20251001 |
| BENOIT   | claude-sonnet-4-6         |
| JULIEN   | claude-haiku-4-5-20251001 |

## Circuit breaker

If an agent is stuck after 3 iterations: kill it, read its last summary, reassign to a fresh instance with the blocking point in the prompt context.