# Chat UI — Design Spec

**Date:** 2026-04-17
**Status:** Approved

---

## Overview

Add a web-based chat interface to the Docker container so non-technical users can customize the Atomic CRM application by conversing with Claude in natural language. The chat overlays the live CRM (visible in an iframe) and auto-opens on page load.

---

## Goals

- Allow a non-technical user to request CRM customizations (code changes) via a chat UI
- Show real-time progress updates in plain language — never expose file names, diffs, or technical errors
- Claude responds in whatever language the user writes in
- Keep the existing ttyd terminal on port 7681 for developers

---

## Out of Scope (v1)

- Chat history persistence across container restarts
- Merging `code-reviewer` + `security-reviewer` into one agent (separate task)
- Multi-session / multi-tab support
- User authentication on the chat
- Support for `full` mode (Supabase) — demo/fakerest only

---

## Architecture

### Ports

| Port | Service | Notes |
|------|---------|-------|
| 5173 | Vite CRM | Unchanged |
| 7681 | ttyd terminal | Unchanged |
| 8080 | Chat service | New |

### Components

**`chat-service/server.js`** — Node.js backend that:
- Serves static chat UI files
- Exposes a WebSocket endpoint
- Drives Claude Code via the `@anthropic-ai/claude-code` SDK
- Filters SDK events: passes only orchestrator text messages to the frontend, ignores tool_use events

**`chat-service/public/index.html`** — Wrapper page that:
- Embeds the CRM in a `<iframe>` pointing at `localhost:5173`
- Overlays the chat widget (open by default on first load)

**`chat-service/public/chat.js`** — Vanilla JS chat UI (no framework)

**`chat-service/public/chat.css`** — Chat overlay styles

**`claudeConfig/.claude/agents/chat-orchestrator.md`** — New agent with strict instructions:
- Respond in the user's language (multilingual)
- Never mention file names, code, diffs, or technical errors in user-facing messages
- Follow the `agent-team` skill workflow
- Translate sub-agent technical results into plain-language status updates

---

## Agent Workflow

The `chat-orchestrator` dispatches to the existing agent team following this sequence:

```
planner → developer → reviewer + test-validator (parallel) → merger
```

- **planner**: decomposes the user request into atomic tickets
- **developer**: implements in a git worktree (`/worktrees/TASK-XXX/`)
- **reviewer**: code quality + security (existing `code-reviewer` and `security-reviewer` run in parallel until they are merged)
- **test-validator**: verifies tests pass and feature is reachable
- **merger**: merges worktree → main, runs post-merge tests

The `architect` agent is excluded from this workflow. It will be reintroduced if the developer's output proves to require an extra validation layer.

Sub-agent technical output (file edits, test results, reviewer verdicts) remains in the orchestrator's internal context and is never surfaced to the user. The orchestrator translates each step into a short plain-language status message.

**Error handling:** if any agent returns `BLOCKED`, the orchestrator tells the user: *"Something went wrong with this change. Want me to try a different approach?"*

---

## Data Flow

```
1. User opens localhost:8080
   → backend sends welcome: "Hello, ready to build your dreaming CRM?
     Ask me in any language"

2. User types a message
   → WebSocket → Node.js backend
   → Claude Code SDK: query({ prompt, cwd: '/app', agent: 'chat-orchestrator' })

3. SDK streams events:
   ├─ text event (orchestrator speaks)  → WebSocket → chat UI  [displayed]
   └─ tool_use event (internal work)    → "working..." indicator [summarized]

4. Orchestrator runs agent-team workflow:
   planner → developer → reviewer + test-validator → merger

5. Successful merge → Vite hot-reload → CRM iframe updates live
```

---

## CRM Stability

Agents work in isolated git worktrees (`/worktrees/TASK-XXX/`). The `/app/src` directory — served by Vite on port 5173 — is only modified at merge time, after all reviewers and tests have passed. The CRM in the iframe remains stable throughout the development cycle.

---

## Authentication

The service supports two authentication modes, checked in order:

1. **API key** — `ANTHROPIC_API_KEY` environment variable, used if present
2. **OAuth** — token stored in `/home/developer/.claude/` via `claude login` (run once via the ttyd terminal)

`entrypoint.sh` checks for at least one valid auth method and exits with a clear error message if neither is present.

The `/home/developer/.claude/` directory is backed by a named Docker volume (`claude-auth`) so OAuth tokens persist across container restarts without touching the host filesystem.

---

## Files to Create

```
chat-service/
  server.js
  public/
    index.html
    chat.js
    chat.css
```

```
claudeConfig/.claude/agents/chat-orchestrator.md
scripts/start-chat.sh
```

## Files to Modify

```
Dockerfile               — expose port 8080, COPY chat-service/
supervisord.demo.conf    — add chat-service process
supervisord.full.conf    — add chat-service process
entrypoint.sh            — add chat URL to startup banner, update auth check
docker-compose.yml       — map port 8080, add claude-auth volume
```

---

## Session

- One Claude Code session per container instance
- Chat history lives in memory for the container's lifetime
- Container restart = fresh session (consistent with fakerest data reset)
- Claude Code maintains conversation context between messages within the same session

---

## Code Language

All source files written in English.
