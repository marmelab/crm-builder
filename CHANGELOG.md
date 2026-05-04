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

## Phase 14 — Test 4 forensic audit (2026-04-21)

After the medium-new-field baseline (35 min / $11.22), a forensic analysis of the session log exposed several systemic inefficiencies. Full chronology saved to [docs/test4-chronology.md](docs/test4-chronology.md).

Key findings:
- **Sequential despite TeamCreate** — orchestrator announces parallelism but dispatches serially (14 Agent calls instead of ≤7).
- **Skills `frontend-dev`/`backend-dev` never invoked** (0/7 developers) despite being announced in the system prompt. Root cause: `developer.md` prompt is too soft, nothing forces the invocation.
- **6 `stop-hook-error` notifications** per run — hooks cassés à chaque frontière d'agent.
- **Over-granular tickets** (5 tickets for one "add a field" feature).
- **Edit→prettier loop** cost 4+ min twice — atomic-crm's PostToolUse format hook reformats after every Edit, developer re-reads different bytes, confusion.
- **qrev + tval re-run typecheck/make test** that hooks should already catch.

---

## Phase 15 — Hook debugging & rewake fix (2026-04-21)

Deep debug of the 6 `stop-hook-error` notifications. Five root causes, fixed in order:

1. **`asyncRewake: true` + `rewakeMessage` were misused.** Per official docs (https://code.claude.com/docs/fr/hooks), `asyncRewake` is for **long-running background hooks** that only notify the parent orchestrator after the fact — it does NOT block a finished sub-agent. `rewakeMessage` is not even a documented field. The user intent ("developer reste vivant et corrige") requires a **synchronous** SubagentStop hook with exit 2 + stderr. Removed both fields from all 4 SubagentStop hook entries.
2. **`typecheck-on-commit.sh` had no `cd "$CLAUDE_PROJECT_DIR"`** (the 3 others did). Added.
3. **Hook paths resolved to nowhere.** Settings pointed to `"$CLAUDE_PROJECT_DIR"/.claude/hooks/typecheck-on-commit.sh` = `/app/.claude/hooks/...` — but our hooks live in `/home/developer/.claude/hooks/` (user scope, not project scope). `/app/.claude/hooks/` only contains atomic-crm's own `format-file.sh`. Replaced with absolute `/home/developer/.claude/hooks/...`.
4. **`CLAUDE_PROJECT_DIR` and `MODE` were not in chat-service's env.** Supervisor passed only `HOME` + `ANTHROPIC_API_KEY`. Added explicit env vars in both `supervisord.{demo,full}.conf` and `server.js` spawn (belt + suspenders).
5. **Plugin `hookify` (not in `enabledPlugins`) crashed its Stop hook** with `ImportError: No module named 'core'` — its hook fires regardless of enablement. Explicitly disabled `hookify` and `ralph-loop` by setting `false` in `enabledPlugins`.

Result: test 1 (simple-hide) reruns with **0 `stop-hook-error`**, all 4 SubagentStop hooks fire in parallel and log to `chat-logs/hooks.log`:
```
e2e       EXIT=0 skipped_demo
unit-fn   EXIT=0 OK (2s)
typecheck EXIT=0 OK (32s)
unit-app  EXIT=0 OK (39s)
```

Added **tracing to all 4 hooks**: every invocation logs start/end/exit + env to `/chat-service/logs/hooks.log` (bind-mounted to host).

**Why**: the SubagentStop hooks are the backbone of the quality loop — if they fail silently, typecheck errors and test regressions slip past into quality-reviewer unchallenged (cf. TASK-003 in test 4 which required a separate dev-TASK-003fix dispatch to patch `ConfigurationContextValue`).

---

## Phase 16 — Reviewer consolidation round 2 (2026-04-21)

Now that hooks reliably run typecheck + tests, the duplicated work in reviewers can go.

- **`quality-reviewer.md`** — added note explicitly forbidding re-run of typecheck / unit tests (the hooks already did). Narrowed `npm audit` to "only when `package.json` / `package-lock.json` changed". Updated B.7 Dependencies accordingly.
- **`test-validator.md`** — reinforced the existing "don't re-run" note to cover typecheck + unit tests + e2e + vite build. Removed Step 2 (Vite smoke test — was spending 40 s / ticket for zero new signal). Renumbered steps: 1 = integration check, 2 = screenshots, 3 = e2e spec sanity (no execution). Updated verdict matrix to drop typecheck from RED criteria (hooks handle that upstream).

**Why**: in test 4, `tval-TASK-002-003` spent 5m17s re-running `make test` + `npx vite build` + `tsc --noEmit` + 5× `git diff` — all redundant with the hook layer. Removing those saves ~3 min per cycle × N tickets.

---

## Phase 17 — Rewake mechanism validated (2026-04-21)

Synthetic test: introduced a deliberate TypeScript error in `/app/src/_rewake_test.ts` (`export const _rewake_broken: number = 'this is a string'`) before dispatching developer on a simple UI task.

Observed behavior in `chat-logs/hooks.log`:
1. Developer completes its task normally → SubagentStop fires the 4 hooks in parallel
2. `typecheck-on-commit.sh` finds the pre-existing error → **exit 2 with stderr**
3. Developer does NOT die — its session receives the stderr as a system reminder
4. Developer investigates: `Read /app/src/_rewake_test.ts` → `Edit` to fix the type → `Bash npx tsc --noEmit` to verify → resumes its original task
5. Developer re-stops → hooks fire again → typecheck passes → clean exit

Hook log pattern (expected rewake signature):
```
11:34:50  typecheck EXIT=2 npm_exit=2   ← rewake triggered
11:35:35  hooks batch 2 START           ← developer re-stops after fix
11:36:08  typecheck EXIT=0 OK           ← clean
```

The single `stop-hook-error` notification still emitted at the rewake moment is benign — it is Claude Code's way of signalling "a Stop hook injected stderr" and is unrelated to the broken plugin errors of Phase 15.

**Why**: confirms the core quality-loop contract end-to-end. Typecheck / unit test regressions caught by hooks will now be auto-corrected by the developer without involving quality-reviewer — no more TASK-003 → TASK-003fix split-dispatch waste.

---

## Phase 18 — Planner file paths + developer skill enforcement (2026-04-21)

Two systemic fixes following test 4's forensic audit (Phase 14).

### Planner now emits `files_to_modify` in each ticket
- **Tools**: added `Read`, `Grep`, `Glob` to `planner.md` frontmatter (was `Write` only). Planner now does a light file-discovery pass — no reading, just path identification via 1-3 greps/globs per probable area.
- **Ticket JSON schema**: new `files_to_modify` field, array of 2-6 best-guess paths per ticket.
- **Coarse-over-fine rule**: added "prefer ≤ 3 tickets per user-visible feature. Merge data-layer tickets (type + seed + config) into one unless any exceeds ~150 LOC / 5 files." — directly addresses test 4's 5-ticket-for-1-feature over-granularity.
- **Renumbered steps** (now 5 instead of 4, file discovery inserted as Step 2).

### Developer MUST invoke a skill as first action
- Moved Skill invocation from soft mid-document prose to a **MANDATORY FIRST ACTION** block right after the role description — first thing the reader (and the model) sees.
- Explicit contract: "Before any Read / Grep / Glob / Edit / Bash call, your very first tool_use MUST be a `Skill` invocation." Reviewer rejects with "skill not loaded" if absent.
- **`files_to_modify` usage wired into the workflow**: pre-plan checklist now says "Start from `files_to_modify` — read each one BEFORE exploring further". Saves the ~60-90s search phase that plagued every dev dispatch in test 4.
- Removed the duplicated soft "Load the relevant CRM conventions" section from the middle of the document.

**Why**: in test 4, 0/7 developers invoked `frontend-dev` or `backend-dev` even though both skills are declared in the frontmatter and announced in the system prompt. Evidence: dev-T004 did 7 Greps hunting for form/select conventions, dev-e2e-fix did 24 Reads exploring playwright setup — both would have been substantially reduced with a skill pre-load. Tests will tell whether the stronger wording + `files_to_modify` hint actually changes behavior.

---

## Phase 19 — Prettier on Stop + remaining skill enforcement (2026-04-21)

### Replace atomic-crm's PostToolUse prettier with a Stop hook
Atomic-crm's project-level `.claude/settings.json` had a `PostToolUse(Edit|Write|NotebookEdit)` hook running `format-file.sh` → `npx prettier --write "$file_path"` on every edit. Root cause of the edit/prettier loop observed in test 4 (dev-TASK-003 = 4m03s, dev-TASK-005 = 4m14s burning on this exact pattern): developer edits → hook silently reformats the file → developer re-reads different bytes than it wrote → doubts itself → re-edits → hook reformats → repeat.

Changes:
- **Disabled** atomic-crm's PostToolUse prettier hook. `entrypoint.sh` now writes `/app/.claude/settings.json` to `{"hooks": {}}` at every boot (the project-level file comes from the image; overwriting it is the simplest way without asking the user to patch the atomic-crm repo).
- **New SubagentStop hook** `prettier-on-stop.sh`: runs `npm run prettier` (check mode, not write) after DEVELOPER stops. Exit 2 + stderr ("Prettier check failed — run 'npm run prettier:apply' to fix formatting:") if not clean. Developer rewakes, runs prettier:apply, retries Stop.
- **Fixed `app-variants/App.fakerest.tsx`** which had 2 prettier violations (long import line + multi-line JSX) — this was the source of the `[warn] src/App.tsx` noise that confused developer in test 4's dev-T003 and dev-T005 (they thought they had caused the warning and wasted time chasing it).

Post-fix `npm run prettier` output: **All matched files use Prettier code style!**

### Complete skill-invocation coverage
Phase 18 made `frontend-dev` / `backend-dev` mandatory as a FIRST ACTION. But 3 other skills in the developer frontmatter were still never invoked in test 4 (reflection-writing 0/2, e2e-conventions 0/1, playwright-testing 0/1). Same root cause: developer.md prose didn't say "invoke the Skill", only "read existing reflections" / "write an e2e spec".

Changes in `developer.md`:
- **Mode 2 (Reflection)** — step 1 is now explicitly "Invoke `Skill({ skill: "reflection-writing" })` as your first tool call in Mode 2". Reading existing reflections and writing the file follow.
- **e2e test rule** — when writing an e2e spec, developer must first invoke both `Skill({ skill: "e2e-conventions" })` and `Skill({ skill: "playwright-testing" })`. Stated inline in the Implementation Rules section, not in a side paragraph.

**Why**: test 4 showed all skills declared in frontmatter were effectively unused (0 calls across 7 developer dispatches for the first two, 0/2 and 0/1 for the others). Content quality was adequate because the developer.md prompt itself carries enough structural hints, but that's duplication — the skills exist precisely to centralize those hints. Forcing invocation aligns with the Phase 18 pattern and removes the duplication.

---

## Phase 20a — Persist tickets and reflections (2026-04-21)

Discovered that `/app/docs/` (where planner writes tickets and developer writes reflections) **was not mounted** — files lived in the container's overlay filesystem and vanished at every `docker compose down` (no `-v` needed). This silently made the Phase 18 directive "read `docs/reflections/` files from the same domain — mandatory" a no-op, because the directory was always empty on a fresh container.

Fix: added `./crm-docs:/app/docs` bind mount to both `demo` and `full` profiles in `docker-compose.yml`. Salvaged the 5 tickets + 2 reflections from test 4 into `./crm-docs/` before the mount took effect (they would have been lost otherwise). Added `crm-docs/` to `.gitignore` (runtime-generated, not source).

The mount only becomes active after the next `docker compose down && up`. Existing container still uses the overlay filesystem for the current session.

**Why**: the reflection accumulation loop (developer reads prior reflections in the same domain to build on them) only pays off if the reflections survive between runs. Phase 18 alone wasn't sufficient — it needed this persistence.

---

## Phase 20 — Model routing per complexity (2026-04-21)

Per Claude Code docs, the `Agent` tool accepts a per-invocation `model` override that takes precedence over the sub-agent's frontmatter default. Resolution order: env var `CLAUDE_CODE_SUBAGENT_MODEL` > invocation `model` > frontmatter `model` > parent session model.

Reused the existing Simple / Complex classification already in `chat-orchestrator.md` (lines 58-89) — no new heuristic, just switched the dispatched model:
- **Simple change** (label swap, hide/show element, color tweak, config boolean) → `model: "sonnet"` (previously opus)
- **Complex change** (schema, new feature, multi-file, business logic) → `model: "opus"` (unchanged, still the default)

Safety net: if sonnet produces code that doesn't typecheck or violates prettier, the SubagentStop hooks catch it (Phase 15+19) and the rewake mechanism (Phase 17) lets sonnet self-correct in-context — same loop that opus benefits from.

Expected impact on Simple cases like test 1 (hide Refresh button): **~5× cost reduction** ($0.35 → $0.07), **~2× faster** (1m30 → 45s). Complex cases like test 4 stay on opus → no change.

---

## Phase 21 — Stats counter fix + user message hygiene (2026-04-21)

### Test 4 round 2 validated all prior phases
Re-ran `medium-new-field` after phases 15-20. Detailed chronology saved to [docs/test4-round2-chronology.md](docs/test4-round2-chronology.md). Headline: **31 min / $8.05 / 3 tickets / 10 dispatches / 4 skill invocations / 0 stop-hook-error** vs baseline (before 15-20) of 35 min / $11.22 / 5 tickets / 14 dispatches / 0 skills / 6 stop-hook-errors.

### Stats counter bug (cost inflated 13× vs reality)
Observed while analyzing round 2: UI showed `$103` at end of run, but the real cumulative cost from Claude CLI was `$8.05`. Root cause: `total_cost_usd` in each `result` event is **cumulative-within-spawn**, not per-event. Our accumulator did `costUsd += event.total_cost_usd`, effectively summing cumulative snapshots repeatedly → inflation proportional to the number of result events (~13 in this run).

Also redefined "tokens used" per user intent: the meaningful number is what counts against the user's budget, not the raw sum including cache_read. Cache_read tokens are re-hydrated from the prompt cache and billed 10× less; including them made the UI show 2.2M tokens for a run that really used ~40k of "fresh" tokens.

Fixes in `chat-service/server.js`:
- Replaced `tokensIn` / `tokensOut` with a single `tokensUsed = input + cache_creation + output` (cache_read excluded).
- Split `costUsd` into `costUsd` (committed from past spawns) + `costUsdCurrentSpawn` (live from current spawn, replaced on each result event). UI receives `costUsd + costUsdCurrentSpawn` as the displayable total.
- On `processMessage` close, commit `costUsdCurrentSpawn → costUsd` so multi-turn sessions accumulate correctly.
- Refactored stats broadcast via `sendStats(ws)` helper to compute the displayable fields in one place.

Fix in `chat-service/public/chat.js`:
- UI line changed from `"N in · M out · $X.XXX"` to `"Y tokens · $X.XXX"` (single token count, no in/out split — the user doesn't care).

### User-facing message leaks
Chronology analysis caught the orchestrator emitting `"TASK-006 approuvé"`, `"TASK-007 approuvé"`, `"couche données"`, `"Les avertissements LinkedIn..."` in user-facing messages. These are all technical identifiers forbidden per `chat-orchestrator.md`'s own "Forbidden words" section — the rule was being skipped.

Strengthened the rule in `chat-orchestrator.md`:
- Explicitly added `ticket IDs (TASK-006, ...)`, `internal layer names ("couche données")`, `library names from the codebase (LinkedIn, fakerest, Supabase)` to the forbidden list.
- Added 4 concrete ❌/✅ examples taken directly from round 2's leaks.
- Instructed to refer to tickets / steps as "étape 1", "première étape", "étape finale" — never by ID.

**Why**: the chat-orchestrator had a rule but it was vague ("code concepts, error messages, agent names"). Seeing the violations in a real run and adding them to the example block with explicit counter-examples is the simplest reinforcement.

---

## Phase 22 — Worktree isolation + mandatory merger + per-subagent circuit breaker (2026-04-22)

### Worktree per ticket (end of the "everyone edits /app directly" era)
Prior sessions had developers editing `/app/src` directly and the merger was defined but never dispatched. This caused several regressions including 20+ unrelated files reformatted on `master` when a developer ran `npm run prettier:apply` without `cd` prefix.

New flow (enforced via `.claude/rules/worktree-scope.md` + hook):
- Each ticket gets `/worktrees/TASK-XXX/` with `node_modules` symlinked to `/app/node_modules`
- Developer first Bash is worktree setup: `git worktree add + ln -s + cd`
- Every subsequent Bash MUST start with `cd /worktrees/TASK-XXX && ...` (Bash shells are stateless — `cd` doesn't persist between tool calls)
- Developer's file edits all go to `/worktrees/TASK-XXX/src/...`, not `/app/src/...`
- After reviewers APPROVED, merger merges feature branch → base branch locally (no GitHub PR), removes worktree + branch
- `TeamCreate` per ticket, `TeamDelete` after merger success

Scope allowed for agents working on a ticket:
| Path | Read | Write | Bash cwd |
|---|---|---|---|
| `/worktrees/TASK-XXX/**` | ✅ | ✅ | ✅ |
| `/app/docs/tickets/TASK-XXX.json` | ✅ | ❌ | — |
| `/app/docs/reflections/**` | ✅ | ⚠️ only Mode 2 reflection | — |
| Everything else under `/app/` | ❌ | ❌ | ❌ |

### Unified simple + complex path
Previously, simple changes bypassed worktree/merger (direct dev on `/app`). Now both paths use TeamCreate + worktree + merger. Simple path just skips planner and reviewers — developer runs on sonnet (cheaper), merger on haiku. Same isolation as complex. Branch naming for simple uses a slugified request, e.g. user says *"remplace Dashboard par Accueil"* → branch `quick/rename-dashboard-to-accueil`.

### Merger rewritten for local merge
Dropped `gh pr create / gh pr merge` workflow from the old `merger.md`. New responsibilities:
1. `git merge <branch> --no-ff -m "feat(TASK-XXX): <title>"`
2. `git worktree remove` + `git branch -d`
3. Update ticket JSON status to `"merged"`
4. On conflict: `git merge --abort` + report BLOCKED (developer re-fix, not auto-resolve)

Mandatory check before `TeamDelete`: merger success confirmed. No "session limit" or "I'll let the user do it" — the merger is fast (< 30s on haiku).

### Hooks became worktree-aware
All 4 SubagentStop hooks (typecheck, prettier, unit-app, unit-fn) now iterate on `/worktrees/*` only (not `/app`). Earlier version ran in `/app` too — which was broken because `/app` had orphan untracked files from prior sessions that made typecheck fail, causing the developer to "fix" unrelated issues in its worktree.

### `agent_id`-keyed circuit breaker (per-subagent)
Old circuit breaker keyed on `session_id` (shared across orchestrator + subagents) — a single chat session had a total budget of 30 Bash for everyone combined. Empirically inadequate: a single dev alone can do 15-25 legit Bash.

Discovered via hook debug logging that the hook input JSON contains `agent_id` (present only in subagent contexts). New counter keyed on `sub-<agent_id>` for subagents, `orch-<session_id>` for the orchestrator. Each subagent gets its own 30-Bash budget. Verified: 3 parallel general-purpose subagents each have their own counter starting at 1.

### `crm-docs` chown at boot (entrypoint)
Fixed `EACCES: permission denied` when planner tries to write `/app/docs/tickets/TASK-XXX.json`. The dir is bind-mounted (`./crm-docs:/app/docs`) and owned by the host creator UID, not developer's UID. Entrypoint now:
```bash
mkdir -p /app/docs/tickets /app/docs/reflections
chown -R developer:developer /app/docs
chown -R developer:developer /worktrees
```
Idempotent: handles clean install (empty dir root-owned) and existing installs with wrong ownership.

Also bind-mounted `entrypoint.sh`, `chat-service/server.js`, `chat-service/public` for dev iteration without image rebuild. Clearly marked `DEV ONLY — RETIRER avant release production`.

### `crm-docs` switched from bind mount to named volume
Previously `./crm-docs:/app/docs` on host — accumulated tickets/reflections across `docker compose down -v` (bind mounts aren't affected by `-v`). Confusing for testing because prior tickets polluted new runs.

Now `crm-docs:/app/docs` as a named volume. Normal `down` preserves (reflections accumulate as a knowledge base), `down -v` wipes (fresh test). Matches user mental model.

### TodoWrite + test chronologies saved
All major test runs now get a forensic markdown analysis:
- [test-2026-04-22-regression-analysis.md](docs/test-2026-04-22-regression-analysis.md) — couleur+tiktok regression (43 min, $6.52, 0 merged)
- [test-2026-04-22-complex-priority-analysis.md](docs/test-2026-04-22-complex-priority-analysis.md) — priority baseline (22 min, $3.90, 2/2 merged)
- [test-2026-04-23-parallel-tickets-analysis.md](docs/test-2026-04-23-parallel-tickets-analysis.md) — badge new + note count (hung, killed)

---

## Phase 23 — Orchestrator refactor + Mode 2 reflection + bash-write block (2026-04-23)

### chat-orchestrator.md ↔ agent-team SKILL.md split
Both files previously described the full Phase 2 workflow with dispatch templates — two sources of truth for the same content. Refactored:
- **chat-orchestrator.md** (251 → 182 lines): UX contract only. Language, forbidden words, classification simple/complex, simple flow inline, a "Progress updates" table with templates of user-facing messages per phase (and the anti-pattern warning *"if you just said 'en parallèle', don't say 'je commence par la première' next"*), error handling. For complex: delegates to skill.
- **agent-team/SKILL.md** (180 → 235 lines): all workflow details. Phase 0/1/2 steps, batching rule with ✅/❌ examples, every dispatch template (developer ticket, fix, Mode 2 reflection, reviewers, merger, TeamDelete), ticket format, model routing, global rules. Loaded only when complex change.

Source of truth for each concern now lives in exactly one file. Orchestrator loads the skill on complex and follows it.

### Mode 2 reflection step (NOT optional before merger)
The old agent-team skill said *"after APPROVED, developer writes docs/reflections/TASK-XXX-reflection.md, then merger"* — but in practice the orchestrator skipped straight to merger. Two consecutive runs had zero reflections written.

Fix: explicit step 8 in complex flow in `chat-orchestrator.md` and agent-team skill dispatch template: *"After all reviews APPROVED, dispatch developer in Mode 2 (reflection) BEFORE merger."* Reflection runs on sonnet (prose, not heavy reasoning), writes `/app/docs/reflections/TASK-XXX-reflection.md`, commits in the worktree, and the merger picks it up.

### `block-bash-file-write` hook
Past run (complex priority 2026-04-22) had a developer execute `cat > /tmp/task-002-update.json << 'EOF'` — left a 0-byte orphan file. The [developer.md](claudeConfig/.claude/agents/developer.md) HARD RULE forbids this but wasn't enforced.

New PreToolUse hook [`block-bash-file-write.sh`](claudeConfig/.claude/hooks/block-bash-file-write.sh): blocks patterns `> file`, `>> file`, `sed -i`, `awk -i inplace`, `tee file`, `node -e '... writeFileSync'`. Allow list: `/dev/null`, `/chat-service/logs/`. Exit 2 with explicit reason "use Edit/Write tool instead. See developer.md HARD RULE".

### Parallel dispatch batching rule made explicit
Previous rule in chat-orchestrator.md said "emit in same assistant turn" — sonnet emitted in 4 separate messages anyway. Reformulated with concrete example of **4 `tool_use` blocks in ONE assistant response** + the **Forbidden pattern** showing the serialized version + a **rule of thumb**: *"if your next user message starts with 'je lance la première étape', you're about to serialize a parallel wave — change to 'je lance les étapes' and emit all dispatches in this response"*.

Empirically: sonnet still emits in separate messages (3-4s gap between dispatches), but the parallelism DOES happen at the process level — Agent dispatch returns "Spawned successfully" in ~1s and the subagent runs in background. The cost of the cosmetic gap is ~10s per test, minor.

---

## Phase 24 — Parallel test analysis + hook-owned validation (2026-04-23)

### 4-ticket parallel test revealed 3 new bugs
Ran [test-2026-04-23-parallel-tickets-analysis.md](docs/test-2026-04-23-parallel-tickets-analysis.md) with prompt *"badge new + compteur notes"* — 2 tickets, no dependencies, both `parallel_safe: true`. Expected: 2 worktrees, 2 devs in parallel, 2 merges. Actual: hung after 40 min, killed manually, 0 tickets merged.

Debug identified 3 bugs:
1. **Circuit breaker at 30 Bash garrotted devs doing legitimate work** — each dev used 33 Bash (explore 11-14× + typecheck 3-6× + vitest 4-6× + prettier 2× + git 3× + worktree 1× + misc). The "legitimate" part was actually ~10 — the 20-25 wasted Bash were the dev redundantly running hook-owned commands.
2. **`activeAgents` counter drift in chat-service**: UI showed "11 agents active" when the reality was 1-3. Server.js counted every `task_started` event (including each Bash tool call = task_started). Fixed to filter only `task_type === "local_agent"` and match completion via `task_id`.
3. **Vitest hang in worktrees**: `npx vitest --run` in a worktree hangs forever without `process.env.CI`. Reason: `vitest.config.ts` uses `@vitest/browser-playwright` with chromium, and without `CI=true` it tries to launch a headed browser in a display-less container. Fixed upstream in atomic-crm (`headless: true` default) — pulled in this phase's image rebuild.

### Hook-owned validation commands forbidden in dev
The real cause of the Bash budget blow-up: developer was running `make typecheck`, `npm run test:unit:app`, `npm run prettier` **even though the SubagentStop hooks already do that automatically**. The hooks run these after dev finishes and inject stderr back into the dev's context if they fail. Dev should trust the hook output, not re-run.

New [`block-bash-validation.sh`](claudeConfig/.claude/hooks/block-bash-validation.sh) PreToolUse hook blocks:
- typecheck: `make typecheck`, `npm run typecheck`, `npx tsc`, `tsc --noEmit`
- prettier: `npm run prettier[:apply]`, `npx prettier`, `make prettier`
- unit tests: `npm run test[:unit:*]`, `npm test`, `npx vitest`, `make test(-unit)*`
- e2e: `npx playwright test`, `make test-e2e*`
- lint: `make lint`, `npm run lint`

**Agent-type filtering in the hook** (not in settings.json — PreToolUse `matcher` only supports tool name per the docs): hook only fires for agents where the rule applies (`developer`, `quality-reviewer`, `test-validator`). Orchestrator, planner, merger, project-manager, architect are unaffected.

Developer.md updated with a new "Validation commands — DO NOT RUN THEM" section listing what NOT to do, the vitest hang explanation, and the "what to do instead" (trust the hooks, report DONE after your code commits).

### Circuit breaker reverted to 30
After block-bash-validation enforces the "no hook-owned commands" rule, dev's real Bash budget becomes ~15-20 per ticket (worktree setup + git ops + fix retries). 30 is comfortable and still catches infinite loops (which hit 100+). Reverted from 60 → 30 with updated rationale comment.

### Docker image rebuild (2026-04-23)
Pulled latest atomic-crm (includes `headless: true` in vitest.config.ts — makes vitest safe even without `CI=true`). Rebuilt `atomic-crm-dev:latest` image with `docker compose build --no-cache` — plain `docker compose build` kept the cached `RUN wget ... atomic-crm-main.zip` layer so the upstream fix wasn't pulled. Adding a cache-busting ARG (date or git SHA) to the Dockerfile before the wget would make this more reliable, but not needed for this iteration.

---

## Open items / known limits

## Phase 25 — Merger hardened against stale `/app` working tree (2026-04-23)

### What the second parallel test revealed
Re-ran the "badge new + compteur notes" parallel test after Phase 24's fixes. End-to-end success in 31 minutes: 2 devs in parallel (1s gap), 4 reviewers in parallel (3s), 2 Mode 2 reflections in parallel (2s), 2 mergers in parallel (1s). `block-bash-validation` blocked one dev attempt at `npm run typecheck` (hook did its job). Circuit breaker max hit was 22 — never tripped 30. Vitest never hung.

**But:** one commit polluted master between the two ticket merges — `92cbdcf` *"feat: add deal priority field and badge on Kanban cards"*. This commit brought back the priority feature from the **previous** test session + regressed `.claude/settings.json` (`hooks: {}`) and `src/App.tsx` (older version).

### Root cause: merger fabricating commits from stale working-tree state
`/app/src/` is a Docker named volume (`crm-source`) that survives `docker compose build` and container restart. The previous priority test had left uncommitted modifications to tracked files in `/app/src/` that weren't cleaned up before the second test. When merger TASK-004 ran:

```
09:55:17  cd /app && git status && git stash list            # saw stale files
09:55:21  git diff DealCard.tsx types.ts                     # two files happened to overlap with ticket
09:55:29  git add DealCard.tsx DealInputs.tsx deals.ts \     # staged ALL modified files including App.tsx + .claude/settings.json
          types.ts App.tsx .claude/settings.json && \
          git commit -m "feat: add deal priority field..."    # message auto-generated from file contents
```

The merger read the overlap as "TASK-004-related modifications the dev forgot to stage" and committed them on `master`. Then the `git merge feature/deal-note-counter-TASK-004` conflicted against its own pollution, requiring a retry merger that took 10 minutes of rebase conflict resolution.

### Fix: merger never fabricates commits
[`claudeConfig/.claude/agents/merger.md`](claudeConfig/.claude/agents/merger.md) updated:

- **New Step 2a (MANDATORY)**: `cd /app && git reset --hard HEAD` before every merge — discards stale tracked-file modifications idempotently. Does NOT run `git clean -fd` (would wipe `docs/tickets/` used by concurrent tickets in the same wave).
- **Explicitly forbidden** commands in Step 2a and Constraints: `git add`, `git commit`, `git stash`, `git clean -fd`, `git checkout -- <file>`. Merger's only writes on `/app` are `git merge --no-ff` (self-generated commit) and `git reset --hard HEAD` (debris cleanup).
- **Past incident note** embedded in the prompt so future mergers understand the reasoning when tempted by dirty-tree recovery paths.

### Master cleanup (manual one-time)
Rewound `master` to `44e6118` (post-TASK-003 merge) and re-merged TASK-004's original commits (`08b4808` + `3b06dbc`) via `--no-ff` → new merge commit `8893521`. Result: clean linear-plus-merges history, no priority pollution:

```
8893521  feat(TASK-004): Show note counter on each deal Kanban card   ← clean merge
44e6118  feat(TASK-003): Show 'new' badge                              ← clean merge
9fac7e8  docs(TASK-003): reflection
8476d5a  docs(TASK-004): reflection
8beff9f  Initial commit
```

Also removed stale untracked files from `/app`: `src/App.supabase.tsx` (3 days old), `docs/project-context.json`, and merged ticket JSONs.

### Known merger minor bug (not fixed this phase)
TASK-003 and TASK-004 ticket JSONs ended the run with `status: "pending"` instead of `"merged"`. Merger's Step 5 (update ticket status) didn't apply. Not a blocker — will investigate if it happens again, might be a race with concurrent mergers reading/writing the same tickets dir.

---

## Phase 26 — Reviewer + merger + reflection-hook polish (2026-04-23)

Follow-ups from the [Phase 25 test analysis](docs/test-2026-04-23-parallel-v2-analysis.md) — three low-risk fixes targeting the P0 and P1 findings.

### P0 — Merger Step 5 ticket status update

Root cause of the "Known merger minor bug" from Phase 25: haiku merger used `cat docs/tickets/TASK-X.json | jq '.status = "merged"' > /tmp/... && mv ...`, which `block-bash-file-write` correctly blocked, but the merger silently moved on to Step 6 instead of retrying with the Edit tool.

Fix in [merger.md](claudeConfig/.claude/agents/merger.md):
- Added `Edit` to the merger's `tools:` frontmatter (was only `Bash` + `Read`).
- Rewrote Step 5 with an explicit Edit tool invocation example (haiku follows patterns literally; the previous *"use the Edit tool — never use sed or echo >"* was too abstract).
- Added verification step: `Read` the ticket after Edit to confirm `"status": "merged"`.
- Embedded the 2026-04-23 incident note so future mergers see why this matters.

### P1 — Reviewers ran validation commands (9 blocked in Phase 25 test)

`quality-reviewer` and `test-validator` each attempted `npx tsc`, `npm run typecheck`, `npx eslint`, `npm run lint:typescript` — all correctly blocked by `block-bash-validation.sh`, but they wasted ~8 tool calls and ~500 tokens of block-response output each run.

Fix: added full *"Validation commands — DO NOT RUN THEM"* sections (mirroring developer.md) to:
- [quality-reviewer.md](claudeConfig/.claude/agents/quality-reviewer.md) — forbidden list + "what to do instead" (semantic review only, use `Read`/`Grep` not `npx tsc`).
- [test-validator.md](claudeConfig/.claude/agents/test-validator.md) — same forbidden list + pointer to Steps 1/2/3 (integration wiring, screenshots, e2e spec presence — all read-only).

Both sections reference the observed past behaviour ("attempted 4+ validation commands that all got blocked") so the reviewer understands why the rule exists.

### P1 — Mode 2 reflection subagents triggered useless SubagentStop hooks

Reflection subagents are dispatched as `subagent_type: developer`, so the `"matcher": "developer"` in settings.json made all 4 SubagentStop hooks fire after each reflection — typecheck, unit-app, unit-fn, e2e. Since reflections only touch `docs/reflections/*.md`, these hooks wasted ~30s per reflection doing nothing.

Fix in the three expensive hooks ([typecheck-on-commit.sh](claudeConfig/.claude/hooks/typecheck-on-commit.sh), [run-unit-tests-app.sh](claudeConfig/.claude/hooks/run-unit-tests-app.sh), [run-unit-tests-functions.sh](claudeConfig/.claude/hooks/run-unit-tests-functions.sh)): new skip clause after the "no changes" early-exit:

```bash
DIFF_ALL=$( { git diff --name-only "$BASE..HEAD"; git status --porcelain | awk '{print $NF}'; } | sort -u | grep -v '^$' )
if [ -n "$DIFF_ALL" ] && [ -z "$(echo "$DIFF_ALL" | grep -v '^docs/reflections/')" ]; then
  echo "[...] typecheck SKIP wt=$WT (reflection-only)" >> "$LOG"
  continue
fi
```

Verified by shell simulation: pure reflection changes → SKIP; mixed changes → RUN. `prettier-on-stop.sh` intentionally kept unchanged — prettier formats markdown too, so reflection .md files still benefit.

E2e hook untouched — already `skipped_demo` in demo mode, and reflection in full mode is rare enough to not warrant the complication.

### Expected impact on next test run
- Merger Step 5 will correctly set `status: "merged"` on both ticket JSONs.
- Reviewers will skip validation attempts → ~15s + ~1k tokens saved per ticket.
- Reflection subagents will finish ~30s faster each, no hook noise.

---

## Phase 27 — Merger git reset was wiping App.tsx variant (2026-04-23)

### Bug surfaced by a quick-edit
After the Phase 25 fix, a quick-edit ("rename 'Hot Contacts' label to 'CHAUUUD'") ran its merger, which executed Step 2a's `git reset --hard HEAD` in `/app`. That reset silently reverted `/app/src/App.tsx` from the **FakeRest variant** (copied by `entrypoint.sh` at boot for `MODE=demo`) back to its **tracked upstream form** (just `<CRM />` with no data provider). The running vite dev server hot-reloaded and the demo UI broke — user reported *"je suis repassé en mode démo, pourquoi ?"* (actually it was IN demo mode but missing the FakeRest wiring).

Root cause: the entrypoint modifies a **tracked** file (`src/App.tsx`) during container startup. `git reset --hard HEAD` faithfully undoes that modification because, from git's perspective, it's just an uncommitted dirty state — identical to the pollution the Phase 25 fix was designed to clean up.

### Fix: extract the variant-copy into a shared helper, call it post-reset
New script [`/entrypoint-helpers/apply-app-variant.sh`](entrypoint.sh) (written by `entrypoint.sh` at boot, then re-callable):

```bash
#!/bin/bash
set -e
MODE="${MODE:-demo}"
if [ "$MODE" = "full" ]; then
  cp /app-variants/App.supabase.tsx /app/src/App.tsx
else
  cp /app-variants/App.fakerest.tsx /app/src/App.tsx
fi
```

- [`entrypoint.sh`](entrypoint.sh) — writes the helper to `/entrypoint-helpers/` at boot, then invokes it in place of the previous inline `cp` calls. Single source of truth.
- [`merger.md`](claudeConfig/.claude/agents/merger.md) Step 2a — the reset command is now `git reset --hard HEAD && /entrypoint-helpers/apply-app-variant.sh`, with an explanatory comment about why chaining the variant re-application is necessary. Added the App.tsx-wipe incident to the "Why this matters" block so the rationale is traceable.

### Manual recovery applied
Copied `/app-variants/App.fakerest.tsx → /app/src/App.tsx` live in the running container and installed the helper script at `/entrypoint-helpers/apply-app-variant.sh` without restarting, so the user doesn't need to reload the dev server. Next container restart will regenerate the helper via the updated entrypoint.

---

## Phase 28 — Multi-discussion persistence + stop/cancel (2026-04-23, branch `multi-sessions`)

Single chat connection → many persisted discussions. Prior to this phase, every WebSocket connection created a one-shot `session-<ISO-ts>.jsonl` log and no history was exposed to the user; refreshing the page or reopening the widget lost the conversation.

### Per-discussion on-disk layout
Log dir becomes `LOG_DIR/<uuid>/` with two files:
- `log.jsonl` — append-only stream of every WS event (in/out), unchanged format, single source of truth.
- `meta.json` — lightweight index: `{ id, title, state, createdAt, lastMessageAt, messageCount, userMessageCount, claudeSessionId, titleAutoGenerated?, titleLocked? }`. Keeps the listing page from having to parse every log.
Visible messages (user + assistant) are derived on-demand from `log.jsonl` via `messagesFromLog()`.

`LOG_DIR` is now overridable via `CHAT_LOG_DIR` env var (used by the new smoke test), `PORT` via `PORT` env var. Default `/chat-service/logs` preserved.

### HTTP API for discussion management
New endpoints on the existing HTTP server:
- `GET /api/discussions` — list (sorted by last activity desc, skips empty discussions).
- `GET /api/discussions/:id` — meta + full message history.
- `PATCH /api/discussions/:id` — rename (`{title}`) or change state (`{state: "en_cours"|"terminee"}`). Manual rename sets `titleLocked: true` so Haiku auto-retitle doesn't overwrite.

### WebSocket protocol additions
- Connection URL: `ws://…/?discussion=<uuid>` resumes an existing discussion; absent / invalid UUID creates a new one.
- New outbound `init` event sent once on connect: `{ discussionId, title, state, messages, isNew }` — replaces the unconditional welcome (choices only shown on `isNew`).
- New outbound `state` event when the discussion transitions `en_cours` ↔ `terminee` (claude running vs. idle, all queues drained).
- New outbound `title` event when Haiku regenerates the title.
- New inbound `{type: "stop"}` message to cancel (see below).
- Inbound `user_message` now accepts an optional `display` field (the user-facing label for choice buttons vs. the raw `content` sent to claude).

### Haiku-generated title after 2nd user turn
First auto-title is a crude 60-char slice of the first user message. Once `userMessageCount === 2`, a one-shot `claude --model claude-haiku-4-5 -p <prompt>` fires in the background with the first 6 exchanges and returns a 3-6 word title in the user's language. Guarded by `titleAutoGenerated` (fires once) and `titleLocked` (manual rename wins even if Haiku was already running). Failures are silent — title just stays as the first-message slice.

### Stop/cancel current turn
New red `⏹` button in the header, visible only while a turn is running. Client sends `{type: "stop"}`; server:
1. Sets `state.stopping = true`, clears `state.queue`.
2. `SIGTERM` the live `claude` child process; 2s timeout then `SIGKILL`.
3. On `close`, the finally block detects `stopping` and emits `⏹ Discussion arrêtée.` instead of the usual error message. Clears `stopping` and `queue` so the next user message starts fresh.
Queue is cleared because stopping means "drop everything pending" — not just "kill the current turn and process the next".

### Switch discussion without reloading the page
Old behaviour: clicking a history entry did `location.href = ...` → full reload, CRM iframe re-mounted, lost local state. New `switchDiscussion(id)`:
1. Sets `switchingDiscussion = true` so `ws.onclose` doesn't show the "Connection lost" error.
2. Closes the current WS, clears chat UI state (`messages`, `currentDiscussionId`, title, stats), pushes new URL via `history.pushState`.
3. Opens a new WS with `?discussion=<id>`.
`popstate` handler mirrors this for browser back/forward. Iframe src is untouched → CRM state preserved across discussion switches.

### Keep writing log after user disconnects mid-turn
If the user closes the tab or switches discussion while claude is still running, `ws.on('close')` previously called `discussion.close()` immediately → log stream half-closed, assistant output arriving after that point was dropped. Now:
- If `state.busy` at close time → set `state.disconnected = true`, skip teardown.
- `processMessage`'s `finally` block reads the flag: once the turn settles (state transitioned to `terminee`), then cleans up `discussion.close() + connections.delete(ws)`.
Result: log.jsonl captures the full turn even when the user walks away.

### Integration smoke test
New `chat-service/test/smoke-discussions.mjs` (243 lines). Boots `server.js` against a temp log dir (`CHAT_LOG_DIR` + `PORT` override), exercises the full persistence + protocol surface: create/list/get/rename/resume, WS init event, message persistence, state transitions. Does NOT hit claude — only tests the persistence layer + WS wire format. Run: `node test/smoke-discussions.mjs`.

### UI additions
- Header buttons: `📂` (open history panel with list of discussions), `✚` (new discussion), `⏹` (stop current turn).
- Click the title to rename inline (PATCH via the new HTTP endpoint).
- State badge (`en_cours` / `terminee`) next to the title.
- Queued user messages rendered with a dimmed `⏳ en attente` badge; badge is removed once the server promotes the queued message to the active turn (detected via the `status:working` event following a prior `status:idle`).
- Send button stays enabled while a turn is running — allows queueing a second prompt without cancelling.

### Robustness touch-ups
- `proc.once('error', ...)` on every claude spawn — prevents unhandled errors (e.g., claude binary missing on PATH) from crashing the whole service. The error is folded into the stderr buffer and surfaced via `friendlyError`.
- `static` handler now splits on `?` before resolving the file path so query strings on `/` don't 404.

**Why**: user asked for persistent, multi-discussion chat with the ability to switch / rename / cancel / resume without losing the CRM iframe state. Before this phase the chat service was fundamentally single-session; the widget was a transient overlay, not a discussion history manager. Branch `multi-sessions` not yet merged to `main` as of this write-up.

---

## Phase 29 — Session stats panel

Dates: 2026-04-23 to 2026-04-24.

New 📊 button in the chat widget header, available when idle after the first user message, that swaps the chat area for a post-mortem statistics panel. Goal: give the user enough signal to diagnose reliability and speed of each run (agents, tool calls, hooks, skills, errors, retries) without having to dig through raw JSONL logs.

### Architecture
Pure server-side aggregator in [`chat-service/lib/stats.js`](chat-service/lib/stats.js) (exports `aggregateSession()`) — streaming read of the session JSONL plus `hooks.log` correlation by worktree, no cache in v1. Endpoint `GET /api/stats?sessionId=<id>` in [`chat-service/server.js`](chat-service/server.js) derives the log path directly from the discussion UUID (`LOG_DIR/<sessionId>/log.jsonl`) — no extra server state. Vanilla UI in [`chat-service/public/`](chat-service/public/): button in the header, mode swap via a `chat-stats-mode` CSS class, small `el()` DOM helper used everywhere to avoid `innerHTML` on dynamic data (agent descriptions derive from the user prompt and are potentially attackable).

### Panel (5 sections)
1. **Summary header** — KPIs (duration, agents, ops, tokens, cost, errors, retries), one pill per team, and a horizontal stacked bar for time breakdown by agent type.
2. **Two-level timeline** — phases (orchestrator + each subagent) in chronological order; each phase is collapsible and expands into a sub-timeline (tool calls, invoked skills, hook executions correlated from hooks.log, plus `stream_gap` rows — see below).
3. **Top operations** — 3 leaderboards (longest agents, longest tool calls flagged yellow when > 30s, most-used tools with cumulative duration).
4. **Skills / hooks / rules** — aggregated counts; hooks show ✓/✗/SKIP and tag `blocking` for the intentional PreToolUse blockers; rules are detected by reads of `.claude/rules/*.md` (heuristic, documented with an inline note).
5. **Errors & retries** — chronologically merged list, entries expandable to show the payload tail; 4 error sources (`notification{priority:immediate}`, `result.is_error`, `task_notification.status:failed`, non-blocking `hooks.log EXIT≠0`) and 3 retry heuristics (`(retry)`/`(after X)` suffix, failure followed by a similar re-dispatch within 5 min, duplicate description within 5 min).

### Accurate durations
Tool durations are derived from explicit `tool_use.id ↔ tool_result.tool_use_id` pairing in the stream; the delta between those two timestamps is the real wall-clock cost. The inter-tool time (model reasoning, API wait) is surfaced separately as a `stream_gap` child row with a factual `eventsDuringGap` count of substantive assistant/user events strictly inside the window (`task_progress` excluded — it fires at every tool boundary as metadata). When the next assistant message carried `thinking` or `text` blocks, those are captured as a `preview` string on the row. The UI splits gaps accordingly: 💭 "gap" with preview for stream-active windows, ⏸️ "silent gap" for windows with zero substantive events — no claims beyond what the log shows. Orchestrator duration uses interval-union over agent phases (not sum) so parallel dispatches no longer clamp it to 0.

### Tests
26 Node tests using built-in `node:test`, against realistic JSONL + hooks.log fixtures (the richest is `parallel-two-teams.jsonl`, adapted from the real 2026-04-23 log: 2 TeamCreates + 12 agents + 1 retry). A dedicated `tool-timings-with-gaps.jsonl` fixture covers the pairing, batched tool_use handling, and active-vs-silent gap detection. No UI tests — manual validation via 3 browser scenarios (happy path, full parallel session, fetch error).

### Notable details
- Agent↔team linkage is **explicit** via `Agent.input.team_name` indexed by `tool_use_id` (referenced back by `task_started.tool_use_id`). No temporal-bracket guessing — the line is drawn at the Agent call itself.
- Blocking hooks (`block-bash-*`, `circuit-breaker.sh`, `silent-mode-check.sh`) are identified by an explicit allowlist: their EXIT=2 is expected behavior, not an error.
- New bind mount `./chat-service/lib:/chat-service/lib:ro` in `docker-compose.yml` so the aggregator can be iterated on without rebuilding the image.

### Workflow
Implemented with the `superpowers:subagent-driven-development` skill — one commit per task in TDD (red test → implementation → green test → commit), then three follow-up commits that tightened duration semantics after validating the panel on real session logs. Spec: [docs/superpowers/specs/2026-04-23-session-stats-panel-design.md](docs/superpowers/specs/2026-04-23-session-stats-panel-design.md), plan: [docs/superpowers/plans/2026-04-23-session-stats-panel.md](docs/superpowers/plans/2026-04-23-session-stats-panel.md).

---

## Phase 30 — `cancelled` session state + saveMeta race fix (2026-04-24, branch `feat/progress-bar+new-status`)

Previously, pressing ⏹ STOP transitioned the session to `completed` — indistinguishable from a natural end-of-turn. The history panel couldn't show "user-interrupted" vs "done" at a glance.

### New `cancelled` state
- `ALLOWED_STATES` in `chat-service/server.js` extended to `{'in_progress', 'completed', 'cancelled'}`.
- `processMessage` finally block now transitions to `cancelled` when `wasStopped`, else `completed` (previously always `completed`).
- `STATE_LABELS` in `chat.js` adds `cancelled: 'Cancelled'`; `setDisplayedState` gives it a dedicated tooltip.
- CSS badge `.state-cancelled` in orange (`#fb923c`) to distinguish from green (in_progress) and gray (completed). Applies to both the session state pill and the history panel items.

### Concurrent `writeFile` race on `meta.json` — root cause of "sessions disappearing"
After adding `cancelled`, cancelled sessions stopped showing up in the history list. Investigation found their `meta.json` ended with `}}` (two closing braces) — invalid JSON, silently dropped by `listSessions()`'s `JSON.parse` try/catch.

Trace:
1. Stop branch at line 541 calls `runtime.session?.recordMessage('assistant', '⏹ Session stopped.')` **without `await`** (fire-and-forget) — mutates `meta.messageCount++` + `lastMessageAt`, issues `writeFile(meta.json)`.
2. Finally block immediately runs `await transitionState(runtime, 'cancelled')` — mutates `meta.state = 'cancelled'`, issues a second `writeFile(meta.json)`.
3. Both `writeFile` calls open with `O_TRUNC | O_WRONLY` and write concurrently. Kernel-level interleaving of the two write streams produces a file that is roughly one JSON body followed by the trailing `}` of the other.
4. `listSessions` swallows the parse error → session silently drops from the list.

Fix in `server.js:545`: `await` the `recordMessage` call in the stop branch so the two writes serialize. Every other `recordMessage` call site is already isolated from `saveMeta` via idle turns, so no changes elsewhere. Two existing corrupt `meta.json` files (`f57dc412-…`, `5a0db60d-…`) manually repaired by stripping the trailing `}`.

**Why**: the race was latent before Phase 30 because the prior code only called `transitionState('completed')` whether stopped or not — and the preceding `recordMessage('⏹ Session stopped.')` raced against `saveMeta('completed')` the same way, but the previous `meta.state` was already `in_progress` so `setState('completed')` was the only *effective* write. Adding the third state revealed the race. Alternatives considered: serializing all `saveMeta` via a per-session mutex — overkill for a 50-line server; writing via rename (tmp + `rename()` atomic swap) — defensible but adds complexity. `await` is the minimal fix that matches the existing pattern (`setState` / `setTitle` / `setClaudeSessionId` are all awaited at their call sites too).

### `waiting` state when Claude asks a question

Before: after a turn, the session went to `completed` whether Claude had actually finished the work or was asking the user a follow-up question ("Which color do you want?"). From the history panel, both looked the same — a gray "Completed" badge — and the user had no cue that Claude was idle *because it needed input*, not because the task was done.

Added a fourth state `waiting`:

- `ALLOWED_STATES` extended to `{in_progress, completed, cancelled, waiting}`.
- `processMessage` now tracks `lastAssistantText` through the turn, and the finally block picks the next state via a small decision tree:
  - `wasStopped` → `cancelled`
  - `turnErrored` (non-zero exit, rate limit, result error, no text) → `completed`
  - last assistant message ends with `?` → `waiting`
  - else → `completed`
- Detection helper `endsWithQuestion(text)` strips the trailing punctuation / closing fences / emojis from the last non-empty paragraph and checks for `?`. Last-paragraph scoping means a mid-message question followed by a conclusion does NOT trigger `waiting`; a question followed only by a code block or a closing emoji does.
- `STATE_LABELS` adds `waiting: 'Waiting'`; `setDisplayedState` sets tooltip "Claude is waiting for your reply".
- CSS badge `.state-waiting` in blue (`#60a5fa`) — visually distinct from green (in_progress), gray (completed), orange (cancelled).

**Why a text heuristic and not a dedicated event**: Claude doesn't emit a structured "I'm asking a question" signal — the only explicit hook is the `choices` event, which is only used for the initial welcome buttons (`WELCOME_CHOICES`). Introducing a convention (e.g. orchestrator must emit `{type: 'question'}`) would require teaching the orchestrator prompt a new protocol and would likely be ignored half the time. The `?` heuristic piggy-backs on a natural-language convention Claude already follows ~100% of the time in both French and English, with near-zero false positives (statement sentences don't end in `?`).

**Known limits**: (1) Questions embedded in markdown bullet lists get detected correctly (last-paragraph captures the final bullet), but a rhetorical question followed by a definitive answer in the SAME paragraph will trip the heuristic. (2) A Claude turn that ends with a tool call (no trailing text) keeps the previous text as `lastAssistantText`, which is fine — tool calls always continue the turn, so we're only evaluating at true turn-end.

---

## Phase 31 — Progress counter, bouncing dots, favicon, Makefile (2026-04-27, branch `feat/progress-bar`)

A round of UX-and-tooling polish on top of the multi-session work: replace the static spinner with bouncing dots, surface ticket progress *inside* the working bubble (instead of a separate UI strip), pin the bubble below the latest assistant message until the turn truly ends, and add a few quality-of-life primitives (favicon, Makefile).

### Working bubble: bouncing dots + sticky bottom anchor
- `chat.css` — `.msg-working` is now an assistant-style bubble (radius / border-bottom-left-radius matching `.msg-assistant`) wrapping a 3-span `.bouncing-dots` element. Animation (`@keyframes dotBounce`) staggers each dot by `-.16s`, vertically translating 5px.
- `chat.js` — the working bubble's `dataset.seq` is set to `Number.MAX_SAFE_INTEGER` so `placeIntoMessages` always inserts new content (queued user messages, intermediate assistant messages) *before* it. The previous handler in `msg.type === 'message' && role === 'assistant'` removed the bubble explicitly; that line is gone — only the `status: working=false` frame at end-of-turn drops it.

**Why**: when Claude streams multiple assistant messages within a single turn (long answers, planner narration), the dots used to disappear after the first message and the user thought processing had stopped. The seq sentinel + removal-on-status-only fix keeps the dots glued under the latest message until the turn actually ends.

### In-bubble progress counter ("tasks completed N/M")
- New WS frame `{type: 'progress', total, done}`. Server emits it from `sendProgress(runtime)` which reads the session folder, filters `TASK-*.json`, counts those with `status === "merged"` over the total.
- Client renders the counter as a sub-element of `.msg-working` (`.msg-working-progress`), only when `total > 0`. Reset to 0/0 (counter hidden) when no ticket-driven work is going on.
- An earlier draft used a separate horizontal progress *bar* mounted just below the chat header — thrown out before merge in favour of the textual line under the dots, which is less visually heavy and self-hides when irrelevant.

**Why**: complex requests (FULL_SETUP, multi-feature edits) spawn N tickets via the planner and the merger flips them to `merged` one by one. Without a counter, the user has no signal that "5 of 8 tickets done" — the working bubble alone is binary (working / not working). The textual "N/M" makes progress visible without taking up vertical space when irrelevant.

### Tickets relocated next to the session log
- Tickets used to live in `docs/tickets/TASK-XXX.json` (a single global pile). Now they're written **per session** at `<LOG_DIR>/<sessionId>/TASK-XXX.json`, alongside `log.jsonl` and `meta.json`.
- `chat-orchestrator.md` and ticket-related skills/agents updated to point planner/merger writes at the per-session folder.
- `computeProgress()` reads from the session folder directly — no global cross-talk between concurrent sessions.

**Why**: a global ticket pile was already broken under multi-session; tickets from session A would leak into session B's progress count. Per-session folders are the natural fix and align with the "everything for a session lives in one folder" invariant introduced in Phase 28.

### Turn-scoped progress (baseline snapshot)
Without scoping, the counter showed *cumulative* per-session ticket counts: at the start of turn N+1 it would still display "tasks completed 1/1" from turn N, irrelevant to the new prompt.

- `snapshotTickets(sessionDir)` — returns the `Set<filename>` of `TASK-*.json` present at a given point in time.
- `computeProgress(sessionDir, baseline)` — accepts an optional baseline Set; files in it are excluded from the count.
- `processMessage()` snapshots `runtime.turnTicketBaseline` *before* spawning Claude, then immediately broadcasts `progress: 0/0` so the client UI resets *before* the working bubble mounts (preventing a flash of stale "1/1").
- `sendProgress()` reads `runtime.turnTicketBaseline ?? new Set()` and forwards it to `computeProgress`.

**Why**: between turns the working bubble isn't visible anyway, but the moment the user submits a new prompt the bubble reappears — and would briefly paint the previous turn's totals. Scoping per-turn keeps "N/M" honest: it counts only what *this* prompt produced.

### Hot-reload of progress: fire on `tool_result`, not `tool_use`
The first version of the progress refresh fired `sendProgress()` when an `assistant` event contained a `tool_use` of `Write`/`Edit` against `*/TASK-*.json` — but at that moment the file wasn't yet on disk, so `readdir` missed it and the counter stayed at `0/N`.

Fix in `processMessage`:
- On `assistant` events, stage `tool.id` in a per-spawn `pendingTicketWrites: Set<string>` whenever the tool_use targets a TASK ticket.
- On `user` events (which carry `tool_result` blocks), if any `tool_result.tool_use_id` matches a staged id, delete it and *then* fire `sendProgress()` — the file is now on disk.
- `sendProgress()` on `result` events stays as a fallback for end-of-turn merges.

**Why**: the earlier path was racy and the user reported "the counter doesn't change without a page refresh". The fix keys the broadcast off the post-write event, eliminating the race entirely.

### AI-mode favicon
- New `chat-service/public/favicon.svg` — heavy reuse of the original Atomic-CRM logo (orbital arc + nucleus) with the comet-tail at the upper-right replaced by a 4-point sparkle (the same `✦` glyph used as `#chat-header-icon`). Blue→purple gradient (`#3b82f6 → #8b5cf6`) matches the chat's accent palette.
- Wired in `index.html` via `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`.
- `MIME_TYPES` in `server.js` extended with `'.svg': 'image/svg+xml'` — without this, the static handler fell back to `text/plain` and the browser refused to render the file as a favicon.

**Why**: the chat had no favicon (default browser globe). The new icon signals "Atomic-CRM, AI-flavoured" at a glance in the tab bar.

### Makefile
First-class wrapper for the docker-compose lifecycle and chat-service test commands. Auto-documented `make help` (extracted via `awk` from `## description` comments in target lines).

Targets: `build`, `up` (demo profile), `up-full` (full profile), `down`, `restart`, `logs`, `shell` (exec into `atomic-crm-demo`), `test`, `test-smoke`, `bench`, `bench-update`, `clean-sessions`, `reset`.

- `make clean-sessions` — interactive `[y/N]` prompt by default, skipped via `YES=1`. Uses `find sessions -mindepth 1 -delete` so the gitignored `sessions/` directory itself stays.
- `make reset` — orchestrates `down → clean-sessions YES=1 → build → up`. Used after destructive iterations on the orchestrator/agents to start from a known-clean state.

**Why**: the README documented `docker compose --profile demo up` etc. but typing the long form repeatedly is friction; a Makefile is the conventional answer and the `## description`-driven help keeps docs and code in sync.

---

## Phase 32 — Documentator agent (phase 1, 2026-04-27, branch `feat/agent-documentator`)

A new agent that observes the team's activity and writes a structured "patterns ledger" for the maintainer to review. Phase 1 is **read-only**: no config mutation, no auto-application of proposed actions. The trajectory is calibration first (the maintainer reviews detection quality + applicability), acting later (phase 2 — counter-gated auto-apply per action category, designed but not implemented).

### Documentator agent
- New `claudeConfig/.claude/agents/documentator.md` (sonnet, restricted tool list).
- Reads 5 sources every run: `docs/reflections/*.md`, `/chat-service/logs/hooks.log`, per-session `log.jsonl` files (offset/limit reads — these get large), and the existing ledger.
- Writes only to `/app/docs/learnings/patterns.md`. Never touches anything under `/app/src/`, `/home/developer/.claude/`, or shipped config.
- Pattern entry format with fields: `Status`, `Occurrences`, `First seen`, `Last seen`, `Evidence` (TASK-IDs / session-IDs / hooks.log line ranges), `Symptom`, `Hypothesis`, `Proposed action` (`Type`, `Files Touched`, `Depends on`, `Content`), `Promotion criteria for phase 2`.
- Action-type hierarchy from least to most invasive: `skill-extension < new-hook < new-rule < new-skill < modify-existing < agent-prompt-edit`, plus `escalation` for cases no additive lever captures.

### Cron module + manual endpoint
- New `chat-service/lib/documentator-cron.js` (~160 lines): `shouldSkipRun`, `loadDocumentatorPrompt`, `runDocumentator`, `scheduleDocumentator`. Five unit tests cover the deterministic helpers (TDD).
- Daily cron at `0 3 * * *` Europe/Paris via `node-cron`. Skips when no session log has mtime newer than the last-run marker.
- `POST /api/documentator/run` for ad-hoc runs — **loopback only** (`req.socket.remoteAddress` checked against `127.0.0.1`, `::1`, `::ffff:127.0.0.1`, otherwise 403). Triggers a paid claude run, so an open external endpoint would be a free-money pump.
- Hardening: 30-min wall-clock timeout with `SIGTERM → 5s grace → SIGKILL` escalation; single-flight guard via module-local `documentatorRunning` flag held until `'close'` actually fires; `last-run.txt` only updated when `exitCode === 0` (spawn errors / timeouts must NOT silently mark the run as successful — that would suppress the next 24h of detections).
- Audit trail per run at `docs/learnings/runs/YYYY-MM-DD-run.md` — raw stream-json frames + spawn-error / timeout markers.

**Why**: today the team produces reflections (per-ticket narratives by DEVELOPER, read only by DEVELOPER), but no mechanism aggregates patterns across reflections + hook failures + retries + user friction. Adding a daily synthesizer means recurring frictions become visible (with counter + evidence trail), which is the prerequisite for any later "evolve the team based on real signals" work.

### Bash whitelist hook
- New `claudeConfig/.claude/hooks/restrict-documentator-bash.sh`, registered as the 5th `PreToolUse / Bash` hook. Gated on `DOCUMENTATOR_RUN=1` env var (set in the spawn env from the cron module) — pass-through for every other agent and for non-documentator claude sessions.
- Whitelist: `git log`, `git show`, `ls`, `wc -l`. Anything else → exit 2 + stderr message.
- **Metachar guard before the prefix check**. The first version was prefix-only and let `git log; rm -rf /app/docs/learnings/patterns.md` through (`;` chains the second command after the whitelisted first). The hardened version rejects any command containing `;`, `&&`, `||`, `|`, backtick, `$(`, `>`, `<`, or newline before the regex prefix check, so shell-metachar exploits land on exit 2.

**Why**: documentator's "read-only mandate" depends on Bash being unable to exfiltrate or mutate. The hook is the only enforcement (frontmatter `tools` is informational with `-p` spawn). Caught in the e2e smoke: agent attempted `ls -la /chat-service/logs/ | tail -30`, hook blocked the pipe, agent adapted to `ls` + `wc -l` separately.

### Bootstrap + bind for inspection
- `entrypoint.sh` extended to create `/app/docs/learnings/runs/` and seed `patterns.md` with the canonical header on first boot (heredoc guarded by `[ ! -f ... ]`).
- The named volume `crm-docs:/app/docs` was switched to a host bind-mount `./crm-docs:/app/docs` in the demo and full profiles. `./crm-docs/` is gitignored. Lets the maintainer open `crm-docs/learnings/patterns.md` directly in VS Code without `docker exec` or `docker cp`. Existing volume content was migrated via `docker cp` before the swap; the orphaned named volume can be removed with `docker volume rm crm-builder_crm-docs`.

### Wiring
- `chat-service/server.js` calls `scheduleDocumentator(DOCUMENTATOR_OPTS)` in the boot block before `httpServer.listen()`.
- `DOCUMENTATOR_OPTS` exported from `chat-service/lib/server/config.js` (composed from `LOG_DIR`, `CLAUDE_HOME`, `CWD`).
- The POST route lives in `chat-service/lib/server/http-routes.js`, which imports `runDocumentator` from `../documentator-cron.js`.

### Field labels — English-only
- The initial agent prompt used French field labels (`Premier vu`, `Dernier vu`, `Symptôme`, `Hypothèse`, `Action proposée`, `Contenu`, etc.) carried over from the design discussion. Fixed to English (`First seen`, `Last seen`, `Symptom`, `Hypothesis`, `Proposed action`, `Content`) to match the CLAUDE.md "agent prompts → English" convention. Existing 7 patterns produced in the smoke run were sed-replaced in place to keep the ledger consistent.

### Design + plan
- `docs/superpowers/specs/2026-04-27-documentator-design.md` — full spec with phase 1 / phase 2 trajectory, ledger format, validation criteria, deferred questions.
- `docs/superpowers/plans/2026-04-27-documentator-phase1.md` — 10-task implementation plan executed via subagent-driven development (fresh subagent per task + spec compliance + code quality reviewer between tasks).

### Smoke test
- `docker compose --profile demo up -d`, manual trigger via `curl -X POST http://localhost:8080/api/documentator/run` from inside the container. Exit 0, 7 minutes, $1.08 sonnet.
- 7 patterns detected on the first run (P-001 `prettier-exit2-persistent-worktree` through P-007 `base-branch-typecheck-contamination`). Each entry has the canonical format, evidence trail to `hooks.log` line ranges + TASK-IDs, and a concrete `Proposed action` with `Files Touched` and `Content`.
- `node-cron` was `npm install`-ed at runtime against the live container; **a fresh `docker build -t atomic-crm-dev .` is required** before any clean-environment deploy (otherwise `chat-service` FATALs with `ERR_MODULE_NOT_FOUND: 'node-cron'`). `package.json` and `package-lock.json` already carry the dep.

---

## Phase 33 — UI redesign: persistent layout + side stats + log-hydrated state (2026-04-30, branch `refonte-UI`)

A full-day pass on the chat UI: scrap the floating-widget-with-FAB shell in favour of a docked, full-height application layout (sessions sidebar + chat panel + CRM iframe), make the stats panel a real side aside instead of a mode that hijacks the chat area, and harden state continuity so refreshing or closing+reopening a tab no longer loses tokens/cost/debug history. Plus several bug fixes that surfaced once the panels were more visible (per-session `hooks.log`, formatDuration zero, debug-mode survival across sessions).

### Layout: docked three-column shell, no more FAB

- The previous shell had a 420×620 floating widget pinned bottom-right, a `#chat-fab` reopen button, a `#chat-actions` toolbar floating to its left, and a `#chat-history-panel` that slid out as a popup. All five gone.
- New layout in `chat.css` is driven by two CSS custom properties on `<body>`: `--sidebar-width` (300px / 48px collapsed / 0 closed) and `--widget-width` (35vw / 0 closed). `body:has(#chat-history-panel.collapsed)` and `body:has(#chat-widget.chat-closed)` retarget those vars so the iframe / widget stack stays in sync without JS layout code.
- `#crm-frame` is `left: var(--sidebar-width); width: calc(100vw - var(--sidebar-width))`, `#chat-widget` is `left: var(--sidebar-width); width: var(--widget-width)`, both with matching `transition: left/width .2s` — collapsing the sidebar or closing the widget animates everything together.
- `#chat-widget.chat-closed` no longer `display: none`s; it stays in flow with `width: 0; opacity: 0; pointer-events: none` so the close→reopen transition is smooth and the iframe expands into the freed space.

**Why**: the floating widget made the CRM iframe + sessions list compete for screen real estate (the widget covered the bottom-right corner of the CRM, and the sessions popup covered the widget). Docking turns the chat into a first-class panel of the app shell, gives sessions permanent visibility, and lets the user collapse rather than dismiss when they need more CRM room.

### Persistent sessions sidebar (collapsible, recent-sessions fly-out)

- New `#chat-history-panel` is a vertical sidebar always present on the left edge. Header shows the favicon + a collapse button; below it sit a sticky `+ New session` button and the scrolling history list.
- Collapse state is persisted in `localStorage` under `chat-sidebar-collapsed` so reloads remember the user's preference. Collapsing hides everything except the `+` icon, the collapse-toggle, and a new `#history-recent-btn` (chat-bubble icon).
- `#history-recent-btn` opens a popover showing the 5 most recent sessions, anchored vertically next to its trigger via a runtime `getBoundingClientRect()` read. The popover closes on outside-click, on `Escape`, on session-switch, and on `window.resize` (chosen over re-anchoring live — the rect-based positioning would drift during resize and the resize itself usually means the user is changing their layout, so closing is the more honest behaviour).
- `loadHistory()` now runs unconditionally at boot rather than only when the panel is opened; `refreshHistory()` is a no-op when the panel is collapsed (collapsed mode uses the recent-sessions popover instead, which fetches on each open).
- History list items use a separate `closeDiscussion()` path when the user clicks the *currently active* session (used to be `historyPanel.hidden = true`, which doesn't apply to a permanent panel).

**Why**: with the sidebar always visible, the previous open/close logic was wrong on every level — `historyPanel.hidden` no longer toggles, "open history" no longer happens explicitly, and clicking the active session now means "close the chat panel" not "close the history popup". The collapsed-mode recent fly-out is the compromise so users who want maximum CRM room still have one-click access to recent sessions without expanding the full sidebar.

### Welcome modal replaces `WELCOME_CHOICES`

- `WELCOME_CHOICES` (the inline two-button "Set up my CRM from scratch / Make a quick change" prompt) deleted from `lib/server/config.js`. The init handler no longer sends `choices` for new sessions.
- Replaced by an empty-state link inside `#chat-messages`: `Define your business` — opens a confirmation modal (`#chat-modal`) with title "Set up my CRM from scratch?", a Cancel/Let's go pair, backdrop-click + Escape + Enter handling.
- Enter-to-confirm only fires when neither button has focus — so a user who tabs to Cancel and presses Enter cancels (the browser's native button activation handles that case), avoiding the trap where Enter always means "confirm".
- On confirm, the client sends `{ content: 'FULL_SETUP', display: '🗺️  Set up my CRM from scratch' }` — same payload as the old choice button, so the orchestrator side is unchanged.

**Why**: the inline choices made every empty session feel like a vending-machine ("pick a button"), even for users who already knew what they wanted. The free-form input is now the default; the FULL_SETUP affordance is still discoverable via a single-line CTA in the empty state. The confirmation modal exists because FULL_SETUP launches a 30+ minute interview — users were occasionally clicking it by mistake and ending up in the wrong flow.

### Side stats panel (sliding aside, live refresh)

- `#chat-stats-panel` was previously an in-widget element that the chat-area mode-switched into via `widget.classList.add('chat-stats-mode')` — chat content was hidden, stats took over, the toolbar button toggled `📊` ⇄ `←`.
- Now it's an `<aside>` docked to the right of the chat widget (full-height, slides in/out via `transform: translateX(100%)`), with its own header + close button. Chat content stays visible behind it, so users can read the conversation while inspecting stats.
- The `📊` button is no longer hidden until the first user message — it shows immediately. The button toggles a `.stats-active` class for visual feedback instead of swapping its glyph.
- New live-refresh: `scheduleStatsPanelRefresh()` re-fetches `/api/stats` whenever `stats` or `status` events arrive while the panel is open, debounced to a minimum 2s interval (`STATS_REFRESH_MIN_INTERVAL_MS`) to keep the panel in sync with an in-progress turn without thrashing the aggregator.
- Top-ops section dropped (`stats/top-ops.js` removed, `summary.js` no longer surfaces "ops" count). The summary KPI line keeps duration / agents / tokens / cost / errors / retries.

**Why**: the chat-replaces-stats mode meant users couldn't watch a long-running turn while reading what was previously said — they had to flip back and forth. The aside lets both views coexist. The live refresh closes the gap between the inline `🤖 N · X in · Y out · $Z` ticker (always live) and the rich panel (used to be a frozen snapshot from when you opened it). Top-ops was redundant with the chronology section's per-phase costs.

### Stats hydrated from the log (survive runtime teardown)

- `messagesFromLog` is replaced by `digestLog`, which now also extracts `{ tokensUsed, costUsd }` by summing across `result` events in the log (per-spawn cumulative `total_cost_usd`, sum of `input + cache_creation + output` tokens — `cache_read` still excluded as before).
- `openSession` returns the digest's `stats` alongside `messages` / `recentDebug` / `timeline`. `createRuntime` seeds `stats.tokensUsed` and `stats.costUsd` from `session.stats?.tokensUsed || 0` instead of starting at 0.
- On (re)connect, `server.js` emits a `stats` frame *only if* `tokensUsed > 0 || costUsd > 0` so a fresh session doesn't flash "0 tokens · $0.000" before the first turn lands.

**Why**: previously, when the last connected tab closed the runtime was torn down, and the next page-load got `tokensUsed = 0 / costUsd = $0.000` even though the log carried full history. Users complained that "the cost counter resets when I refresh". The log is the source of truth for messages already; piping the same digest through to derive cumulative stats is the natural fix and keeps the inline ticker honest across runtime lifetimes.

### Debug events in chronological timeline (replaces append-at-end)

- `digestLog` now produces a single `timeline: [{kind: 'message'|'debug', ...}]` chronological interleave instead of two separate arrays. Messages and debug events appear in the order they were logged, capped at `DEBUG_REPLAY_MAX = 1000` debug entries (oldest dropped, message ordering preserved via a side index of debug slot positions).
- `init` frame now carries `timeline` (new field) alongside `messages` (kept for back-compat with older clients). When `timeline` is present, the client renders items in order — debugs land between the messages they happened between, not bunched at the end after a refresh.
- Client buffers each replayed debug event back into `pushDebugEvent` so a later debug-mode toggle still has the same in-memory buffer that a continuously-connected tab would have.
- The cap exists because an orchestrator turn emits hundreds of `debug_raw` frames and the log grows unbounded across multi-turn sessions; without a cap, a refreshed tab could replay tens of thousands of debug events and freeze the renderer.

**Why**: the previous "messages first, then a wall of debugs" layout was wrong about temporality — a debug event explaining a tool call should sit *next to* the assistant message that triggered it, not three turns later. The cap-with-message-preservation invariant came up in review: dropping older debug entries is fine, but dropping a message would be a data-loss bug.

### Per-session `hooks.log` (was leaking across sessions)

- All hook scripts (`block-bash-file-write.sh`, `block-bash-validation.sh`, `circuit-breaker.sh`, `prettier-on-stop.sh`, `run-e2e-tests.sh`, `run-unit-tests-app.sh`, `run-unit-tests-functions.sh`, `typecheck-on-commit.sh`) now write to `$CHAT_SESSION_DIR/hooks.log` instead of the global `/chat-service/logs/hooks.log`.
- `claude-spawn.js` exports `CHAT_SESSION_DIR=<sessionDir>` into the spawn env; hooks read it from the environment.
- `lib/server/config.js` no longer exports `HOOKS_LOG_PATH`; `http-routes.js` builds a per-session `hooksLogPath` for `aggregateSession`.
- `documentator.md` updated to read from `/chat-service/logs/<session-id>/hooks.log`, and the agent's iteration loop folds hooks-log reads into the session-subdir scan (one less Read source).

**Why**: the global `hooks.log` mixed events from concurrent sessions, which made the per-session stats panel attribute another session's circuit-breaker trips and prettier failures to the wrong session. Once the stats panel became a permanent fixture (rather than an occasional lookup), this leak was suddenly visible on every screen.

### Polish round

- **SVG icons** replace emoji buttons on the toolbar (`📊 → bar-chart-2`, `🔍 → bug`, `↑ → arrow-up`, `⏹ → stop-square`, `✚ → text label "+ New session"`, `📂 → square-with-divider` for sidebar collapse, `chat-bubble` for recent-sessions popover trigger). Inline lucide-style SVGs, no asset pipeline.
- **`formatDuration` rewrite** in `public/lib/dom.js` — was returning `0s` for sub-second durations and `1m 5s` without zero-padding. Now: clamps to ≥ 1s (so a real 30ms tool call doesn't render as "0s"), zero-pads minutes/seconds (`1m 05s`), supports hours (`1h 05m 03s`).
- **Stop button moved into the form** (next to send) instead of the header. Send is hidden while working; stop replaces it. Cleaner mental model: the input area shows the action you can currently take.
- **`exitStatsMode` on session-switch** — `resetChatUi` now calls `exitStatsMode()` if the panel is open, so switching sessions doesn't leave a stale stats panel showing data from the previous session.
- **Debug mode survives session switch** — `clearMessageNodes()` only removes message DOM nodes, not the debug button state. Was previously `messages.replaceChildren()` which combined with toggle re-init silently dropped the active debug class on session-switch.
- **Modal-mode Enter handling** — when the welcome modal is open, Enter inside the chat textarea no longer fires the form submit (handled at the modal's own keydown listener with focus-aware logic).
- **Sidebar-state persistence under tests** — `chat-service/test/session-store.test.js` (new, 192 lines) covers the `digestLog` helper: tokens-without-cache-read, cost summation across multiple result events, malformed-JSON tolerance, debug timeline ordering, the `DEBUG_REPLAY_MAX` cap with message preservation. `chat-service/test/session-store.test.js` extended in c6c3f17 with debug-mode replay tests (+99 lines).
- **Auto-focus the textarea on new session** — `switchSessionAndOpen(null)` calls `input.focus()` so the user can start typing immediately. Recent-sessions popover closes on `window.resize` (anchored coordinates would drift).
- **`#chat-empty-state` empty hint** — "Define your business [link] to get better results" appears only when the messages list is empty, fades out as soon as the first message lands.

---

## Open items / known limits

- **`medium-new-field` test** times out at 15 min (bumped to 35 min). Real agent-team flow on a multi-file feature naturally takes 20-30 min.
- **Parallel developer dispatch still emits 4 tool_use in 4 separate assistant messages** (sonnet limitation). Parallelism works at the process level but the cosmetic "same message" batching fails. ~10s wasted per test, not a priority.
- **No hang detection on stuck subagents**. If a dev gets stuck in a polling loop (e.g., `until grep` on a dead background task), the orchestrator waits forever. Need a watchdog: if no subagent activity for > 10 min, alert; > 20 min, TaskStop.
- **Merger retry in Phase 25 test** hung for ~10 min with 8 tool calls (likely stdout buffering on `git merge | grep CONFLICT`). Watch for recurrence.
- **`task_notification` has no `task_type`** in the event, so matching completion to the started event relies on `task_id`. Works today but fragile if Claude Code changes event shape.
- **OAuth requires re-login after `docker compose down -v`** — expected behavior (volume removed).
- **Phase 28 smoke test does not cover the stop flow** — it's limited to persistence + protocol surface because it doesn't hit claude. Stop handler is only validated manually.
- **Haiku retitle fires exactly once** (`userMessageCount === 2`). Long discussions that drift topic keep the early-turn title. Manual rename is the escape hatch.

---

_Last updated: 2026-05-01 (Phase 33)_
