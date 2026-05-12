# Atomic-CRM Builder

Dockerised sandbox: non-technical users describe CRM changes in chat → agent team ships them in git worktrees.

## Runtime

```
supervisord (pid 1)
  ├─ crm-frontend   :5173  (Vite, /app/src)
  ├─ ttyd           :7681  (web terminal → claude CLI)
  └─ chat-service   :8080  (WebSocket + spawn claude -p)
```

Two compose profiles: `demo` (FakeRest) and `full` (Supabase, needs Docker socket).

`entrypoint.sh`: syncs `claudeConfig/.claude/` → `/home/developer/.claude`, applies App.tsx variant, overwrites `/app/.claude/settings.json` with `{"hooks":{}}` (prevents upstream format-file.sh fight with our hooks).

Single `crm-app` volume for `/app` — keeps `node_modules` and `worktrees/` on the same device so `cp -al` hard-links node_modules into each worktree (zero disk cost).

## Chat-service (`chat-service/`)

Split: `lib/server/` (spawn, routes, runtime, sessions, turns, ws) + `lib/stats/` (phases, hooks, subagents, io…). Entry: `server.js`.

Key invariants:
- One runtime per session; all connected WS clients get broadcast.
- Session log: append-only `log.jsonl` (source of truth) + `meta.json` (cache).
- Spawn: `claude --output-format stream-json --verbose --dangerously-skip-permissions --model <model> [--resume <id>] -p <prompt>`. Model + system prompt parsed from `chat-orchestrator.md` frontmatter at boot.
- `tokensUsed` = input + cache_creation + output (cache-read excluded — cheap rehydration).
- `total_cost_usd` is cumulative within a spawn: buffer in `costUsdCurrentSpawn`, commit to `costUsd` on turn end only.
- `activeAgents` counts only `task_type === 'local_agent'` via `Set<task_id>`.

Tests: `cd chat-service && npm test` — uses glob `'test/**/*.test.js'` (directory form broken on Node 25).

## Agent team (`claudeConfig/.claude/agents/`)

| Agent | Model | Role |
|---|---|---|
| chat-orchestrator | sonnet | User-facing, routes, narrates. SIMPLE flow dispatches simple-developer + merger directly (no team). |
| planner | sonnet | Decomposes → tickets JSON with waves + file hints. |
| architect | opus | Spec gatekeeper + plan approver. |
| developer | opus | Implements + commits in worktree. |
| simple-developer | sonnet | 1-file cosmetic changes only. No team, no review — SubagentStop hooks validate. |
| quality-reviewer | sonnet | Semantic code + security review only. Never re-runs validation. |
| test-validator | haiku | Integration wiring + e2e presence. |
| merger | haiku | `git merge --no-ff` only. **Never `git add`/`git commit`**. |
| documentator | sonnet | Writes rules/skills to `~/.claude/local/` on explicit user request only. |
| devops | sonnet | One-time bootstrap (fork, Supabase, env, deploy). |

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

Every ticket agent works in `/app/worktrees/TASK-XXX/`. Never read/edit `/app/src/` when you have a worktree — that's the base branch. Every Bash call must `cd /app/worktrees/TASK-XXX && …` (shell state is stateless between calls).

## Development

```bash
docker compose --profile demo up   # fast, FakeRest
docker compose --profile full up   # real Supabase
```

Hot-reload bind-mounts (dev only, remove before release): `claudeConfig/.claude`, `entrypoint.sh`, `chat-service/{server.js,public,lib}`, `sessions/`.

## Conventions

- **Language**: code, prompts, commits → English. Conversation with maintainer → French.
- **Ports hardcoded**: 5173 / 7681 / 8080 / 54321 / 54323. Don't parametrise.
- **No secrets in git**. `ANTHROPIC_API_KEY` in `.env` (gitignored).
- **Chat-service imports**: `node:` prefix for `lib/*.js`; bare in `server.js` — don't harmonise.
- **Opus only for architect + developer**. Everything else sonnet or haiku.
- **Debug UI**: `JSON.stringify(event, null, 2)` in a `<details>`, not fancy parsers.

## Gotchas

- `total_cost_usd` is cumulative within a spawn — never sum it event-by-event (massive inflation).
- `git reset --hard HEAD` on `/app` silently reverts App.tsx — merger re-applies variant via `/entrypoint-helpers/apply-app-variant.sh`.
- Cold cache is expensive (~$0.17 for a "Hi!") — keep `enabledPlugins` minimal in `settings.json`.
