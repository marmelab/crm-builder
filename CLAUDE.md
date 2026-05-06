# Atomic-CRM Builder

Dockerised Claude Code sandbox that lets non-technical users customise [Atomic CRM](https://github.com/marmelab/atomic-crm) through a chat UI. A user describes a change in plain language; a team of 9 agents ships it inside a per-ticket git worktree, reviews, tests, merges locally.

## Repository layout

| Path | Role |
|---|---|
| [Dockerfile](Dockerfile) | Single image, `node:22-bookworm-slim` base. Installs ttyd, chromium, Playwright, Supabase CLI, Docker CLI, Claude Code, clones `marmelab/atomic-crm` into `/app`, `git init`s it, creates the `developer` user. |
| [entrypoint.sh](entrypoint.sh) | Auth check → syncs `/root/.claude/{agents,skills,hooks,rules}` into `/home/developer/.claude` → applies the mode-appropriate `App.tsx` variant → starts Supabase (full only) → `exec supervisord`. |
| [docker-compose.yml](docker-compose.yml) | Two profiles: `demo` (FakeRest, ports 5173/7681/8080) and `full` (Supabase, `network_mode: host`, needs Docker socket). |
| [supervisord.demo.conf](supervisord.demo.conf) / [.full.conf](supervisord.full.conf) | 3 programs: `crm-frontend` (Vite :5173), `ttyd` (:7681), `chat-service` (:8080). |
| [app-variants/](app-variants/) | Two `App.tsx` flavours: `App.fakerest.tsx` (browser-only data) and `App.supabase.tsx`. |
| [claudeConfig/.claude/](claudeConfig/.claude/) | Agents, skills, hooks, rules — bind-mounted read-only in dev and copied into `/home/developer/.claude` at boot. |
| [chat-service/](chat-service/) | Node server: static public/, WebSocket, `/api/stats`, spawns `claude` CLI per user turn. |
| [scripts/](scripts/) | `switch-mode.sh` (swap data provider at runtime), `ttyd-session.sh` (tmux session for the web terminal). |

## Runtime model

```
supervisord (pid 1)
  ├─ crm-frontend   npm run dev --host 0.0.0.0   :5173
  ├─ ttyd           /usr/local/bin/ttyd           :7681  → tmux → claude CLI
  └─ chat-service   node /chat-service/server.js  :8080  → WebSocket + spawn(claude -p …)
```

The chat-service is the non-technical entry point. `ttyd` is the raw terminal for power users (the original `claude --dangerously-skip-permissions` flow).

Volumes (see [docker-compose.yml](docker-compose.yml)):
- `crm-app` → `/app` (the entire atomic-crm checkout: `src/`, `.git/`, `supabase/`, `e2e/`, `public/`, configs at root, `node_modules/`, `worktrees/`, `docs/`)
- `claude-auth` → `/home/developer/.claude` (OAuth tokens across restarts)
- `supabase-cache` → `/root/.docker` (full mode only)

Single-volume strategy: keeps `/app/node_modules` and `/app/worktrees` on the **same device** so `cp -al /app/node_modules /app/worktrees/TASK-XXX/node_modules` produces hard links (zero disk overhead, vitest cache stays per-worktree). Worktrees are gitignored via `.gitignore`. Entrypoint compares `package-lock.json` hash against `/app/.npm-ci-hash` and runs `npm ci` if an agent modified deps. To wipe everything (atomic-crm checkout, commits, deps): `docker compose down -v`.

## Chat-service

Single [server.js](chat-service/server.js) (~785 lines). Key invariants:

- **One runtime per session**, many WebSockets per runtime. Runtime holds the `claudeSessionId`, a queue, cumulative stats, and the Set of connected clients. Messages are *broadcast* to every client so multiple tabs stay in sync.
- **Session persistence**: append-only `log.jsonl` per session + `meta.json` for listing. Visible messages are derived from the log on demand (`messagesFromLog`). The log is the source of truth; `meta` is a cache.
- **Claude spawn**: `claude --output-format stream-json --verbose --dangerously-skip-permissions --model <from frontmatter> [--resume <id>] -p <prompt>`. The orchestrator model and system prompt are parsed from [chat-orchestrator.md](claudeConfig/.claude/agents/chat-orchestrator.md)'s frontmatter at boot. The prompt body is wrapped in `<instructions>…</instructions>` and prefixed with `<mode>demo|full</mode>`.
- **Stats tracking** ([chat.js](chat-service/public/chat.js) consumes `stats` frames):
  - `tokensUsed` = `input_tokens + cache_creation_input_tokens + output_tokens` (cache-read is excluded — cheap rehydration, not billed against the user's budget).
  - `total_cost_usd` is cumulative *within* a spawn → store as `costUsdCurrentSpawn`, commit to `costUsd` only on turn end.
  - `activeAgents` only counts `task_type === 'local_agent'` (filters out Bash, MCP, etc.). Tracked via a `Set<task_id>`; start/complete pairs match on `task_id`.
- **Title regeneration**: first auto-title is a slice of the first message. On the 2nd user message, a one-shot Haiku call regenerates the title from the first exchanges.

### Stats aggregator

[lib/stats.js](chat-service/lib/stats.js) (~687 lines). Exposed via `GET /api/stats?sessionId=<uuid>`.

Builds a *server-side* timeline from `log.jsonl` + `hooks.log`:
- phases (agent_processing, tool_use, stream_gap, …)
- teams (`TeamCreate(task_id)` → `team_name`)
- children (sub-agents under each phase)
- top N ops by duration and cost
- skills / rules / hooks read counts per agent
- errors (4 kinds) + retries (3 heuristics: `(retry)` suffix, triggered-by-error, close-consecutive-same-description)

Tests live in [chat-service/test/](chat-service/test/) — `node --test` + JSONL fixtures. Run with `npm test` inside `chat-service/`.

### Bench harness

[chat-service/tests/run.js](chat-service/tests/run.js) replays [cases.json](chat-service/tests/cases.json) over the real `ws://localhost:8080`. Before each case:

```
cd /app && git checkout -- src/ && cp /app-variants/App.{fakerest|supabase}.tsx src/App.tsx
```

Writes `tests/results/run-<ISO>.json`, diffs against [baseline.json](chat-service/tests/results/baseline.json). `--update-baseline` rewrites the reference.

The harness records 4 dimensions per case:
- **cost / time / tokens** (always-on, blocking on `maxCostUsd` / `maxDurationMs`)
- **agent shape** (`mustInvoke` / `mustNotInvoke`, blocking)
- **A — file set + diff size** (`mustModify` / `mustNotModify` / `expectedDiffStats`, soft warnings)
- **C — Playwright check** (`tests/checks/<id>.js`, blocking)

Per-case full diffs are archived to `chat-service/tests/results/<runTs>/<caseId>.patch` for inspection when something fails. Override the target container with `BENCH_CONTAINER=...` and the CRM URL used by C-checks with `CRM_URL=http://localhost:6174`.

## Agent team

8 agents in [claudeConfig/.claude/agents/](claudeConfig/.claude/agents/). Each one: frontmatter (name, description, model, tools, skills) + prose. Models deliberately scoped:

| Agent | Model | Role |
|---|---|---|
| chat-orchestrator | sonnet | User-facing. Classifies, routes, narrates. Conducts the SETUP interview directly via the `setup-interview` skill (no sub-agent). |
| planner | sonnet | Decomposes need → atomic tickets (JSON) with waves + file-path hints. |
| architect | opus | Spec gatekeeper (before plan), plan approver (after). |
| developer | opus | Plans, implements, commits inside a worktree. Mode 2 = reflection. |
| quality-reviewer | sonnet | Code quality + security (semantic only, hooks own validation). |
| test-validator | haiku | Integration wiring, e2e presence, reachability. |
| merger | haiku | `git merge --no-ff` to main, remove worktree. **Never `git add` / `git commit` itself** — only `git merge` and `git reset --hard HEAD` on `/app`. |
| devops | sonnet | One-time bootstrap (fork, Supabase, env, deploy). |

The full lifecycle is encoded in the [agent-team](claudeConfig/.claude/skills/agent-team/) skill (single source of truth for dispatch order).

The skill uses a **single-team Option C** layout: per wave, the lead does ONE `TeamCreate({team_name: "tickets"})` and dispatches `3×N + 1` members in one message — three per-ticket members (developer + 2 reviewers) per ticket plus **one shared `merger`** (bare name, singleton across the wave). The per-ticket members use deterministic suffixed names (`developer-TASK-001`, `quality-reviewer-TASK-001`, …). This layout is forced by a documented runtime constraint — *one team per lead at a time, no nested teams*. The single-merger choice eliminates `.git/index.lock` contention that would otherwise serialise N parallel mergers anyway. Each Agent's spawn prompt carries `TASK_ID` and `COUNTERPARTS`, isolating per-ticket conversations inside the shared team.

### Hooks gate the handoff

[claudeConfig/.claude/settings.json](claudeConfig/.claude/settings.json) wires:
- `PreToolUse / Bash` → silent-mode-check, circuit-breaker, block-bash-file-write, block-bash-validation.
- `PreToolUse / SendMessage` → validate-before-review (typecheck + prettier + unit-app + unit-functions + e2e). Triggered when a developer messages a reviewer or merger; first failure blocks the SendMessage. Replaces the older `SubagentStop / developer` chain.
- `PreToolUse / TeamDelete` → teamdelete-gate. Blocks TeamDelete if any non-lead member has not been gracefully shut down (no `shutdown_approved` in lead's inbox, or one is present but unread). The error message points to the skill's Phase 3 protocol.
- `PostToolUse / TeamDelete` → teamdelete-cleanup. Silently removes residual `~/.claude/teams/<team>/` after a successful TeamDelete.

Reviewers must never re-run validation — they check *meaning*; hooks guarantee *correctness*.

### Rules & skills

Rules ([claudeConfig/.claude/rules/](claudeConfig/.claude/rules/)): worktree-scope, agent-output-format, coding-style, testing, typescript, web-patterns, web-security, security-triggers.

Skills ([claudeConfig/.claude/skills/](claudeConfig/.claude/skills/)): agent-team, e2e-conventions, playwright-testing, reflection-writing, worktree-detection.

### Worktree scope — the load-bearing rule

Every ticket-scoped agent works inside `/app/worktrees/TASK-XXX/`. Reading `/app/src/...` while you have `/app/worktrees/TASK-XXX/src/...` is wrong: `/app` is on base, missing the ticket's changes, and editing there pollutes `main`. See [worktree-scope.md](claudeConfig/.claude/rules/worktree-scope.md) — it's the rule that has caused the most past incidents.

`Bash` calls are **stateless** — every command must start with `cd /app/worktrees/TASK-XXX && …`.

## Working on this repo (from the host)

```bash
# Build the image (once, ~5 min)
docker build -t atomic-crm-dev .

# Demo mode (fast iteration on UI)
docker compose --profile demo up

# Full mode (needs real DB for migrations, auth, storage)
docker compose --profile full up
```

In dev the following bind-mounts let you iterate without rebuilding (see [docker-compose.yml](docker-compose.yml) comments; remove before release):
- `./claudeConfig/.claude:/root/.claude:ro`
- `./entrypoint.sh:/entrypoint.sh:ro`
- `./chat-service/{server.js,public,lib}:…:ro`
- `./sessions:/chat-service/logs`

### URLs

| URL | Content |
|---|---|
| `http://localhost:5173` | Atomic CRM (Vite) |
| `http://localhost:8080` | Chat UI (`chat-service`) |
| `http://localhost:7681` | Web terminal (ttyd → Claude CLI) |
| `http://localhost:54323` | Supabase Studio (full mode only) |

### Running unit tests on the chat-service

```bash
cd chat-service && npm test             # node --test 'test/**/*.test.js'
cd chat-service && npm run test:smoke   # WebSocket smoke run
cd chat-service && npm run bench        # replays cases.json against ws://localhost:8080
```

## Conventions for code changes

- **Language**: UI strings, error messages, agent prompts, commit messages → **English**. Conversation with me (the maintainer) → **French**.
- **Ports are hardcoded**: 5173 / 7681 / 8080 / 54321 / 54323. Don't parametrise.
- **No secrets committed**. `ANTHROPIC_API_KEY` lives in `.env` (gitignored). OAuth tokens live in the `claude-auth` volume.
- **Chat-service style**: `node:` prefix on imports of `lib/*.js`; bare imports in `server.js` (pre-existing convention — don't harmonise).
- **Prefer rough dumps over fancy parsers** for debug UI. `JSON.stringify(event, null, 2)` in a `<details>` is usually what's wanted.
- **Don't add Opus agents casually**. Opus is reserved for architect + developer. Everything else is sonnet or haiku.

## Gotchas encountered in the past

- Counting every `task_started` as an active agent → counter drifts to 10+. Filter on `task_type === 'local_agent'` ([server.js:533](chat-service/server.js#L533)).
- Summing `total_cost_usd` event-by-event → massive inflation (it's already cumulative within a spawn). Replace, then commit on `result` ([server.js:556](chat-service/server.js#L556)).
- `git reset --hard HEAD` in `/app` silently reverts `App.tsx` to the upstream form (no data provider wired). The merger re-applies the variant via [entrypoint-helpers/apply-app-variant.sh](entrypoint.sh) baked into `/entrypoint-helpers/` at boot.
- The Atomic CRM upstream ships a `PostToolUse / format-file.sh` hook that fights our prettier-on-stop hook (edit → format → re-read different bytes → loop). Entrypoint overwrites `/app/.claude/settings.json` with `{"hooks": {}}` at boot.
- `node --test test/` (directory form) doesn't work on Node 25; use the glob: `node --test 'test/**/*.test.js'`.
- Cold cache is expensive (~$0.17 for a "Hi!" in previous measurements) because the CLI eagerly loads every installed plugin into the system prompt. Keep `enabledPlugins` minimal in [settings.json](claudeConfig/.claude/settings.json) and disable unused MCP servers.
