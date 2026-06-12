# Chat-Service — Architecture reference

Quick orientation for a fresh session. Covers only chat-service entities and their relationships.

---

## 1. Components & connections

chat-service is a Node.js server (:8080) that sits between the browser and the Claude CLI. Its job: receive a user message over WebSocket, spawn `claude -p` as a subprocess, stream its stdout into `log.jsonl` and broadcast events to the browser in real time, then aggregate the results into session stats. It never directly modifies CRM code — that's done by the agents running inside the CLI subprocess.

**Modules** (`chat-service/lib/`):

| Module | File | Role |
|---|---|---|
| PTY session | `server/pty-session.js` | Spawns the persistent interactive `claude` process in a PTY, sets env vars (`CHAT_SESSION_DIR`, …) |
| Turn helpers | `server/turn-helpers.js` | Assistant-message extraction, `FULL_SETUP` intent rewrite, resume planning, user-facing error text |
| Turn orchestrator | `server/turn.js` | Streams Claude stdout, extracts `claudeSessionId`, appends to `log.jsonl`, snapshots transcripts at turn end, triggers documentator |
| Session store | `server/session-store.js` | Generates chat UUID, reads/writes `meta.json`, detects `TASK-*.json` to decide resume vs recovery |
| Subagent tailer | `server/subagent-tail.js` | Polls `~/.claude/projects/-app/CSID/subagents/` every 2500ms, broadcasts new lines to WebSocket |
| Stats aggregator | `lib/stats/` (8 modules) | Read-only — folds `log.jsonl` + `TASK-*.json` + `hooks.log` + subagent transcripts into `GET /api/stats` response |
| Documentator spawner | `server/documentator-spawn.js` | 30s debounce after `turn=completed` + merged tickets — spawns fresh documentator CLI session (Mode 2, silent) |
| Deploy routes | `server/deploy-routes.js` | SSE channel `/api/deploy/events`, 6-phase pipeline (vite build → supabase → wrangler), independent of chat WebSocket |

**The Claude CLI subprocess** loads the harness (`~/.claude/` — agents, hooks, skills, rules, settings.json) and is the only thing that touches the CRM code. chat-service communicates with it through:
- **Input**: command-line args + env vars + the prompt (see `claude-cli-fake-contract.md`)
- **Output**: newline-delimited JSON on stdout (`stream-json` format)
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
        SPAWN(["pty-session.js\nspawns persistent interactive claude in a PTY\nsets CHAT_SESSION_DIR env"]):::svc
        TURN(["turn.js\nstreams Claude stdout line by line\nappends events to log.jsonl\ncaptures claudeSessionId from first event\nsnapshots transcripts at turn end"]):::svc
        STORE(["session-store.js\nrandomUUID() -> chat session UUID\nwrites + reads meta.json\ndetects TASK-*.json -> recovery vs resume decision"]):::svc
        TAIL(["subagent-tail.js\npolls ~/.claude/projects/-app/CSID/subagents/\nevery 2500ms -> broadcasts to WebSocket"]):::svc
        STATS(["stats/ (8 modules)\nphases . hooks . tickets . subagents . tools\nread-only, called by GET /api/stats"]):::svc
        DOCSPAWN(["documentator-spawn.js\n30s debounce after turn=completed\nrequires >=1 TASK-*.json status=merged\nspawns fresh session, env DOCUMENTATOR_RUN=1"]):::svc
        DEPLOY(["deploy-routes.js\nSSE channel /api/deploy/events\n6-phase pipeline (vite build, supabase, wrangler)\nindependent of chat WebSocket"]):::svc
    end

    CLI(["Claude CLI subprocess\nclaude --output-format stream-json\n--dangerously-skip-permissions\n[--resume CSID] -p PROMPT"]):::ext

    subgraph HARNESS ["Harness  ~/.claude/  (extractable)"]
        direction LR
        AGENTS["agents/ (8 .md)\norchestrator . planner . developer\nmerger . quality-reviewer\ntest-validator . simple-developer\ndocumentator"]:::agent
        HOOKS_SH["hooks/ (24 .sh)\nPreToolUse . SubagentStart\nSubagentStop . PostToolUse"]:::hook
        MISC["skills/ (8)   rules/ (9)\nsettings.json"]
    end

    subgraph FS ["Filesystem"]
        direction TB
        LOGS["/chat-service/logs/UUID/\nlog.jsonl   meta.json\nTASK-NNN.json   hooks.log\nclaude/ (transcript snapshots)"]:::fs
        TRANSCRIPTS["~/.claude/projects/-app/CSID/\nsubagents/agent-TASK-NNN.jsonl\ntranscript.jsonl"]:::fs
    end

    BROWSER <-->|"WebSocket events\n(messages, status, debug, stats, satisfaction)"| CHATSERVICE
    SPAWN -->|"reads system prompt"| AGENTS
    SPAWN -->|"spawns\n(env: HOME CHAT_SESSION_DIR MODE [CSID])"| CLI
    CLI -->|"loads agents+hooks+skills+rules"| HARNESS
    CLI -->|"writes TASK-NNN.json\nhooks append hooks.log"| LOGS
    CLI -->|"writes agent transcripts"| TRANSCRIPTS
    CLI -->|"stdout stream-json"| TURN
    TURN -->|"appends events"| LOGS
    TAIL -->|"tails every 2500ms"| TRANSCRIPTS
    STORE -->|"reads + writes"| LOGS
    STATS -->|"reads"| LOGS
    STATS -->|"reads token+cost"| TRANSCRIPTS
    DOCSPAWN -->|"spawns (30s debounce)"| CLI
```

---

## 2. Turn lifecycle — step by step

| Step | Module | What happens |
|---|---|---|
| 1 | `turn.js` | Receives message from WebSocket queue, broadcasts `status:working=true` |
| 2 | `session-store.js` | Checks state + TASK-*.json presence: `--resume CSID` or fresh + `<intent>recovery</intent>` |
| 3 | `pty-session.js` | Spawns (or reuses) the persistent PTY claude process for the session |
| 4 | `turn.js` | Reads stdout line by line, extracts `claudeSessionId` from first `system/init` event, broadcasts each event, appends to `log.jsonl` |
| 5 | `subagent-tail.js` | Starts polling `~/.claude/projects/-app/CSID/subagents/` every 2500ms, broadcasts new lines to WebSocket |
| 6 | CLI / hooks | Planner writes `TASK-NNN.json`, hooks append `hooks.log`, agents write transcripts, worktrees created/merged |
| 7 | `turn.js` (finally) | Snapshots `~/.claude/projects/-app/CSID/` to `/logs/UUID/claude/`, updates `meta.json`, broadcasts `status:working=false` |
| 8 | `documentator-spawn.js` | If `state=completed` AND merged tickets: 30s debounce then spawns documentator (Mode 2, silent) |

---

## 3. WebSocket event types

| Event type | Emitted when | Key fields |
|---|---|---|
| `status` | turn starts / ends | `{ working: true\|false }` |
| `message` | assistant text or user message | `{ role, content, ts }` |
| `debug_raw` | every stream-json event from Claude | `{ event }` |
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
| claudeSessionId (CSID) | `conv_0123abc` | Claude CLI's own ID, from `event.session_id` in stdout |
| CHAT_SESSION_DIR | `/chat-service/logs/UUID` | env var set by `pty-session.js` |
| transcript base | `~/.claude/projects/-app/CSID/` | CWD `/app` with `/` replaced by `-` |
