# turn.js — reference

Orchestrates the full lifecycle of one user turn in the PTY era: spawn (or resume) the interactive orchestrator → stream its transcript → log + broadcast → snapshot → hand off to the background driver when a COMPLEX wave is still in flight.

The orchestrator is no longer spawned headless (`claude -p`). It runs as a **persistent interactive TUI** driven over a PTY (`PtySession`, see `pty-session.js`). The process never exits on its own between turns — a turn ends when a positive completion signal arrives, not when the process dies.

## PtySession lifecycle (`pty-session.js`)

One `PtySession` per session, spawned via `node-pty`:

```
claude --dangerously-skip-permissions
       --strict-mcp-config --mcp-config '{"mcpServers":{}}'
       [--resume <CSID>]            # only when a Claude session id is known
       --agent chat-orchestrator    # loads the state machine + LANGUAGE RULES
       [--model <model>]
       --append-system-prompt '<mode>…</mode>\n<session_dir>…</session_dir>'
```

- **No MCP servers** for the orchestrator — the empty `--mcp-config` avoids ~8K tokens of account-level connectors and hides tools it must never call directly (everything routes via `Agent`).
- **`mode` + `session_dir`** are injected via `--append-system-prompt`, NOT in the user message — XML tags in the PTY input confuse the Ink TUI.
- **Resume** is a PtySession spawn arg: `--resume <CSID>` is passed when a Claude session id (CSID) is already known. There is no separate headless resume — the same persistent TUI is resumed.
- `send(message)` queues until the TUI is ready (first ❯ prompt, or a 12 s startup force-flush), sanitizes multi-byte punctuation that Ink mishandles, writes the text, then sends `\r` 50 ms later so long messages submit reliably.
- The TUI initializes by answering terminal capability queries (XTVERSION / DA1 / DECRQM) that `#onData` replies to; without them Ink blocks and ❯ never appears.

### Stop-hook sentinel = the completion signal

The orchestrator TUI never exits between turns, so turn completion is detected by a **sentinel file** written by the `Stop` hook (`claudeConfig/.claude/hooks/turn-complete.sh`):

- The hook fires AFTER Claude flushes its JSONL transcript and writes `/tmp/pty-turn-done-<CSID>` (an empty file; CSID read from the hook's stdin `session_id` via the shared `node -e` idiom — no `python3` dependency).
- `PtySession.#watchForStop()` arms an `fs.watch` on `/tmp` (plus a post-attach `access()` check to catch a sentinel that landed before the watcher attached).
- When the sentinel fires:
  - **active turn** (`#resultEmitted === false`): delete it, wait 150 ms (covers the 50 ms transcript-watcher debounce), emit `result` with `reason: 'sentinel'`.
  - **background turn** (`#resultEmitted === true`): delete it, double-flush the transcript watcher, emit `background_result`.

The sentinel is the **only positive completion signal**. A `silence` fallback (`TURN_TIMEOUT_MS` = 120 s after the last PTY chunk; `STARTUP_TIMEOUT_MS` = 12 s before the first chunk) emits `result` with `reason: 'silence'` — a degraded path. On silence, `is_error` is set if the screen buffer matches an auth/network signature (`isApiErrorStderr`).

`classifyTurn` (`turn-state.js`) folds the reason into the verdict: a `silence` result that produced **no text** is a failure (the orchestrator died/hung); a `silence` result **with** text stays `completed` (long COMPLEX turns may legitimately miss the sentinel).

## claudeSessionId (CSID) capture

The CSID is the Claude CLI's own conversation id — **distinct from the chat session UUID**. The `TranscriptWatcher` discovers it from the transcript's `session_id`; `turn.js` mirrors it onto `runtime.claudeSessionId` and persists it to `meta.json`. It becomes the `--resume <CSID>` arg on the next PtySession spawn.

## Active-turn loop (`processMessage`)

`ptyEventsUntilResult` yields PtySession events until a `result` arrives (or the PTY exits). Per event, the loop:

- captures the CSID on first sight and (re)starts the subagent tailer;
- broadcasts `debug_raw`;
- runs the shared text pipeline `handleOrchestratorText` (strip `<session-title>`, strip the `%%ASK_SATISFACTION%%` widget marker, dedup-vs-last, broadcast + record);
- runs `processStatsEvent` (dispatch detection → progress bar, agent start/complete accounting);
- detects rate-limit events;
- on `result`: records `reason`, folds the spawn's token usage into the per-spawn accumulators.

The `finally` block always folds per-spawn usage into cumulative stats, drains the queue, and decides the settle state.

## Background turns + heartbeat driver

Most COMPLEX work (developer, reviewers, merger) runs in **background turns**: the orchestrator dispatches `Agent({ run_in_background: true })` agents, the active turn ends, and each agent completion later wakes the idle TUI to run a Step-2 background turn. `attachBgListener` forwards those background events to clients while no active `processMessage` is running (it skips while `runtime.busy`).

`startBgDriver` runs a per-session heartbeat (`HEARTBEAT_MS` = 6 s) that keeps the idle wave alive:

- each tick reads `readTicketStatuses(sessionDir)` (TASK-*.json statuses) — `total === 0` → not a wave, stop;
- a healthy wave makes progress when the pending-ticket set changes OR a `background_result` fired since the last tick → `nudge()` the PTY (a net-zero space+backspace that triggers an Ink re-render so pending agent completions are delivered);
- **stall escalation**: after `HEARTBEAT_STALL_TICKS` (30 ≈ 3 min) of no progress, escalate once to a heavyweight `AUTO_CONTINUE_NUDGE` resume that re-states the STATE B instructions (capped at `MAX_BG_ESCALATIONS` = 3);
- **give-up**: after `HEARTBEAT_GIVEUP_TICKS` (60 ≈ 6 min), surface a stall message and settle `error`.

Driver state (`runtime.bgDriverState`: `noProgress`, `escalations`, `seenBgCount`, `drainQuiet`) lives on the runtime, not the closure, so it survives the clear+restart cycle of an escalation. It is reset only by a real (non-auto) user message or a wave end.

### Drain phase

When every ticket is `merged`/`failed` the wave still isn't done — promotion (session→main) and any follow-up run as background turns. The driver stays `in_progress` (bar visible) and keeps nudging until the orchestrator goes quiet for `HEARTBEAT_DRAIN_QUIET_TICKS` (12 ≈ 72 s) with no new `background_result`. Only then does it:

1. `collectUsage()` from the PtySession and fold the trailing subagent tokens into cumulative stats (no active-turn `result` fired on this path, so these would otherwise be lost);
2. take a final unconditional snapshot;
3. `transitionState(completed)`, broadcast `working: false`;
4. drain any user message queued behind the `waveActive` guard.

`stopBackgroundWave` is the STOP-button equivalent for a pure background wave: it clears the driver, stops the tailer, kills the idle PTY (`suppressNextPtyRestart`), and settles `completed`.

## Snapshot points

`snapshotClaudeSession(CSID, sessionId)` copies `~/.claude/projects/<project>/<CSID>/` → `/logs/<UUID>/claude/`:

- `transcript.jsonl` — full orchestrator stream
- `subagents/agent-*.jsonl` — per-agent transcripts (what `stats/subagents.js` reads — not the live path)
- `tool-results/` — cached tool outputs

It runs at three points so background-only waves are still captured:

- **throttled per `background_result`** — at most once per 30 s during a high-frequency wave;
- **unconditional in the active-turn `finally`** — every active turn;
- **unconditional on drain-completed** — guarantees the final state is captured even if the last background snapshot was throttled out.

## Subagent tailer

`startSubagentTailer` (`subagent-tail.js`) polls `subagents/` every 2.5 s and broadcasts new lines. It is (re)started every turn (idempotent) — on PTY spawn, on CSID capture, and on each `processMessage` entry when a CSID exists. It is NOT stopped in the turn `finally` while a wave is in flight: background turns between active turns must keep feeding the live view. It is stopped only when the wave truly settles (drain-completed, give-up, rate-limit) or on teardown.

## Idle reaper

`scheduleIdleTeardown` (`runtime.js`, `IDLE_TEARDOWN_MS` = 10 min) is armed on the last WS disconnect and cancelled by any reconnect or new turn. On fire, if clients are still gone and not busy: a wave still pending (`readTicketStatuses`) re-arms instead of killing; otherwise it sets `tearingDown` (so the PTY exit handler won't restart), kills the PTY, stops the tailer, and drops the runtime. Prevents an abandoned tab from leaking a PTY + watchers indefinitely.

## Recovery (resume vs fresh session)

`planResume` (`turn-helpers.js`, called via `resolveResumePlan` in `server.js`) decides how a resume re-enters:

| Condition | Result |
|---|---|
| State `error`/`rate_limited` (process was killed) **AND** a COMPLEX wave was in flight (`sessionHasTickets` → TASK-*.json on disk) | `freshSession: true` + a `<intent>recovery</intent>` recovery prompt |
| Otherwise (interview, SIMPLE, plain Q&A, limit before any dispatch, clean turn) | plain resume — `--resume <CSID>` preserves the conversation |

When `freshSession` is set, `processMessage`:

1. drops the CSID (`runtime.claudeSessionId = null` + persist null) so the next PtySession spawns **without** `--resume` — a brand-new conversation;
2. kills the live PTY (`suppressNextPtyRestart`) which still holds the dead "team is running" transcript;
3. STATE RECOVERY rebuilds the wave state from disk instead of re-injecting a stale belief.

**Stale-resume retry-once**: `claude --resume <missing-id>` exits immediately with no transcript events (no result, no text, PTY dead). When a resumed turn produces nothing of the sort, `staleRetry` drops the stale CSID and replays the turn once on a fresh conversation (guarded by `opts.staleRetried` so it never loops).

### Rate-limit settle during background turns

A blocked rate limit can surface from a background turn or from a subagent transcript (`subagent-tail.js` → `noteRateLimit` → `runtime.pendingRateLimit`). `settleBackgroundRateLimit` mirrors the active-loop path from the idle context: it clears the driver, kills the (hung) PTY, stops the tailer, records the friendly message, broadcasts `rate_limited` with `resetsAt`, and transitions `rate_limited`. Idempotent (`bgRateLimitSettling`) since both the main stream and a subagent may report the same limit.

## PTY restart

The PTY exit handler schedules **one** restart (`ptyRestartCount < 1`, 5 s delay) when the process dies while not busy — to drain pending background turns (wave transitions, merge confirmations) that arrived after the active turn ended. `tearingDown` / `suppressNextPtyRestart` suppress the restart for deliberate kills (recovery, idle reaper, stop, rate-limit).
