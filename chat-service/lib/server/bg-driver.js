// Background-wave driver: everything that keeps a COMPLEX wave alive while no
// active turn is running. The PTY sits idle between background turns, so a
// per-session heartbeat nudges it, tracks progress from ticket statuses,
// escalates on stalls, and settles the wave (completed / error / rate_limited).
// Split out of turn.js; the processMessage import is a deliberate module cycle
// (both sides only call each other at runtime, never during module init).
//
// State contract: `runtime` is the session's SHARED state object, held in the
// `runtimes` map and read concurrently by the WS handler, this heartbeat, the
// PTY exit handler and the idle reaper. The apply/note/ensure/settle/stop
// helpers below MUTATE it in place — object identity is load-bearing (live
// closures hold the same reference; a copy would orphan them). Decision logic
// stays pure by convention (shouldSettleDrain returns a decision, the caller
// applies it).
import { LOG_DIR } from './config.js';
import { broadcast, sendStats } from './ws-bus.js';
import { transitionState } from './runtime.js';
import { stopSubagentTailer } from './subagent-tail.js';
import { readTicketStatuses, AUTO_CONTINUE_NUDGE } from './auto-continue.js';
import { friendlyError } from './turn-helpers.js';
import { applyCumulativeUsage } from './turn-usage.js';
import { snapshotClaudeSession } from './transcript-snapshot.js';
import { processMessage } from './turn.js';

// ── Background-turn driver tuning ───────────────────────────────────────────
// While the session is idle with pending tickets, a heartbeat nudges the PTY so
// the runtime delivers pending background-agent completions → the orchestrator
// runs its Step 2 background turn → Stop hook → `background_result`. This is the
// primary wave driver (chat-orchestrator.md is built for event-driven background
// turns). The heavyweight AUTO_CONTINUE resume is only a stall escalation.
const HEARTBEAT_MS = 6_000;
// Consecutive heartbeat ticks with an unchanged pending-ticket set before each
// escalation. ~6 s/tick: 30 ticks ≈ 3 min (one slow developer), 60 ≈ 6 min.
const HEARTBEAT_STALL_TICKS = 30;   // → one heavyweight AUTO_CONTINUE resume
const HEARTBEAT_GIVEUP_TICKS = 60;  // → surface stall message, settle on error
const MAX_BG_ESCALATIONS = 3;       // hard cap on AUTO_CONTINUE resumes per wave
// When every ticket is merged the wave isn't done yet: promotion (session→main)
// and any follow-up (e.g. a translation fix) still run as background turns. Stay
// in_progress (bar visible) and only settle `completed` after this many ticks
// with NO new background turn — so the orchestrator's final recap lands in chat
// before the bar disappears. Must exceed the promotion merger's run time (~30-60s)
// so we never complete during the idle gap while it runs. 12 ticks ≈ 72 s.
const HEARTBEAT_DRAIN_QUIET_TICKS = 12;
// Absolute wall-clock cap on the drain phase. Even if the quiet signal
// misbehaves, the drain force-settles after this long. Generous so a slow
// promotion merger + final recap always finishes first. 3 min ≫ 12 ticks·6 s.
const HEARTBEAT_DRAIN_MAX_MS = 3 * 60 * 1000;

// Pure drain-quiet decision, factored out so it's unit-testable without a live
// PTY. The drain phase runs after every ticket is merged while promotion + the
// final recap still run as background turns. "Progress" that should reset the
// quiet counter is REAL new output — a pending-ticket-set change (a late merge)
// or new assistant text from the orchestrator — NOT the empty background_result
// the heartbeat's own nudge induces every tick. Returns the next drainQuiet
// count and whether to settle (threshold reached, or the wall-clock cap hit).
// `nowMs`/`drainSince` are injected so callers (and tests) control the clock.
export function shouldSettleDrain(state, { pendingSig, sawProgress, nowMs }) {
  const madeProgress = pendingSig !== state.prevDrainSig || sawProgress;
  const drainQuiet = madeProgress ? 0 : (state.drainQuiet || 0) + 1;
  const capHit = state.drainSince != null
    && nowMs - state.drainSince >= HEARTBEAT_DRAIN_MAX_MS;
  return {
    drainQuiet,
    prevDrainSig: pendingSig,
    settle: drainQuiet >= HEARTBEAT_DRAIN_QUIET_TICKS || capHit,
    reason: drainQuiet >= HEARTBEAT_DRAIN_QUIET_TICKS ? 'quiet' : (capHit ? 'cap' : null),
  };
}

// Temporary instrumentation for the noAgentTeam PTY background-turn driver.
// Writes to chat-err.log (supervisor stderr). Remove once the driver is proven.
export function driverLog(msg) {
  console.error(`[bg-driver ${new Date().toISOString()}] ${msg}`);
}

// ── Background-turn driver ───────────────────────────────────────────────────
// Per-session heartbeat timers + state, keyed by session id.
const bgDrivers = new Map();

export function clearBgDriver(sessionId) {
  const d = bgDrivers.get(sessionId);
  if (d) { clearInterval(d.timer); bgDrivers.delete(sessionId); }
}

// Sync the wave flags with the active-turn settle decision. Both branches of
// the turn `finally` go through here: wave still in flight → mark it active for
// the bg driver; wave done (or none) → clear the flags and stop any driver, so
// a stale waveActive can never outlive the wave and trap messages in the queue.
export function applyWaveFlagsOnTurnSettle(runtime, waveInFlight) {
  if (waveInFlight) {
    runtime.waveActive = true;
    return;
  }
  runtime.waveActive = false;
  runtime.bgDriverState = null;
  clearBgDriver(runtime.session?.id);
}

// A progress bar may only be (re)rendered while something is actually running:
// an active turn (busy) or a background wave (waveActive). Late PTY events —
// e.g. the documentator dispatched at PD-RESPOND finishing after the session
// settled — must not resurrect a stale bar.
export function progressBarLive(runtime) {
  return !!(runtime.busy || runtime.waveActive);
}

// Tear down a COMPLEX wave that is running as background turns. Called from the
// STOP handler: during a background wave `busy` is false and `currentProc` is
// null (the active turn handed off), so killCurrentProc no-ops — the heartbeat
// and the idle PTY are what actually keep the wave alive. Always clear waveActive
// + stop the heartbeat. When STOP fires with no active turn (the pure background
// case), also stop the tailer, kill the idle PTY, and settle the session here:
// no turn finally will run to do it. suppressNextPtyRestart stops the PTY exit
// handler from re-spawning the very wave we're killing (mirrors recovery's kill).
// No-op when no wave is active. Returns true when a background wave was settled.
export async function stopBackgroundWave(runtime) {
  if (!runtime?.waveActive) return false;
  runtime.waveActive = false;
  runtime.bgDriverState = null;
  clearBgDriver(runtime.session?.id);
  if (runtime.busy) return false;   // an active turn is taking over — its finally settles
  await stopSubagentTailer(runtime).catch(() => {});
  if (runtime.ptySession && !runtime.ptySession.closed) {
    runtime.suppressNextPtyRestart = true;
    try { runtime.ptySession.kill(); } catch {}
    runtime.ptySession = null;
  }
  await transitionState(runtime, 'completed');
  broadcast(runtime, { type: 'status', working: false });
  // A message queued before this settle (waveActive guard in server.js) would
  // otherwise be orphaned — no active turn will run a finally to drain it on
  // this non-busy path. Drain one now, mirroring the drain-completed branch.
  if (runtime.queue.length > 0) {
    const next = runtime.queue.shift();
    broadcast(runtime, { type: 'queue_updated', queuedIds: runtime.queue.map((q) => q.id) });
    runtime.busy = true;
    processMessage(runtime, next.content).catch(() => { runtime.busy = false; });
  }
  return true;
}

// Reconcile a possibly-stale `waveActive` against disk when a client (re)joins
// an existing runtime. A runtime that survived a long idle gap (e.g. overnight)
// can carry a stale waveActive=true — e.g. the old infinite-drain bug, or a PTY
// that died without a heartbeat tick clearing the flag. If every ticket is
// terminal (pendingCount===0), the runtime is not busy, and no bg-driver is
// actively running, the wave is over: clear the flag so the next user message
// dispatches instead of queueing forever. Drain any orphaned queued message.
// Minimal + safe: never clears while tickets are pending or a driver is live.
// Mirrors spawnOrResumePty's readTicketStatuses reconciliation pattern.
export async function reconcileWaveState(runtime) {
  if (!runtime?.waveActive || runtime.busy) return false;
  const sessionId = runtime.session?.id;
  if (!sessionId) return false;
  if (bgDrivers.has(sessionId)) return false;   // a driver is actively settling it
  const { total, pendingCount } = await readTicketStatuses(`${LOG_DIR}/${sessionId}`)
    .catch(() => ({ total: 0, pendingCount: 0 }));
  if (total > 0 && pendingCount > 0) return false;   // wave genuinely still running
  driverLog(`reconcile: clearing stale waveActive session=${sessionId} (total=${total} pending=${pendingCount})`);
  runtime.waveActive = false;
  runtime.bgDriverState = null;
  await transitionState(runtime, 'completed').catch(() => {});
  if (runtime.queue.length > 0) {
    const next = runtime.queue.shift();
    broadcast(runtime, { type: 'queue_updated', queuedIds: runtime.queue.map((q) => q.id) });
    runtime.busy = true;
    processMessage(runtime, next.content).catch(() => { runtime.busy = false; });
  }
  return true;
}

// Settle a COMPLEX wave that finished on the background drain path: all tickets
// merged, promotion + recap done. Factored out of the heartbeat so the quiet
// threshold and the wall-clock cap share one settle path (collect usage,
// snapshot, transition completed, drain the queue) — they must stay identical.
async function settleDrainedWave(current, sessionId) {
  current.waveActive = false;
  current.bgDriverState = null;
  clearBgDriver(sessionId);
  await stopSubagentTailer(current).catch(() => {});
  // The wave ended on the background drain path: no active-turn `result`
  // event fired, so the subagent tokens accumulated since the last
  // consumeTurnUsage() would otherwise be dropped. Collect + fold them in
  // here, using the same per-spawn → cumulative shape as the active-turn
  // finally, before settling completed.
  // Refresh subagent offsets (collectUsage reads any new subagent lines into the
  // watcher's cumulative), then set the cumulative deduped total as the final
  // figure. The cumulative is the live source of truth — matches /api/stats.
  await current.ptySession?.collectUsage().catch(() => null);
  const cum = await current.ptySession?.cumulativeUsage?.().catch(() => null);
  if (cum && Object.keys(cum).length > 0) {
    applyCumulativeUsage(current, cum);
    sendStats(current);
  }
  // Always capture the final transcript on drain-completed, even if the last
  // background_result snapshot was throttled.
  snapshotClaudeSession(current.claudeSessionId, current.session?.id).catch(() => {});
  await transitionState(current, 'completed');
  broadcast(current, { type: 'status', working: false });
  // The documentator (Mode 2) is now dispatched by the orchestrator itself
  // (Agent, at PD-RESPOND once the user confirms) — chat-service no longer
  // spawns it. Nothing to do here.
  // A user message that arrived while the wave ran in background was queued
  // (waveActive guard in server.js); drain it now that the session is free.
  if (current.queue.length > 0) {
    const next = current.queue.shift();
    broadcast(current, { type: 'queue_updated', queuedIds: current.queue.map((q) => q.id) });
    current.busy = true;
    processMessage(current, next.content).catch(() => { current.busy = false; });
  }
}

// Settle a wave that can no longer advance (heartbeat give-up, or PTY dead with
// no restart pending). Surfaces the stall once, transitions to `error` so the
// UI stops showing a live progress bar, and drains one queued message (a typed
// "continue" is exactly what the stall message asks for).
async function settleStalledWave(current, sessionId, { total, pendingCount }) {
  current.waveActive = false;
  current.bgDriverState = null;
  clearBgDriver(sessionId);
  await stopSubagentTailer(current).catch(() => {});
  const done = Math.max(0, total - pendingCount);
  const stallText = `I finished ${done} of ${total} planned pieces, but ${pendingCount} ${pendingCount === 1 ? 'is' : 'are'} still unfinished. Say "continue" and I'll pick the rest back up.`;
  broadcast(current, { type: 'message', role: 'assistant', content: stallText, ts: new Date().toISOString() });
  await current.session?.recordMessage('assistant', stallText).catch(() => {});
  await transitionState(current, 'error');
  broadcast(current, { type: 'status', working: false });
  if (current.queue.length > 0) {
    const next = current.queue.shift();
    broadcast(current, { type: 'queue_updated', queuedIds: current.queue.map((q) => q.id) });
    current.busy = true;
    processMessage(current, next.content).catch(() => { current.busy = false; });
  }
}

// Driver state survives the AUTO_CONTINUE escalation cycle (clearBgDriver →
// resume turn → startBgDriver): it lives on the runtime, not in the closure,
// so noProgress keeps climbing toward the give-up threshold across restarts.
// Reset only by a real user message (processMessage non-auto) or a wave end.
export function ensureBgDriverState(runtime) {
  const state = runtime.bgDriverState ??= {
    prevSig: null, noProgress: 0, resumed: false, escalations: 0,
    seenBgCount: runtime.bgResultCount || 0, drainQuiet: 0,
    prevDrainSig: null, drainSince: null,
  };
  state.resumed = false;          // each (re)start allows one new escalation
  state.timer = null;
  state.ticking = false;          // re-entrance guard for the async heartbeat tick
  return state;
}

// Start (or restart) the heartbeat that nudges the idle PTY so background turns
// fire. Reads ticket statuses each tick: all terminal → finish; otherwise nudge
// and track no-progress for stall escalation.
export function startBgDriver(runtime, runtimes) {
  const sessionId = runtime.session?.id;
  if (!sessionId) return;
  clearBgDriver(sessionId);
  const sDir = `${LOG_DIR}/${sessionId}`;
  const state = ensureBgDriverState(runtime);
  driverLog(`heartbeat started session=${sessionId}`);

  // Re-entrance guard: a tick can outlast HEARTBEAT_MS (the settle paths flush
  // usage + snapshot transcripts). Overlapping ticks would double-settle the
  // wave — two queue.shift()s and two concurrent turns on the same PTY.
  const tick = async () => {
    const current = runtimes.get(sessionId);
    // Stop the heartbeat if the runtime is gone, an active turn is running, or
    // the PTY has died (a fresh PTY's exit handler / next turn re-arms it).
    if (!current) { clearBgDriver(sessionId); return; }
    if (current.busy) return;
    if (current.pendingRateLimit) {
      // A subagent transcript reported a blocked limit (subagent-tail.js →
      // noteRateLimit). currentProc is null while idle, so the kill no-oped —
      // settle here instead of nudging a blocked TUI for 6 minutes.
      const info = current.pendingRateLimit;
      current.pendingRateLimit = null;
      settleBackgroundRateLimit(current, info).catch(() => {});
      return;
    }
    if (!current.ptySession || current.ptySession.closed) {
      // A restart-once may still be scheduled (PTY exit handler) — give it a
      // chance to respawn and re-arm the wave before declaring it dead.
      if (current.ptyRestartPending) return;
      driverLog(`heartbeat stop: PTY gone session=${sessionId}`);
      // PTY dead with no restart coming: the wave cannot advance. Without an
      // explicit settle the session stays in_progress with a live progress bar
      // forever (reconcileWaveState refuses to clear while tickets are pending).
      const { total, pendingCount } = await readTicketStatuses(sDir)
        .catch(() => ({ total: 0, pendingCount: 0 }));
      if (total > 0 && pendingCount > 0) {
        await settleStalledWave(current, sessionId, { total, pendingCount });
      } else {
        current.waveActive = false;
        current.bgDriverState = null;
        clearBgDriver(sessionId);
        await stopSubagentTailer(current).catch(() => {});
        await transitionState(current, 'completed');
        broadcast(current, { type: 'status', working: false });
      }
      return;
    }

    const { total, pendingCount, pendingSig } = await readTicketStatuses(sDir);
    if (total === 0) { current.waveActive = false; current.bgDriverState = null; clearBgDriver(sessionId); return; }          // not a COMPLEX wave

    const bgCount = current.bgResultCount || 0;

    if (pendingCount === 0) {
      // All tickets merged, but promotion (session→main) and any follow-up still
      // run as background turns. Stay in_progress (bar visible) and keep nudging
      // until the orchestrator goes quiet — only then settle, so the final recap
      // message reaches chat first. CRITICAL: "quiet" is REAL new output (a late
      // merge changing pendingSig, or new assistant text via sawBgProgressSinceTick),
      // NOT bgResultCount — the nudge below makes the idle TUI emit an empty
      // background_result every tick, which used to reset the counter forever so
      // the wave never settled (P0: waveActive stuck true, every future message
      // queued and never drained).
      if (state.drainSince == null) state.drainSince = Date.now();
      const dec = shouldSettleDrain(state, {
        pendingSig,
        sawProgress: !!current.sawBgProgressSinceTick,
        nowMs: Date.now(),
      });
      state.drainQuiet = dec.drainQuiet;
      state.prevDrainSig = dec.prevDrainSig;
      current.sawBgProgressSinceTick = false;   // consume the per-tick progress flag
      if (dec.settle) {
        driverLog(`heartbeat done: drain settling (${dec.reason}) session=${sessionId}`);
        if (dec.reason === 'cap') driverLog(`heartbeat drain: wall-clock cap, settling session=${sessionId}`);
        await settleDrainedWave(current, sessionId);
        return;
      }
      driverLog(`heartbeat drain: quiet=${state.drainQuiet} session=${sessionId}`);
      current.ptySession.nudge();
      return;
    }

    // Progress = either the pending-ticket set changed (a merge landed) OR a
    // background turn fired since the last tick (reviewer/merger completion the
    // orchestrator reacted to). Ticket status alone stays `pending` through the
    // whole dev→review→merge chain, so without the background_result signal a
    // healthy single-ticket wave would look stalled and trigger a needless resume.
    const madeProgress = pendingSig !== state.prevSig || bgCount !== state.seenBgCount;
    if (madeProgress) { state.noProgress = 0; state.resumed = false; }
    else state.noProgress += 1;
    state.prevSig = pendingSig;
    state.seenBgCount = bgCount;

    if (state.noProgress >= HEARTBEAT_GIVEUP_TICKS) {
      // Genuinely stuck — surface the stall once and stop nudging.
      driverLog(`heartbeat give-up: stall ${state.noProgress} ticks pending=${pendingCount} session=${sessionId}`);
      await settleStalledWave(current, sessionId, { total, pendingCount });
      return;
    }

    if (state.noProgress >= HEARTBEAT_STALL_TICKS && !state.resumed
        && state.escalations < MAX_BG_ESCALATIONS) {
      // Nudges alone haven't advanced the wave — escalate once to a heavyweight
      // resume that re-states the STATE B instructions, then keep nudging.
      // The escalation clears + restarts the driver, but bgDriverState survives
      // (it lives on the runtime), so noProgress keeps climbing and escalations
      // is capped — after MAX_BG_ESCALATIONS this branch falls through to the
      // give-up threshold instead of resuming forever.
      driverLog(`heartbeat escalate: AUTO_CONTINUE after ${state.noProgress} ticks (escalation ${state.escalations + 1}/${MAX_BG_ESCALATIONS}) pending=${pendingCount} session=${sessionId}`);
      state.resumed = true;
      state.escalations += 1;
      current.busy = true;
      processMessage(current, AUTO_CONTINUE_NUDGE, { auto: true })
        .catch(() => { current.busy = false; });
      return;
    }

    // Normal tick: poke the idle TUI so it delivers pending background-agent
    // completions and runs its Step 2 background turn.
    driverLog(`heartbeat nudge: noProgress=${state.noProgress} pending=${pendingCount} session=${sessionId}`);
    current.ptySession.nudge();
  };

  state.timer = setInterval(() => {
    if (state.ticking) return;
    state.ticking = true;
    tick()
      .catch((e) => driverLog(`heartbeat tick error: ${e?.message || e} session=${sessionId}`))
      .finally(() => { state.ticking = false; });
  }, HEARTBEAT_MS);

  bgDrivers.set(sessionId, { timer: state.timer });
}

// Settle the session on `rate_limited` from an idle (background-turn) context.
// Mirrors the active-loop path: record + broadcast the friendly message, the
// rate_limited frame with resetsAt, persist resetsAt, stop driving the wave.
export async function settleBackgroundRateLimit(runtime, info) {
  if (runtime.bgRateLimitSettling) return;          // idempotent (main + subagent may both fire)
  runtime.bgRateLimitSettling = true;
  runtime.waveActive = false;
  runtime.bgDriverState = null;
  clearBgDriver(runtime.session?.id);
  runtime.suppressNextPtyRestart = true;            // stop the exit handler respawning the settled session
  try { runtime.ptySession?.kill(); } catch {}      // the CLI hangs on a blocked limit
  runtime.ptySession = null;
  await stopSubagentTailer(runtime).catch(() => {});
  const errText = friendlyError({ rateLimit: info });
  broadcast(runtime, { type: 'message', role: 'assistant', content: errText, ts: new Date().toISOString() });
  await runtime.session?.recordMessage('assistant', errText).catch(() => {});
  const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null;
  broadcast(runtime, { type: 'rate_limited', resetsAt });
  await runtime.session?.setRateLimitResetsAt(resetsAt).catch(() => {});
  await transitionState(runtime, 'rate_limited');
  broadcast(runtime, { type: 'status', working: false });
  // NB: leave bgRateLimitSettling set — a rate_limited settle is terminal for
  // this turn. processMessage resets it at the next turn entry so a future wave
  // can settle a fresh limit (mirrors how tearingDown is cleared).
}

// True while a heartbeat driver is armed for this session (turn.js re-arm guard).
export function hasBgDriver(sessionId) {
  return bgDrivers.has(sessionId);
}
