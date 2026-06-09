# turn.js — reference

Orchestrates the full lifecycle of one user turn: spawn → stream → log → snapshot → schedule documentator.

## Resume vs recovery decision (`planResume`)

| Condition | Result |
|---|---|
| State = `error` or `rate_limited` **AND** `TASK-*.json` files exist in session dir | Fresh session + `<intent>recovery</intent>` prepended to message. No `--resume`. |
| State = `error` or `rate_limited`, no TASK files | `--resume CSID` (Claude resumes conversation) |
| Normal (previous turn completed cleanly) | `--resume CSID` |

"TASK files exist" = `sessionHasTickets()` finds any `TASK-NNN.json` in `CHAT_SESSION_DIR`. Means the planner dispatched work that may be mid-flight.

## claudeSessionId capture

`claudeSessionId` (CSID) is the Claude CLI's own conversation ID — **distinct from the chat session UUID**. Captured from the first `{ type: "system", subtype: "init", session_id: "conv_..." }` event on stdout. Stored in `meta.json` and used for `--resume` on the next turn.

## Snapshot (end of turn)

In the `finally` block, `turn.js` copies `~/.claude/projects/-app/CSID/` → `/logs/UUID/claude/`:
- `transcript.jsonl` — full orchestrator stream
- `subagents/agent-*.jsonl` — per-agent transcripts (stats/ reads these)
- `tool-results/` — cached tool outputs

This snapshot is what `stats/subagents.js` reads — not the live path.

## Documentator scheduling

After the finally block, if `state = completed` AND at least one `TASK-NNN.json` has `status: "merged"`:
- `scheduleDocumentatorRun()` sets a 30s debounce timer
- Timer is cleared if the user sends a new message before it fires
- On fire: if `runtime.busy` → skip (next completed turn will reschedule)
- Spawns a fresh Claude session (no `--resume`), env `DOCUMENTATOR_RUN=1`, silent output to `documentator.log`
