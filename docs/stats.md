# stats/ — reference

Read-only aggregation layer. Called by `GET /api/stats?sessionId=UUID`. Never writes to disk.

## Modules & inputs

| Module | Reads | Produces |
|---|---|---|
| `phases.js` | `log.jsonl` | Agent phases with token+cost per phase |
| `hooks.js` | `log.jsonl` + `hooks.log` | Hook executions mapped to phases, blocking failures flagged |
| `tickets.js` | `TASK-NNN.json` | Wave ordering from ticket dependencies |
| `subagents.js` | `~/.claude/projects/-app/CSID/subagents/agent-*.jsonl` | Per-agent token+cost |
| `tools.js` | `log.jsonl` | Tool call counts per type |
| `events.js` | `log.jsonl` | Event classification |
| `children.js` | `log.jsonl` + subagent transcripts | Phase children (tool_use instances) |
| `insights.js` | `log.jsonl` | Rule invocations, skill usage, retries |

## Gotchas

**`total_cost_usd` is cumulative within a spawn** — each stream-json event's `total_cost_usd` is the running total since the process started, not the cost of that event. Never sum it across events — massive inflation. Instead read `costUsd` from `meta.json` which is committed once at turn end.

**`tokensUsed` = input + cache_creation + output** — cache_read is excluded (cheap rehydration, not billed the same way). Formula in `io.js`.

**`activeAgents`** counts only tasks where `task_type === 'local_agent'`, tracked via a `Set<task_id>`. Other task types (tool calls etc.) don't count.

**Subagent transcripts path** — `~/.claude/projects/-app/CSID/subagents/agent-TASK-NNN.jsonl`. The slug `-app` is CWD `/app` with `/` replaced by `-` (`config.js:14`). stats/ reads the snapshot copy under `/logs/UUID/claude/subagents/` (written at turn end by `turn.js`), not the live path.
