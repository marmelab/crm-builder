# Claude CLI — Fake contract

Everything chat-service sends to the persistent interactive `claude` PTY, and everything it expects back.
Replace this contract with a stub to test chat-service tools without a real Claude CLI.

---

## Input — what chat-service sends

**Command line** (built by `pty-session.js`, spawned interactively via node-pty — no `-p`, no stdout JSON):
```
claude
  --dangerously-skip-permissions
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  [--resume <CSID>]         # only when resuming an existing session
  --agent chat-orchestrator # loads ~/.claude/agents/chat-orchestrator.md as system prompt
  --model <model>           # from chat-orchestrator.md YAML frontmatter
  --append-system-prompt '<mode>demo|full</mode>\n<session_dir>/chat-service/logs/<UUID></session_dir>'
```

**Per-turn input**: the user message is typed into the TUI stdin (sanitized: control chars stripped, newlines flattened), followed by a CR 50 ms later. The orchestrator instructions and `<mode>`/`<session_dir>` live in the system prompt, not the message.

Special rewrites applied to the user message before sending (turn-helpers.js):
- `FULL_SETUP` → `<intent>setup</intent>\nUser clicked "Define your business"…`
- If previous process was killed AND TASK-*.json files exist → message replaced with `<intent>recovery</intent>\nThe previous run was interrupted…\n\nOriginal: {original message}` and `--resume` is dropped (fresh session)

**Environment variables** (cwd = `/app`):

| Variable | Value | Always? |
|---|---|---|
| `HOME` | `/home/developer` | yes |
| `CLAUDE_PROJECT_DIR` | `/app` | yes |
| `CHAT_SESSION_DIR` | `/chat-service/logs/<UUID>` | yes |
| `MODE` | `demo` or `full` | yes |
| `CLAUDE_SESSION_ID` | `<CSID>` | only when resuming |
| `DOCUMENTATOR_RUN` | `1` | only when documentator-spawn.js spawns |

---

## Output — what chat-service reads back

In the PTY model, stdout is the raw TUI (ignored except for error sniffing). The events below are **reconstructed from the transcript** at `~/.claude/projects/-app/<CSID>.jsonl` by `transcript-watcher.js` and emitted to `turn.js` in the same shapes; a fake must append them to that file as newline-delimited JSON. Turn end is signalled by the Stop hook touching `/tmp/pty-sentinels/pty-turn-done-<CSID>`.

**1. Mandatory first event** — gives `claudeSessionId`, stored in `meta.json`:
```json
{ "type": "system", "subtype": "init", "session_id": "conv_0123abc..." }
```

**2. Assistant text** — broadcast to WebSocket as `type:message`:
```json
{ "type": "assistant", "message": { "content": [{ "type": "text", "text": "..." }] } }
```

**3. Tool use** — broadcast as `type:debug`, drives the progress bar:
```json
{ "type": "assistant", "message": { "content": [{
  "type": "tool_use",
  "name": "Agent|TeamCreate|TeamDelete|Bash|Read|Write|SendMessage|...",
  "input": { ... }
}]}}
```

**4. Token usage** — feeds `tokensUsed` and cost stats:
```json
{ "type": "...", "usage": { "input_tokens": N, "cache_creation_input_tokens": N, "output_tokens": N } }
```

**5. Turn end** — triggers state transition in `turn-state.js`:
```json
{ "type": "result", "subtype": "success|error_max_tokens|...", "total_cost_usd": 0.042 }
```

---

## File side effects — what chat-service reads from the filesystem

The subprocess (or hooks it triggers) must produce these files. Each unlocks a different chat-service feature.

| File | Written by | Read by | Feature unlocked |
|---|---|---|---|
| `$CHAT_SESSION_DIR/TASK-NNN.json` | planner agent | `session-store.js`, `stats/tickets.js`, `documentator-spawn.js` | recovery detection, wave stats, documentator trigger |
| `$CHAT_SESSION_DIR/hooks.log` | hook scripts | `stats/hooks.js` | hook timeline in stats UI |
| `~/.claude/projects/-app/$CSID/subagents/agent-*.jsonl` | each subagent | `subagent-tail.js`, `stats/subagents.js` | real-time subagent broadcast, per-agent token+cost |
| `/app/worktrees/<SHORT>/…` | `setup-worktree.sh` | merger agent | actual code changes — **not needed for chat tooling test** |
| git branches | developer + merger | merger, rollback routes | actual CRM functionality — **not needed for chat tooling test** |

**Minimal fake** — enough to exercise WebSocket, sessions, stats, progress bar, documentator:
1. Emit the 5 stdout event types above
2. Write `$CHAT_SESSION_DIR/TASK-001.json` with `"status": "merged"`
3. Write `~/.claude/projects/-app/$CSID/subagents/agent-TASK-001.jsonl` (can be minimal)
4. Append a few lines to `$CHAT_SESSION_DIR/hooks.log`

---

## TASK-NNN.json schema

Written by planner, updated by developer (`in_progress`) and merger (`merged`).

```json
{
  "ticket_id": "TASK-001",
  "title": "Short imperative title",
  "description": "What and why",
  "type": "feature|fix|config",
  "risk_level": "low|medium|high",
  "acceptance_criteria": ["testable criterion"],
  "files_to_modify": ["src/..."],
  "dependencies": ["TASK-000"],
  "parallel_safe": true,
  "status": "pending|in_progress|merged"
}
```

## meta.json schema

Written and read exclusively by `session-store.js`.

```json
{
  "id": "<chat-UUID>",
  "title": "auto-generated from first user message",
  "titleLocked": false,
  "state": "in_progress|completed|error|rate_limited|waiting",
  "createdAt": "<ISO>",
  "lastMessageAt": "<ISO>",
  "messageCount": 5,
  "userMessageCount": 2,
  "claudeSessionId": "conv_0123abc",
  "satisfactionAsk": false,
  "documentatorLastRunAt": "<ISO>",
  "documentatorLastRunExit": 0
}
```

## hooks.log line format

```
[2026-04-30T10:56:26+00:00] setup-worktree START session=a1b2c3d4 task=TASK-001
[2026-04-30T10:56:27+00:00] setup-worktree EXIT=0 wt=/app/worktrees/a1b2c3d4/TASK-001
[2026-04-30T10:57:10+00:00] typecheck START pwd=/app worktree=/app/worktrees/a1b2c3d4/TASK-001
[2026-04-30T10:57:22+00:00] typecheck EXIT=0 OK
[2026-04-30T10:57:22+00:00] validate-before-review EXIT=0 APPROVED
```

---

## ID & path naming

| Identifier | Example | Computed by |
|---|---|---|
| chat session UUID | `a1b2c3d4-e5f6-7890-1234-567890abcdef` | `randomUUID()` in `session-store.js` |
| SESSION_SHORT | `a1b2c3d4` | first UUID segment — `cut -d'-' -f1` in hooks, not chat-service |
| claudeSessionId (CSID) | `conv_0123abc` | Claude CLI's own ID, read from `event.session_id` in stdout |
| CHAT_SESSION_DIR | `/chat-service/logs/<UUID>` | `pty-session.js`, set as env var at PTY spawn |
| transcript base dir | `~/.claude/projects/-app/<CSID>/` | CWD `/app` with `/` replaced by `-` (`config.js:14`) |
| worktree (COMPLEX) | `/app/worktrees/<SHORT>/TASK-NNN` | `setup-worktree.sh` |
| worktree (SIMPLE) | `/app/worktrees/<SHORT>/simple` | `setup-worktree.sh` |
| session worktree | `/app/worktrees/<SHORT>/_session` | `setup-worktree.sh` |
| branch (COMPLEX) | `<SHORT>/TASK-NNN` | `setup-worktree.sh` |
| branch (SIMPLE) | `<SHORT>/simple` | `setup-worktree.sh` |
