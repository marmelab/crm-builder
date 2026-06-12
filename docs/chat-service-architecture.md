# Chat-Service — Architecture reference

Quick orientation for a fresh session. Covers only chat-service entities and their relationships.

---

## 1. Components & connections

chat-service is a Node.js server (:8080) that sits between the browser and the Claude CLI. Its job: receive a user message over WebSocket, drive a **persistent interactive Claude TUI** through a PTY (one long-lived process per session — no more `claude -p` spawn per message), tail its JSONL transcript into `log.jsonl`, broadcast events to the browser in real time, then aggregate the results into session stats. It never directly modifies CRM code — that's done by the agents running inside the Claude process. See [turn.md](turn.md) for the full turn lifecycle.

**Modules** (`chat-service/lib/`):

| Module | File | Role |
|---|---|---|
| PTY session | `server/pty-session.js` | Spawns the persistent interactive `claude` process in a PTY (`--agent chat-orchestrator`, `[--resume CSID]`, empty `--mcp-config`), sets env vars (`CHAT_SESSION_DIR`, `MODE`, …), answers the TUI's terminal capability queries, detects turn completion via the Stop-hook sentinel |
| Transcript watcher | `server/transcript-watcher.js` | Tails the Claude JSONL transcript (byte-offset incremental reads), discovers the CSID, emits assistant/tool events, accumulates deduped per-model token usage |
| Turn helpers | `server/turn-helpers.js` | Assistant-message extraction, `FULL_SETUP` intent rewrite, resume planning (fresh vs `--resume`), user-facing error text |
| Turn orchestrator | `server/turn.js` | Drives one user turn: PTY events → text pipeline → `log.jsonl` + broadcast, snapshots transcripts at turn end, hands off to the background driver when a COMPLEX wave is still in flight — see [turn.md](turn.md) |
| Session store | `server/session-store.js` | Generates chat UUID, reads/writes `meta.json`, detects `TASK-*.json` to decide resume vs recovery |
| Subagent tailer | `server/subagent-tail.js` | Polls `~/.claude/projects/-app/CSID/subagents/` every 2500ms, broadcasts new lines to WebSocket |
| Stats aggregator | `lib/stats/` (8 modules) | Read-only — folds `log.jsonl` + `TASK-*.json` + `hooks.log` + subagent transcripts into `GET /api/stats` response |
| Deploy routes | `server/deploy-routes.js` | SSE channel `/api/deploy/events`, 6-phase pipeline (vite build → supabase → wrangler), independent of chat WebSocket |

> The former `documentator-spawn.js` is gone: the documentator (Mode 2) is now dispatched by the orchestrator itself via `Agent({ run_in_background: true })` at POST-DEV, once the user validates the result.

**The Claude process** loads the harness (`~/.claude/` — agents, hooks, skills, rules, settings.json) and is the only thing that touches the CRM code. chat-service communicates with it through:
- **Input**: PTY stdin (sanitized text + `\r`), spawn args + env vars (see `claude-cli-fake-contract.md`)
- **Output**: the JSONL transcript under `~/.claude/projects/-app/CSID/` (tailed by `transcript-watcher.js`) — not stdout
- **Completion signal**: the `Stop` hook writes `/tmp/pty-turn-done-<CSID>`; the TUI never exits between turns
- **Filesystem**: `TASK-NNN.json`, `hooks.log`, subagent transcripts under `~/.claude/projects/-app/CSID/`

**Visual overview** (for reference):

```mermaid
flowchart TD

    classDef svc fill:#16A34A,stroke:#14532D,color:#fff
    classDef agent fill:#2563EB,stroke:#1E40AF,color:#fff
    classDef hook fill:#D97706,stroke:#92400E,color:#000
    classDef fs fill:#374151,stroke:#111827,color:#fff
    classDef ext fill:#BE185D,stroke:#831843,color:#fff

    BROWSER(["Browser\nChat sidebar WebSocket ws://:8080\nREST: mode switch, deploy, sessions, stats"]):::ext

    subgraph CHATSERVICE ["chat-service (Node.js :8080)"]
        direction TB
        SPAWN(["pty-session.js\nspawns persistent interactive claude in a PTY\nsets CHAT_SESSION_DIR env\nStop-hook sentinel = turn completion"]):::svc
        WATCH(["transcript-watcher.js\ntails the JSONL transcript (byte offsets)\ndiscovers CSID, emits events\ndeduped per-model token usage"]):::svc
        TURN(["turn.js\ndrives one turn: PTY events -> text pipeline\nappends events to log.jsonl\nsnapshots transcripts at turn end\nbackground driver for COMPLEX waves"]):::svc
        STORE(["session-store.js\nrandomUUID() -> chat session UUID\nwrites + reads meta.json\ndetects TASK-*.json -> recovery vs resume decision"]):::svc
        TAIL(["subagent-tail.js\npolls ~/.claude/projects/-app/CSID/subagents/\nevery 2500ms -> broadcasts to WebSocket"]):::svc
        STATS(["stats/ (8 modules)\nphases . hooks . tickets . subagents . tools\nread-only, called by GET /api/stats"]):::svc
        DEPLOY(["deploy-routes.js\nSSE channel /api/deploy/events\n6-phase pipeline (vite build, supabase, wrangler)\nindependent of chat WebSocket"]):::svc
    end

    CLI(["Persistent Claude TUI (one per session)\nclaude --dangerously-skip-permissions\n--strict-mcp-config --mcp-config '{}'\n[--resume CSID] --agent chat-orchestrator\n--append-system-prompt '<mode> <session_dir>'"]):::ext

    subgraph HARNESS ["Harness  ~/.claude/  (extractable)"]
        direction LR
        AGENTS["agents/ (8 .md)\norchestrator . planner . developer\nmerger . quality-reviewer\ntest-validator . simple-developer\ndocumentator"]:::agent
        HOOKS_SH["hooks/ (21 .sh)\nPreToolUse . Stop . SubagentStop"]:::hook
        MISC["skills/ (7)   rules/ (10)\nsettings.json"]
    end

    subgraph FS ["Filesystem"]
        direction TB
        LOGS["/chat-service/logs/UUID/\nlog.jsonl   meta.json\nTASK-NNN.json   hooks.log\nclaude/ (transcript snapshots)"]:::fs
        TRANSCRIPTS["~/.claude/projects/-app/CSID/\nsubagents/agent-TASK-NNN.jsonl\ntranscript.jsonl"]:::fs
    end

    BROWSER <-->|"WebSocket events\n(messages, status, debug, stats, satisfaction)"| CHATSERVICE
    SPAWN -->|"spawns ONCE per session\n(env: HOME CHAT_SESSION_DIR MODE)"| CLI
    SPAWN -->|"PTY stdin: user messages"| CLI
    CLI -->|"loads agents+hooks+skills+rules"| HARNESS
    CLI -->|"writes TASK-NNN.json\nhooks append hooks.log\nStop hook writes /tmp/pty-turn-done-CSID"| LOGS
    CLI -->|"writes JSONL transcripts"| TRANSCRIPTS
    WATCH -->|"tails (byte offsets)"| TRANSCRIPTS
    WATCH -->|"events"| TURN
    TURN -->|"appends events"| LOGS
    TAIL -->|"tails every 2500ms"| TRANSCRIPTS
    STORE -->|"reads + writes"| LOGS
    STATS -->|"reads"| LOGS
    STATS -->|"reads token+cost"| TRANSCRIPTS
```

---

## 2. Turn lifecycle — step by step

Full reference: [turn.md](turn.md).

| Step | Module | What happens |
|---|---|---|
| 1 | `turn.js` | Receives message from WebSocket queue, broadcasts `status:working=true` |
| 2 | `session-store.js` | Checks state + TASK-*.json presence: plain resume, or fresh session + `<intent>recovery</intent>` (`planResume`) |
| 3 | `pty-session.js` | Spawns the persistent PTY claude process if absent (`[--resume CSID]`), or reuses the live one; `send()` queues until the TUI prompt is ready, then writes the message |
| 4 | `transcript-watcher.js` | Tails the JSONL transcript: discovers the CSID on first sight, emits assistant/tool events, accumulates deduped token usage |
| 5 | `turn.js` | Per event: broadcasts `debug_raw`, runs the orchestrator text pipeline (title/widget strip, dedup, broadcast + `log.jsonl`), progress-bar + agent accounting |
| 6 | `subagent-tail.js` | Polls `~/.claude/projects/-app/CSID/subagents/` every 2500ms, broadcasts new lines to WebSocket |
| 7 | CLI / hooks | Planner writes `TASK-NNN.json`, hooks append `hooks.log`, agents write transcripts, worktrees created/merged |
| 8 | `pty-session.js` | Turn completion = `Stop` hook sentinel `/tmp/pty-turn-done-<CSID>` (positive signal); 120s silence fallback (degraded — `classifyTurn` decides completed vs failed) |
| 9 | `turn.js` (finally) | Folds per-spawn usage into cumulative stats, snapshots `~/.claude/projects/-app/CSID/` to `/logs/UUID/claude/`, updates `meta.json`, broadcasts `status:working=false`, drains the queue |
| 10 | `turn.js` (background) | COMPLEX waves run as background turns: `Agent({ run_in_background: true })` completions wake the idle TUI; an inactivity watchdog + heartbeat driver nudge or give up |

The documentator (Mode 2) is dispatched by the orchestrator itself at POST-DEV (background `Agent` call) once the user validates the result — no chat-service trigger.

---

## 3. WebSocket event types

| Event type | Emitted when | Key fields |
|---|---|---|
| `status` | turn starts / ends | `{ working: true\|false }` |
| `message` | assistant text or user message | `{ role, content, ts }` |
| `debug_raw` | every transcript event from Claude | `{ event }` |
| `debug` | tool use detected | `{ tool, input, agent }` |
| `satisfaction_ask` | orchestrator signals satisfaction check | `{ header, body, yes, no }` |
| `rate_limited` | Claude hits rate limit | `{ resetsAt }` |
| `state` | session state changes | `{ state }` |
| `queue_updated` | new message queued | `{ queuedIds }` |
| `title` | session title set | `{ title }` |
| `stats` | token/cost update | `{ tokensUsed, costUsd, activeAgents }` |

---

## 4. Session & ID reference

| Identifier | Example | Source |
|---|---|---|
| chat session UUID | `a1b2c3d4-e5f6-7890-1234-567890abcdef` | `randomUUID()` in `session-store.js` |
| SESSION_SHORT | `a1b2c3d4` | first UUID segment — `cut -d'-' -f1` in hooks |
| claudeSessionId (CSID) | `conv_0123abc` | Claude CLI's own ID, discovered by `transcript-watcher.js` from the transcript's `session_id` |
| CHAT_SESSION_DIR | `/chat-service/logs/UUID` | env var set by `pty-session.js` |
| transcript base | `~/.claude/projects/-app/CSID/` | CWD `/app` with `/` replaced by `-` |
