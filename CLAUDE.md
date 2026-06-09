# Atomic-CRM Builder

Dockerised sandbox: non-technical users describe CRM changes in chat → agent team ships them in git worktrees.

## Runtime

```
supervisord (pid 1)
  ├─ crm-frontend   :5173  (Vite, /app/src)
  └─ chat-service   :8080  (WebSocket + spawn claude -p)
```

Two compose profiles: `demo` (FakeRest) and `full` (Supabase, needs Docker socket).

`entrypoint.sh`: syncs `claudeConfig/.claude/` → `/home/developer/.claude`, applies App.tsx variant, overwrites `/app/.claude/settings.json` with `{"hooks":{}}` (prevents upstream format-file.sh fight with our hooks).

Single `crm-app` volume for `/app` — keeps `node_modules` and `worktrees/` on the same device so `cp -al` hard-links node_modules into each worktree (zero disk cost).

## Chat-service (`chat-service/`)

Node.js server (:8080) — WebSocket + REST. Entry: `server.js`. Split: `lib/server/` + `lib/stats/`.

Architecture reference: [docs/chat-service-architecture.md](docs/chat-service-architecture.md)

Key modules:
- `server/claude-spawn.js` — builds + spawns `claude -p`, injects `<mode>` + `<session_dir>` tags
- `server/turn.js` — streams stdout, writes `log.jsonl`, recovery decision, snapshots transcripts — see [docs/turn.md](docs/turn.md)
- `server/session-store.js` — chat UUID, `meta.json`, `TASK-*.json` detection
- `server/subagent-tail.js` — polls subagents/ every 2500ms → WS broadcast
- `lib/stats/` (8 modules) — read-only aggregation, `GET /api/stats` — see [docs/stats.md](docs/stats.md)
- `server/documentator-spawn.js` — 30s debounce after turn=completed + merged tickets (Mode 2)
- `server/deploy-routes.js` — SSE `/api/deploy/events`, 6-phase pipeline (vite build → supabase link → db push → functions → secrets → wrangler), independent of chat WS — see [docs/deploy.md](docs/deploy.md)

Tests: `cd chat-service && npm test` — uses glob `'test/**/*.test.js'` (directory form broken on Node 25).

## Agent team (`claudeConfig/.claude/agents/`)

| Agent | Model | Role |
|---|---|---|
| chat-orchestrator | sonnet | User-facing, routes, narrates. SIMPLE flow dispatches simple-developer + merger directly (no team). |
| planner | sonnet | Decomposes → tickets JSON with waves + file hints. |
| developer | opus | Implements + commits in worktree. Also writes ADRs in `adr/` when the change introduces a structural decision. Never writes SQL migrations — deploy-time only. |
| simple-developer | sonnet | 1-file cosmetic OR 1 single-field change on an existing entity (schema + view + type + form + show) OR 1 list filter reusing existing components (no new custom React component). No team, no review, never writes ADRs — SubagentStop hooks validate. POST-DEV runs if a migration was written. |
| quality-reviewer | sonnet | Semantic code + security review only. Never re-runs validation. |
| test-validator | haiku | Integration wiring + e2e presence. |
| merger | haiku | `git merge --no-ff` only. **Never `git add`/`git commit`**. |
| documentator | sonnet | Mode 1 — captures rules/skills to `~/.claude/local/` on explicit user request. Mode 2 — auto-runs at the end of every COMPLEX session, appends business knowledge to `/app/MEMORY.md` from the diff vs `origin/main`. |

Team layout (`agent-team` skill): one `TeamCreate` per wave, `3×N + 1` members in one dispatch (developer + 2 reviewers per ticket + one shared merger). Constraint: one team per lead, no nested teams. Single merger eliminates `.git/index.lock` contention.

### Hooks (`claudeConfig/.claude/settings.json`)

- `PreToolUse / Bash|Read|Grep|Glob|SendMessage` → member-idle-gate
- `PreToolUse / Bash` → silent-mode-check, circuit-breaker, block-bash-file-write, block-bash-validation, block-orchestrator-merge, restrict-documentator-bash
- `PreToolUse / Write|Edit` → restrict-documentator-write
- `PreToolUse / SendMessage` → block-premature-shutdowns, validate-before-review (typecheck + prettier + unit + e2e — blocks developer→reviewer/merger on failure)
- `PreToolUse / TeamDelete` → teamdelete-gate (blocks if members not gracefully shut down)
- `PostToolUse / TeamDelete` → teamdelete-cleanup
- `SubagentStart / simple-developer|developer` → setup-worktree
- `SubagentStop / merger` → cleanup-worktree
- `SubagentStop / simple-developer` → typecheck, prettier, unit-app, unit-functions, e2e

### Worktree scope (critical)

Every ticket agent works in `/app/worktrees/<SESSION_SHORT_ID>/TASK-XXX/`. Never read/edit `/app/src/` when you have a worktree — that's the base branch. Every Bash call must `cd /app/worktrees/<SESSION_SHORT_ID>/TASK-XXX && …` (shell state is stateless between calls).

Each session works on `session/<SESSION_SHORT_ID>` (forked from main at session start, with a fixed anchor ref `session-base/<SESSION_SHORT_ID>`). Task branches fork from and merge into `session/<id>` inside a dedicated `_session` worktree; the session branch is promoted to main once per request under `/app/.promote.lock`.

Branch naming: `<SESSION_SHORT_ID>/TASK-XXX` (COMPLEX), `<SESSION_SHORT_ID>/simple` (SIMPLE). All work branches use the session ID as prefix. Merge path: `<ID>/TASK-XXX` or `<ID>/simple` → `session/<ID>` (Stage A, in `_session` worktree) → `main` (Stage B, under `flock`). `session-base/<ID>` never moves — used to compute the migration diff at deploy time.

## Development

```bash
docker compose --profile demo up   # fast, FakeRest
docker compose --profile full up   # real Supabase
```

Hot-reload bind-mounts (dev only, remove before release): `claudeConfig/.claude`, `entrypoint.sh`, `chat-service/{server.js,public,lib}`, `sessions/`.

## Conventions

- **Language**: code, prompts, commits → English. Conversation with maintainer → French.
- **Ports hardcoded**: 5173 / 8080 / 54321 / 54323. Don't parametrise.
- **No secrets in git**. `ANTHROPIC_API_KEY` in `.env` (gitignored).
- **Chat-service imports**: `node:` prefix for `lib/*.js`; bare in `server.js` — don't harmonise.
- **Opus only for developer**. Everything else sonnet or haiku.
- **Debug UI**: `JSON.stringify(event, null, 2)` in a `<details>`, not fancy parsers.

## Gotchas

- `git reset --hard HEAD` on `/app` silently reverts App.tsx — merger re-applies variant via `/entrypoint-helpers/apply-app-variant.sh`.
- Cold cache is expensive (~$0.17 for a "Hi!") — keep `enabledPlugins` minimal in `settings.json`.
- Migrations are generated at deploy time from `git diff session-base/<SESSION_SHORT_ID>..session/<SESSION_SHORT_ID>`; the developer never writes them. Diffing against main would pull in other sessions' schema work — always diff against `session-base/<id>`.
