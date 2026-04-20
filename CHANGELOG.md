# CRM Builder — Changelog

Chronological log of everything changed in this repo, with **why** each change was made. Oldest first.

---

## Phase 1 — Agent skeleton (early April 2026)

Dates: 2026-04-09 to 2026-04-16

Foundational work establishing the multi-agent system that will later be driven by the chat service.

- **2026-04-09** — Initial `.claude` config: permissions, default settings.
- **2026-04-13** — First skills added: `agent-team`, `e2e-conventions`, `pr-creation`, `reflection-writing`, `worktree-detection`.
- **2026-04-14** — First agent roles created: `planner`, `architect`, `developer`, `code-reviewer`, `security-reviewer`, `test-validator`, `merger`, `devops`, `project-manager`. Each with specific model routing and tool lists. Rules file added (`coding-style.md`, `testing.md`, `security-triggers.md`, etc.). Ticket persistence introduced (`docs/tickets/TASK-XXX.json`).
- **2026-04-15** — Fixes on `developer`, `test-validator`, `merger` agents. JSON formatting corrected in settings.
- **2026-04-16** — Unit test hooks wired in `SubagentStop(developer)`. Hook triggers refined.

**Why**: set up a multi-agent team (planner → developer → reviewers → merger) before the chat layer, so the chat service can orchestrate existing agents instead of inventing them.

---

## Phase 2 — Chat service scaffolding (2026-04-17)

- **Add chat UI design + plan** — documented the WebSocket + claude CLI architecture before coding.
- **Add `chat-service/` package** — Node.js server with `ws` dependency, serves static assets + WebSocket on port 8080.
- **Add `chat-orchestrator` agent** — user-facing agent running as the main session, delegates to sub-agents via the `Agent` tool.
- **Backend `server.js`** — spawns `claude -p --output-format stream-json` per user message, relays stream events over WebSocket. First version used the SDK.
- **Chat UI frontend** — overlay widget with iframe to CRM, expand/debug buttons, choice buttons for mode selection.
- **Integrate chat UI** — fixed path traversal, WebSocket message parsing, API key forwarding, Docker socket permissions.

**Why**: let non-technical users request CRM customizations in natural language without touching the CLI or knowing about agents.

---

## Phase 3 — OAuth persistence (2026-04-17)

Issue: OAuth tokens from `claude login` were not surviving container restarts.

- **Fix `entrypoint.sh`**: start ttyd for `claude login` when no auth credentials found (new install path).
- **Dockerfile symlink** `ln -sf .claude/.claude.json /home/developer/.claude.json` — `.claude.json` lives outside the `.claude/` dir, would not be captured by the volume. Symlink redirects it into the volume.
- **`export HOME=/home/developer`** before `exec ttyd` — ttyd was running as root, writing credentials to `/root/.claude/` instead of `/home/developer/.claude/`.
- **`chown -R developer:developer /home/developer/.claude`** in entrypoint — credentials written during bootstrap may be root-owned.
- **Check both credential filenames** (`.credentials.json` AND `credentials.json`) — Claude CLI changed the convention.
- **Force-copy image's `settings.json` over the volume** at each boot — volume may have a stale version.

**Why**: reboot should never require a re-login if credentials exist.

---

## Phase 4 — SDK → CLI migration (2026-04-17)

Issue: the `@anthropic-ai/sdk` `unstable_v2_createSession` does NOT support OAuth, only API keys. Users relying on OAuth got 401.

- **Replace SDK with `spawn('claude', ...)`** in `server.js`.
- Flags used: `--output-format stream-json --verbose --dangerously-skip-permissions -p <prompt>`.
- `--resume <sessionId>` for multi-turn continuation within a WebSocket connection.
- System prompt (chat-orchestrator content minus frontmatter) wrapped in `<instructions>...</instructions>` and prepended to every user message.
- `stdio: ['ignore', 'pipe', 'pipe']` to avoid "no stdin" warnings.

**Why**: support both API key and OAuth flows; SDK was a dead-end for OAuth users.

---

## Phase 5 — Chat UI improvements (2026-04-17)

- **Choice buttons at startup** — two modes: `FULL_SETUP` (interview) or `QUICK_EDIT` (direct).
- **Widget styling** — bigger widget (420×620), spinner, expand button (50vw/100vh), debug toggle.
- **Debug panel** — raw JSON event dump in `<details>` with one-line summary. Filters noise (rate_limit, thinking-only, init). Summarizes `assistant`, `tool_use`, `task_progress`, `result`.

**Why**: non-technical users need clarity, dev-testers need raw visibility without copy-paste.

---

## Phase 6 — Model + tools + orchestrator scope (2026-04-20 morning)

Discovery: orchestrator was running on Opus-4-6 despite our `--model sonnet` flag. Root cause: the volume-mounted `chat-orchestrator.md` was a stale copy with `model: claude-opus-4-6`, not the repo's `model: sonnet`.

- **Fix volume staleness** — entrypoint now syncs `agents/`, `skills/`, `hooks/`, `rules/` from image to `/home/developer/.claude/` at each boot (with `rm -rf` of target first to also propagate deletions).
- **Remove dead `MODEL_MAP`** — use aliases (`sonnet`, `opus`, `haiku`) directly since Claude CLI accepts them.
- **Restrict orchestrator tools** — frontmatter set to `Agent, TeamCreate, TeamDelete, Skill, Read, Grep, Glob` (no Write/Edit/Bash). Force delegation of implementation work.
- **Inject `<mode>{value}</mode>`** in system prompt from `process.env.MODE` — removes need for `echo $MODE` via Bash.
- **Explicit complexity rules in `chat-orchestrator.md`** — listed what counts as simple vs complex (schema change = complex, label/color = simple).
- **"Trust the developer's report"** directive — orchestrator must not spawn verification agents after the dev finishes; re-check only if the dev explicitly reports failure.
- **Forbid Bash-based file writes in `developer.md`** — `sed -i`, `cat > file`, `python3 write_text` etc. blacklisted. Must use Edit/Write tools (so PostToolUse hooks fire).

**Why**: multiple observed timeouts were traced to the orchestrator abusing Bash to read/write files, spawning multiple verification agents in loops, and sub-agents bypassing Edit via `sed -i` (breaking the prettier hook chain).

---

## Phase 7 — Plugin + MCP cleanup (2026-04-20)

- **Removed plugins**: `claude-md-management`, `code-simplifier`, `feature-dev` (12 → 9). Gain: smaller context, faster startup.
- **Kept**: code-review, commit-commands, context7, frontend-design, playwright, security-guidance, supabase, superpowers, typescript-lsp.
- **Install `typescript-language-server` globally** in Dockerfile — was referenced by `typescript-lsp` plugin but never installed, causing `ENOENT`.
- **Fix `/ms-playwright` permissions** — changed `chmod a+rx` to `a+rwx` so sub-agents can create MCP chrome profiles.
- **`disabledMcpjsonServers`** added to settings.json — 14 claude.ai MCPs disabled (Asana, Atlassian, Box, Canva, Excalidraw, Figma, Gmail, Google Drive, HubSpot, Intercom, Linear, monday.com, Notion, tldraw). Kept: `claude.ai Atomic CRM`, `claude.ai Context7`.

**Why**: cold-cache startup was costing ~$0.17 just for a welcome message because of the 26K tokens of plugin/MCP tool definitions loaded into context. Dropping unused ones cuts ~40% of that.

---

## Phase 8 — Observability & tests suite (2026-04-20)

### Token display
- `server.js` tracks `tokensIn`, `tokensOut`, `costUsd`, `activeAgents` per WebSocket connection.
- Emits a `stats` event after each `result`.
- Client displays `🤖 N · X in · Y out · $Z` below the input (hidden when 0 agent active).

### Structured session logs
- Each WS connection creates `chat-service/logs/session-<ISO-ts>.jsonl`.
- Every inbound/outbound event logged as one JSON line.
- Bind-mounted to host via `./chat-logs/` for direct read access (dev mode only).
- `.gitignore` excludes `chat-logs/` and `test.md`.

### User-friendly errors
- Rate limit → minutes until reset.
- OAuth expired → "Access has expired. Please contact your administrator."
- Network error → "Unable to reach the service right now."
- Generic → "Something went wrong. Want to try again?"
- Messages hardcoded in **English** (default user-facing language).

### Test runner / baseline
- `chat-service/tests/cases.json` — test case definitions (prompt + expectations).
- `chat-service/tests/run.js` — WebSocket-based runner. Reconnects per case (cold cache for fair comparison). Validates `mustInvoke`/`mustNotInvoke` + duration + cost thresholds.
- `chat-service/tests/results/baseline.json` — reference run; subsequent runs compare against it.
- `npm run bench` — compare vs baseline. `npm run bench:update` — save as new baseline.
- Git-ignored `run-*.json` files.
- 5 cases: label change, color change, hide element, add field (medium / agent-team), ambiguous prompt.

**Why**: track regressions when we change prompts/hooks/skills, avoid copying chat output manually into test.md.

---

## Phase 9 — Hook hardening (2026-04-20)

- **`circuit-breaker.sh`** rewritten: scope counter per `session_id` (not global), auto-reset after 1 hour, raise limit 3 → 30. Before: counter was shared across all agents in a Docker container, blocking sub-agents after 3 Bash calls cumulated across the whole session.
- **Removed from `settings.json`**: `prettier-on-edit.sh` (redundant with atomic-crm's `/app/.claude/hooks/format-file.sh`), `test-on-complete.sh` (file never existed).
- **Moved `typecheck-on-commit.sh` to SubagentStop(developer)** — runs typecheck right after developer stops, not after the whole task.
- **`run-e2e-tests.sh`** — skip when `MODE=demo` (Supabase not running at localhost:54341).
- **Removed `token-stats.sh` + `TeammateIdle` hook** — user decision, not useful.
- **Deleted dead `format-file.sh`** from our hooks dir (was never wired, and atomic-crm has its own).

**Why**: every Stop event emitted `stop-hook-error` because one or more hooks were failing silently (missing file, wrong event type, e2e trying Supabase in demo). Hooks now clean and verified functional.

---

## Phase 10 — Reviewer consolidation (2026-04-20 afternoon)

- **Merged `code-reviewer.md` + `security-reviewer.md` → `quality-reviewer.md`**. Single agent covers spec compliance + code quality + React/backend patterns + RLS + secrets + injections. One parallel review instead of two.
- **Simplified `test-validator.md`** — removed "Step 1: typecheck + unit tests" since hooks already run those. Keeps integration check + vite smoke test + optional screenshots.
- **Updated `chat-orchestrator.md` and `agent-team/SKILL.md`** — TeamCreate now spawns 2 reviewers (quality-reviewer + test-validator) instead of 3.
- **Normalize model values** to aliases (`sonnet`, `opus`, `haiku`) across all agent frontmatters. The Claude Code linter only accepts these aliases.

**Why**: trace of test 4 showed ~30% of the time spent on sequential review coordination. Fewer reviewers = faster cycle, still covers all concerns.

---

## Phase 11 — Skill invocation fix (2026-04-20 afternoon)

Discovery: sub-agents (developer, test-validator) never invoked `frontend-dev` / `backend-dev` skills despite explicit instructions in their prompts.

- **Root cause**: `developer.md` frontmatter tools list lacked `Skill` — the agent was physically unable to call `Skill({...})`.
- **Fix**: added `Skill` to developer's tools.
- **Promoted `tessl__playwright-testing` → `.claude/skills/playwright-testing/`** so Claude Code auto-discovers it. Added to developer's skills list.

**Why**: skills provide project-specific conventions (file paths, patterns) that aren't in AGENTS.md. Without them, sub-agents re-discover the same structure via many `grep`/`ls` calls.

---

## Phase 12 — Direct vs Ticket mode on developer (2026-04-20 afternoon)

- **Added "Two invocation modes"** section at the top of `developer.md`:
  - **Direct mode** — caller's prompt describes the change inline (no `TASK-XXX.json`). Simple change in ≤ 2 files → go straight to implementation. Skip planning, audit, reflection reading, plan format.
  - **Ticket mode** — caller references `TASK-XXX.json`. Full workflow (read ticket, audit, evaluate, plan, implement, reflection).

**Why**: before this fix, the developer went through heavy `read tickets → codebase audit → architecture evaluation → plan format → implement` even for a one-line label change. The overhead was dominating the cost for simple edits.

---

## Phase 13 — Dev workflow helpers (2026-04-20)

- **Bind mount `./claudeConfig/.claude:/root/.claude:ro`** in docker-compose (dev only) so edits to agents/skills/hooks propagate without rebuild. Entrypoint re-syncs on each boot.
- **Bind mount `./chat-logs:/chat-service/logs`** so session logs appear directly in the repo.
- **Dockerignore + gitignore** updated: `.env`, `chat-logs/`, `test.md`, `chat-service/tests/results/run-*.json`.
- **Comments in docker-compose** noting these are dev-only and must be removed for production.

**Why**: test iteration was slow (rebuild + recreate on every prompt tweak). Bind mount means a `docker restart` picks up changes in <10s.

---

## Open items / known limits

- **`medium-new-field` test** times out at 15 min (bumped to 35 min). Real agent-team flow on a multi-file feature naturally takes 20-30 min.
- **Skills `backend-dev`/`frontend-dev` still rarely invoked** even with `Skill` tool added — AGENTS.md content eclipses the need for most cases. Monitoring.
- **Orchestrator occasionally generates malformed `Agent({ subagent_type: None })` calls** when confused. Not blocking but wasteful.
- **OAuth requires re-login after `docker compose down -v`** — expected behavior (volume removed).

---

_Last updated: 2026-04-20_
