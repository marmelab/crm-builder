# noAgentTeam PTY — background-turn driver fix

**Goal:** Drive the COMPLEX wave via `background_result` (event-driven background turns) instead of the heavyweight `AUTO_CONTINUE_NUDGE` resume loop, so the chat is not flooded with "Waiting." narration and the progress bar advances continuously.

**Root cause (session 223ea737):** `background_result` fired 0 times. The 8 s `scheduleAutoContinue` loop re-entered active-turn state every cycle, preempting the natural background turns the orchestrator agent file is designed for (chat-orchestrator.md Step 2 — "each fired by an agent completion notification from the runtime"). Result: ~40 nudge turns each narrating → 77 chat messages; progress bar updated only 8× (stale, never reached 100%); premature stall messages (MAX_NO_PROGRESS=10 × 8 s ≈ 80 s patience vs multi-minute dev agents).

**Architecture:** Between active turns, while idle with pending tickets, a **nudge heartbeat** pokes the PTY stdin (`ptySession.nudge()`) so the runtime delivers pending background-agent completions → orchestrator runs Step 2 → Stop hook → `background_result`. `attachBgListener` processes those background turns: forwards milestone narration, and now also advances stats (dispatch tracking + task_started/notification) so the progress bar moves. `AUTO_CONTINUE_NUDGE` is demoted to a rare last-resort escalation when the heartbeat makes no progress for a long time.

**Tech Stack:** node-pty, Node EventEmitter, existing chat-service lib.

---

## Task 1: Persist tool/task correlation maps on the runtime

`toolMap` (tool_use_id → tool) and `taskRole` (task_id → role) are currently local to `processMessage`. Background turns need them to correlate a `task_notification` (later turn) with the dispatch that started it (earlier turn). Move them to the runtime, reset on a fresh (non-auto) user turn.

- runtime.js: add `toolMap: new Map()`, `taskRole: new Map()`.
- turn.js: use `runtime.toolMap`/`runtime.taskRole`; clear them when `!isAutoContinue`.

## Task 2: Extract shared `processStatsEvent(runtime, event, ctx)`

Pull the stats-advancing logic out of the active loop so both the active loop and the background listener run identical accounting:
- agent dispatch tracking (flowExpected, dispatchedSubagentTypes, emitDispatchPromptEvent)
- `system` task_started → activeAgents++, taskRole map
- `system` task_notification completed → agentsCompleted++, completedByRole, planner→loadTicketsAndWaves
- calls updateProgressBar / sendStats

Async (planner branch awaits loadTicketsAndWaves). Returns nothing.

## Task 3: Rework `attachBgListener`

- bgHandler: `await processStatsEvent(...)` for every event (advances progress during background turns), keep the deduped text broadcast, and on `background_result` update progress + check ticket completion.
- On `background_result`: read ticket statuses; if all terminal → stop heartbeat + documentator; else reset the heartbeat no-progress counter (progress was made).

## Task 4: Nudge heartbeat (`startBgDriver` / `clearBgDriver`)

- Interval ~6 s while `!runtime.busy` and ptySession alive.
- Each tick: read ticket statuses. All terminal → clear + documentator + transition completed. Pending → `ptySession.nudge()`; track consecutive unchanged pendingSig.
- Escalation: after `HEARTBEAT_STALL_TICKS` unchanged → one heavyweight `processMessage(AUTO_CONTINUE_NUDGE)`; after `HEARTBEAT_GIVEUP_TICKS` → surface stall message + transition error.
- Never surface friendlyError/stall on the silent heartbeat ticks.

## Task 5: Wire finally block

Replace the `scheduleAutoContinue` block with `startBgDriver(runtime)` when a turn settles `completed` with pending tickets. Keep documentator scheduling when no pending tickets.

## Task 6: Verify

- `cd chat-service && npm test` green (auto-continue.test.js, progress-bar.test.js, pty-session.test.js).
- Live: rebuild instance, run a COMPLEX request, confirm few chat messages (only milestones), progress bar advances to 100%, no premature stall.
