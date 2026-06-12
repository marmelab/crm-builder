import { on } from 'node:events';
import { cp, copyFile, mkdir, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_DIR, claudeProjectDir, claudeSessionDir } from './config.js';
import { broadcast, sendStats } from './ws-bus.js';
import { runtimes, transitionState, noteRateLimit, cancelIdleTeardown } from './runtime.js';
import { rewriteUserMessage, extractText, extractToolUses, friendlyError } from './turn-helpers.js';
import { PtySession } from './pty-session.js';
import { endsWithQuestion } from './session-store.js';
import { decideNextState, turnFailedFrom, classifyTurn } from './turn-state.js';
import { startSubagentTailer, stopSubagentTailer } from './subagent-tail.js';
import {
  emptyBreakdown, addBreakdown, breakdownFromModelUsage, costFromBreakdown,
} from '../stats/io.js';
import { updateProgressBar, predictedFlowExpected, flowExpectedForTickets } from './progress-bar.ts';
import {
  readTicketStatuses, AUTO_CONTINUE_NUDGE,
} from './auto-continue.js';
import { loadTicketsAndWaves } from '../stats/tickets.js';

const AGENT_DISPATCH_TOOLS = new Set(['Agent', 'Task']);

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

function parseResetsAtFromText(text) {
  const m = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b.*?\butc\b/i.exec(text || '');
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, min, 0, 0));
  if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
  return Math.floor(reset.getTime() / 1000);
}

// Temporary instrumentation for the noAgentTeam PTY background-turn driver.
// Writes to chat-err.log (supervisor stderr). Remove once the driver is proven.
function driverLog(msg) {
  try { console.error(`[bg-driver ${new Date().toISOString()}] ${msg}`); } catch {}
}

// ── Background-turn driver ───────────────────────────────────────────────────
// Per-session heartbeat timers + state, keyed by session id.
const bgDrivers = new Map();

function clearBgDriver(sessionId) {
  const d = bgDrivers.get(sessionId);
  if (d) { clearInterval(d.timer); bgDrivers.delete(sessionId); }
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

// Start (or restart) the heartbeat that nudges the idle PTY so background turns
// fire. Reads ticket statuses each tick: all terminal → finish; otherwise nudge
// and track no-progress for stall escalation.
// Fold the just-finished spawn's `*CurrentSpawn` usage into the cumulative
// session stats, then reset the per-spawn accumulators. Run identically by the
// active-turn `finally` and by the background drain-completed branch, so both
// paths produce the same downstream stats shape.
// Replace the runtime's cumulative stats with the watcher's session-cumulative
// DEDUPED-by-message.id usage (camelCase modelUsage). This is the live single
// source of truth: it converges to the same per-message-id-deduped figure
// /api/stats reports, instead of summing per-spawn deltas (which double-count).
// Zeroes the *CurrentSpawn accumulators so sendStats (which adds them) reports
// exactly the cumulative. No-op when the watcher has no usage yet (keeps the
// digest-seeded values from runtime init). Exported for unit tests.
export function applyCumulativeUsage(runtime, modelUsage) {
  if (!modelUsage || Object.keys(modelUsage).length === 0) return;
  let breakdown = emptyBreakdown();
  let costUsd = 0;
  const byModel = [];
  for (const [model, mu] of Object.entries(modelUsage)) {
    const b = {
      input:       mu?.inputTokens               || 0,
      cacheCreate: mu?.cacheCreationInputTokens  || 0,
      output:      mu?.outputTokens              || 0,
      cacheRead:   mu?.cacheReadInputTokens      || 0,
    };
    breakdown = addBreakdown(breakdown, b);
    const c = costFromBreakdown(model, b);
    costUsd += c;
    byModel.push({ model, breakdown: b, costUsd: c });
  }
  byModel.sort((a, b) => b.costUsd - a.costUsd);
  runtime.stats.tokensBreakdown = breakdown;
  runtime.stats.tokensUsed = breakdown.input + breakdown.cacheCreate + breakdown.output;
  runtime.stats.tokensByModel = byModel;
  runtime.stats.costUsd = costUsd;
  // The cumulative already includes the in-flight spawn — clear the per-spawn
  // accumulators so sendStats doesn't add them on top.
  runtime.stats.tokensBreakdownCurrentSpawn = emptyBreakdown();
  runtime.stats.tokensByModelCurrentSpawn = new Map();
  runtime.stats.costUsdCurrentSpawn = 0;
}

function foldSpawnUsageIntoStats(runtime) {
  runtime.stats.costUsd += runtime.stats.costUsdCurrentSpawn;
  runtime.stats.costUsdCurrentSpawn = 0;
  runtime.stats.tokensBreakdown = addBreakdown(
    runtime.stats.tokensBreakdown,
    runtime.stats.tokensBreakdownCurrentSpawn,
  );
  const bk = runtime.stats.tokensBreakdown;
  runtime.stats.tokensUsed = bk.input + bk.cacheCreate + bk.output;
  runtime.stats.tokensBreakdownCurrentSpawn = emptyBreakdown();
  const byModelIdx = new Map(runtime.stats.tokensByModel.map((r) => [r.model, r]));
  for (const [model, mb] of runtime.stats.tokensByModelCurrentSpawn) {
    const prev = byModelIdx.get(model);
    const mergedBreakdown = prev
      ? addBreakdown(prev.breakdown, mb.breakdown)
      : { ...mb.breakdown };
    const addCost = mb.costUsd != null ? mb.costUsd : costFromBreakdown(model, mb.breakdown);
    const mergedCost = (prev?.costUsd || 0) + addCost;
    if (prev) { prev.breakdown = mergedBreakdown; prev.costUsd = mergedCost; }
    else byModelIdx.set(model, { model, breakdown: mergedBreakdown, costUsd: mergedCost });
  }
  runtime.stats.tokensByModel = [...byModelIdx.values()].sort((a, b) => b.costUsd - a.costUsd);
  runtime.stats.tokensByModelCurrentSpawn = new Map();
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

function startBgDriver(runtime, runtimes) {
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
async function settleBackgroundRateLimit(runtime, info) {
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

// Shared per-event stats accounting, run identically by the active-turn loop and
// by the background listener so the progress bar advances during background
// turns. ctx carries the sessionDir; correlation maps live on the runtime.
async function processStatsEvent(runtime, event, sessionDir) {
  let dispatchedThisEvent = false;
  for (const tool of extractToolUses(event)) {
    const alreadySeen = runtime.toolMap.has(tool.id);
    runtime.toolMap.set(tool.id, tool);
    if (alreadySeen) continue;
    if (AGENT_DISPATCH_TOOLS.has(tool.name) && tool.input?.subagent_type) {
      if (runtime.stats.dispatchedSubagentTypes.length === 0) {
        runtime.stats.flowExpected = predictedFlowExpected(tool.input.subagent_type);
      }
      runtime.stats.dispatchedSubagentTypes.push(tool.input.subagent_type);
      dispatchedThisEvent = true;
      if (event.parent_tool_use_id == null && tool.input?.prompt) {
        emitDispatchPromptEvent(runtime, tool);
      }
    }
  }
  if (dispatchedThisEvent) updateProgressBar(runtime);

  if (event.type === 'system') {
    const isAgentTaskType =
      event.task_type === 'local_agent' || event.task_type === 'in_process_teammate';
    if (event.subtype === 'task_started' && isAgentTaskType && event.task_id) {
      runtime.stats.activeAgentIds.add(event.task_id);
      runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
      const role = runtime.toolMap.get(event.tool_use_id)?.input?.subagent_type;
      if (role) runtime.taskRole.set(event.task_id, role);
      sendStats(runtime);
    } else if (event.subtype === 'task_notification' && event.status === 'completed' && event.task_id && runtime.stats.activeAgentIds.has(event.task_id)) {
      runtime.stats.activeAgentIds.delete(event.task_id);
      runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
      runtime.stats.agentsCompleted++;
      const doneRole = runtime.taskRole.get(event.task_id);
      if (doneRole) runtime.stats.completedByRole[doneRole] = (runtime.stats.completedByRole[doneRole] || 0) + 1;
      if (runtime.stats.agentsCompleted === 1
          && runtime.stats.dispatchedSubagentTypes[0] === 'planner') {
        const result = await loadTicketsAndWaves(sessionDir);
        if (result && result.tickets.length > 0) {
          runtime.stats.flowExpected = flowExpectedForTickets(result.tickets.length, result.waves.length);
          runtime.stats.waveSizes = result.waves.map((w) => w.length);
        }
      }
      sendStats(runtime);
      updateProgressBar(runtime);
    }
  }
}

function emitDispatchPromptEvent(runtime, tool) {
  const target = tool.input.name || tool.input.subagent_type;
  broadcast(runtime, {
    type: 'debug',
    tool: 'agent_output',
    input: { agent: `→ ${target}`, text: tool.input.prompt },
    agent: 'orchestrator',
  });
}

// Yields events from the PtySession until a `result` event arrives or the
// session exits. Aborted on exit so the for-await loop terminates cleanly.
async function* ptyEventsUntilResult(session) {
  const ac = new AbortController();
  const onExit = () => ac.abort();
  session.once('exit', onExit);
  try {
    for await (const [event] of on(session, 'event', { signal: ac.signal })) {
      yield event;
      if (event.type === 'result') { ac.abort(); return; }
    }
  } catch (e) {
    if (e?.name !== 'AbortError') throw e;
  } finally {
    session.off('exit', onExit);
  }
}

// In PTY interactive mode, mode and session_dir are injected via
// --append-system-prompt at PtySession spawn time. We send only the plain
// message — embedding XML tags in the user message confuses the TUI.
function buildPrompt(userMessage) {
  return rewriteUserMessage(userMessage).trim();
}

// The orchestrator titles the session itself: it prepends a
// <session-title>…</session-title> tag to its first reply (chat-orchestrator.md).
// We strip the tag from the user-visible message (always — it must never render)
// and apply the title once, unless the user has manually renamed (titleLocked).
// This replaces the separate `claude -p` Haiku retitling spawn.
const SESSION_TITLE_RE = /<session-title>\s*([\s\S]*?)\s*<\/session-title>/i;
function applyAndStripSessionTitle(runtime, text) {
  if (!text || !SESSION_TITLE_RE.test(text)) return text;
  const m = SESSION_TITLE_RE.exec(text);
  const stripped = text.replace(SESSION_TITLE_RE, '').trim();
  const meta = runtime.session?.meta;
  const title = (m[1] || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'`«»]+|["'`«»]+$/g, '')
    .trim()
    .slice(0, 100);
  if (title && meta && !meta.titleLocked) {
    runtime.session.setTitle(title, { auto: true }).catch(() => {});
    broadcast(runtime, { type: 'title', title });
  }
  return stripped;
}

// POST-DEV satisfaction widget. The orchestrator embeds a
// %%ASK_SATISFACTION|<header>|<body>|<yes>|<no>%% marker (all fields optional) in
// its end-of-flow text; we strip it from the visible message (always) and emit a
// `satisfaction_ask` widget once per request. In the PTY flow POST-DEV runs as a
// background turn, so this is applied in BOTH the active loop and the bg listener.
// Lazy match up to the closing %%: fields may contain single % and any text
// except newlines; extra '|' beyond the 4th field folds into `no`. Known residual
// limitation: a literal `%%` inside a field still terminates the match early.
const SATISFACTION_RE = /\n?%%ASK_SATISFACTION(\|[^\n]*?)?%%\n?/;

// Exported for unit tests.
export function parseSatisfactionMarker(text) {
  if (!text) return null;
  const m = text.match(SATISFACTION_RE);
  if (!m) return null;
  const cleanText = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  const fields = m[1] ? m[1].slice(1).split('|') : [];
  const [header, body, yes, ...rest] = fields;
  return {
    cleanText,
    payload: {
      header: header?.trim() || undefined,
      body:   body?.trim() || undefined,
      yes:    yes?.trim() || 'Yes, save the changes',
      no:     rest.join('|').trim() || 'No, I want to change something',
    },
  };
}

function applyAndStripSatisfactionAsk(runtime, text) {
  const parsed = parseSatisfactionMarker(text);
  if (!parsed) return text;
  if (!runtime.satisfactionAskSent) {
    runtime.satisfactionAskSent = true;
    broadcast(runtime, { type: 'satisfaction_ask', ...parsed.payload });
    runtime.session?.setSatisfactionAsk(parsed.payload).catch(() => {});
  }
  return parsed.cleanText;
}

// Shared text pipeline for the active-turn loop and the background listener:
// title strip → satisfaction strip → dedup-vs-last → broadcast + recordMessage.
// Any future %%…%% marker stripped here lands in both paths by construction.
// `ctx.lastText` carries each path's own dedup state (mutated in place — keep a
// separate ctx per path so dedup state is never shared). Returns true whenever a
// non-empty assistant text was produced (even if it was a duplicate and thus not
// re-broadcast), matching the active loop's `receivedText` semantics.
// debug_raw and processStatsEvent stay at the call sites: their order relative to
// this text step differs between the two paths (active runs stats after text,
// background before) and must be preserved.
function handleOrchestratorText(runtime, event, ctx) {
  let text = applyAndStripSessionTitle(runtime, extractText(event));
  text = applyAndStripSatisfactionAsk(runtime, text);
  if (!text) return false;
  const isDuplicate = text.trim() === ctx.lastText.trim();
  ctx.lastText = text;
  if (!isDuplicate) {
    broadcast(runtime, { type: 'message', role: 'assistant', content: text, ts: new Date().toISOString() });
    runtime.session?.recordMessage('assistant', text).catch(() => {});
  }
  return true;
}

export async function processMessage(runtime, prompt, opts = {}) {
  if (!runtime) return;
  const isAutoContinue = opts.auto === true;

  driverLog(`processMessage enter auto=${isAutoContinue} session=${runtime.session?.id} ptyAlive=${!!runtime.ptySession && !runtime.ptySession.closed}`);
  runtime.tearingDown = false;
  runtime.bgRateLimitSettling = false;
  cancelIdleTeardown(runtime);
  if (runtime.session?.id) {
    clearBgDriver(runtime.session.id);
    if (!isAutoContinue) {
      // A real user turn takes over the session — any background wave is now moot.
      runtime.waveActive = false;
      runtime.bgDriverState = null;   // fresh user turn resets the give-up counters
      // Fresh user turn — drop stale dispatch/task correlation from a prior request.
      runtime.toolMap.clear();
      runtime.taskRole.clear();
      // Allow one satisfaction widget per request (POST-DEV asks once).
      runtime.satisfactionAskSent = false;
    }
  }

  if (opts.freshSession) {
    // Recovery: spawn a brand-new conversation. The live PTY (if any) holds the
    // dead "wave is running" transcript — kill it and drop the CSID so the next
    // PtySession spawns WITHOUT --resume. STATE RECOVERY rebuilds from disk.
    runtime.claudeSessionId = null;
    runtime.session?.setClaudeSessionId(null).catch(() => {});
    if (runtime.ptySession && !runtime.ptySession.closed) {
      runtime.suppressNextPtyRestart = true;
      runtime.ptySession.kill();
      runtime.ptySession = null;
    }
  }

  // Always reset per-turn live state (active agents, animation anchor).
  // Cumulative progress state (which agents ran, wave topology) is preserved
  // across auto-continue turns so the progress bar doesn't reset mid-COMPLEX.
  runtime.stats = {
    ...runtime.stats,
    ...(isAutoContinue ? {} : {
      agentsCompleted: 0,
      completedByRole: {},
      flowExpected: 0,
      dispatchedSubagentTypes: [],
      waveSizes: null,
    }),
    inProgressSince: Date.now(),
    lastInProgressRole: null,
    activeAgentIds: new Set(),
    activeAgents: 0,
    durationScale: 1,
  };
  updateProgressBar(runtime);

  transitionState(runtime, 'in_progress');
  broadcast(runtime, { type: 'status', working: true });
  runtime.pendingRateLimit = null;

  let receivedText = false;
  let rateLimit = null;
  let resultError = false;
  const activeCtx = { lastText: '' };
  let sawResult = false;
  let resultReason = 'sentinel';

  const sessionDir = `${LOG_DIR}/${runtime.session.id}`;

  // ── PTY lifecycle ──────────────────────────────────────────────────────────
  // attachBgListener: forwards background orchestrator turns (fired when a
  // run_in_background subagent completes) to WS clients while the session is
  // idle (no active processMessage). No InboxPoller watchdog needed: noAgentTeam
  // uses Agent({run_in_background:true}) — no team inbox to poll.
  function attachBgListener(ptyRef) {
    if (ptyRef._bgAttached) return;
    ptyRef._bgAttached = true;
    const bgCtx = { lastText: '' };

    const bgHandler = (event) => {
      // While an active turn is running, ptyEventsUntilResult owns the events —
      // skip here to avoid double-processing.
      if (runtime.busy) return;
      if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'blocked') {
        noteRateLimit(runtime, event.rate_limit_info);
        settleBackgroundRateLimit(runtime, event.rate_limit_info).catch(() => {});
        return;
      }
      if (event.type === 'assistant' && event.error === 'rate_limit') {
        const txt = event.message?.content?.find?.((b) => b?.type === 'text')?.text || '';
        const info = { resetsAt: parseResetsAtFromText(txt), message: txt || null };
        noteRateLimit(runtime, info);
        settleBackgroundRateLimit(runtime, info).catch(() => {});
        return;
      }
      if (event.type === 'background_result') driverLog(`background_result received (idle) session=${runtime.session?.id}`);
      broadcast(runtime, { type: 'debug_raw', event });
      // Advance progress/stats from this background turn's events, identical to
      // the active-turn loop, so the bar keeps moving between user turns.
      processStatsEvent(runtime, event, sessionDir).catch(() => {});
      // Real new assistant text = honest drain-quiet progress. A nudge-induced
      // empty background_result returns false here, so it never resets the quiet
      // counter (that was the infinite-drain bug).
      if (handleOrchestratorText(runtime, event, bgCtx)) runtime.sawBgProgressSinceTick = true;
      if (event.type === 'background_result') {
        // Count background turns so the heartbeat treats them as progress and
        // doesn't escalate to a heavyweight resume while the wave is advancing.
        runtime.bgResultCount = (runtime.bgResultCount || 0) + 1;
        updateProgressBar(runtime);
        // Refresh the cumulative deduped total so the header advances during
        // background turns (most COMPLEX work runs here). Async; sendStats fires
        // both immediately and after the apply so the header never stalls.
        sendStats(runtime);
        runtime.ptySession?.cumulativeUsage?.()
          .then((cum) => { if (cum && Object.keys(cum).length > 0) { applyCumulativeUsage(runtime, cum); sendStats(runtime); } })
          .catch(() => {});
        // Snapshot subagent transcripts now: most COMPLEX work (dev, reviewers,
        // merger) runs in background turns, and snapshotClaudeSession otherwise
        // only fires at active-turn end — so without this, /api/stats would miss
        // every agent that ran since the last user turn.
        // Throttled: at most one snapshot per 30 s to avoid hammering the FS on
        // high-frequency waves; the unconditional drain-completed snapshot below
        // always captures the final state.
        const _bgNow = Date.now();
        if (!runtime.lastBgSnapshotAt || _bgNow - runtime.lastBgSnapshotAt > 30_000) {
          runtime.lastBgSnapshotAt = _bgNow;
          snapshotClaudeSession(runtime.claudeSessionId, runtime.session?.id).catch(() => {});
        }
      }
    };
    ptyRef.on('event', bgHandler);
    ptyRef.once('exit', () => {
      ptyRef.off('event', bgHandler);
      ptyRef._bgAttached = false;
    });
  }

  function spawnOrResumePty() {
    runtime.subagentUsageLines ??= new Map();   // survives PTY restarts → no double-count
    // Session-cumulative deduped-by-message.id usage + its seen-id guard. Owned
    // by the runtime so they survive PTY restarts (a fresh watcher keeps the
    // running cumulative, never resets it mid-wave). This is the live source of
    // truth: sendStats reports it so the header matches /api/stats.
    runtime.cumulativeUsage ??= new Map();
    runtime.seenMsgIds ??= new Set();
    runtime.ptySession = new PtySession(runtime.claudeSessionId, sessionDir, {
      subagentUsageLines: runtime.subagentUsageLines,
      cumulativeUsage: runtime.cumulativeUsage,
      seenMsgIds: runtime.seenMsgIds,
    });
    attachBgListener(runtime.ptySession);
    if (runtime.claudeSessionId) {
      startSubagentTailer(runtime).catch((e) => console.error('[subagent-tail]', e));
      // If the PTY was respawned mid-wave (crash/OOM restart-once) while no active
      // turn is running, the resumed orchestrator TUI is idle and nothing nudges
      // it — re-arm the heartbeat. Key on durable disk ticket state (total>0 &&
      // pendingCount>0), NOT the in-memory waveActive flag (a "PTY gone" heartbeat
      // tick may already have cleared it before this restart fires). Skip when an
      // active turn is about to run (busy) — its own `finally` arms the driver —
      // and when the driver is already armed. A brand-new session has no resumed
      // claudeSessionId yet, so this block never runs on its first spawn; even if
      // it did, total===0 (no tickets) would fail the guard.
      if (!runtime.busy && !bgDrivers.has(runtime.session?.id)) {
        readTicketStatuses(`${LOG_DIR}/${runtime.session.id}`)
          .then(({ total, pendingCount }) => {
            if (total > 0 && pendingCount > 0 && !runtime.busy && !bgDrivers.has(runtime.session?.id)) {
              runtime.waveActive = true;
              startBgDriver(runtime, runtimes);
            }
          })
          .catch(() => {});
      }
    }

    runtime.ptySession.once('exit', () => {
      if (runtime.tearingDown || runtime.suppressNextPtyRestart) {
        runtime.suppressNextPtyRestart = false;
        runtime.ptySession = null;
        return;
      }
      runtime.ptySession = null;
      const restartCount = runtime.ptyRestartCount || 0;
      if (!runtime.busy && restartCount < 1) {
        // Schedule one restart to drain pending background turns (wave
        // transitions, merge confirmations) that arrived after the active turn.
        runtime.ptyRestartCount = restartCount + 1;
        runtime.ptyRestartPending = true;
        setTimeout(() => {
          runtime.ptyRestartPending = false;
          if (!runtime.ptySession && !runtime.busy) {
            spawnOrResumePty();
          } else if (runtime.clients.size === 0 && !runtime.busy && (!runtime.ptySession || runtime.ptySession.closed)) {
            runtime.session?.close();
            runtimes.delete(runtime.session.id);
          }
        }, 5000);
      } else if (runtime.clients.size === 0 && !runtime.busy) {
        runtime.session?.close();
        runtimes.delete(runtime.session.id);
      }
    });
  }

  runtime.ptyRestartCount = 0;

  const spawnedWithResume = !!runtime.claudeSessionId;
  let staleRetry = false;

  try {
    // Inside the try: node-pty's spawn can throw synchronously (e.g. ENOMEM,
    // missing binary) and send() writes to the fresh PTY — an unguarded throw
    // here would skip the finally and leave runtime.busy=true forever.
    if (!runtime.ptySession || runtime.ptySession.closed) {
      spawnOrResumePty();
    } else {
      attachBgListener(runtime.ptySession);
    }

    runtime.ptySession.send(buildPrompt(prompt));
    // The session_id discovery event only fires once per brand-new conversation;
    // resumed sessions and turn 2+ must (re)start the tailer themselves. The call
    // is idempotent, so this is safe when it is already running.
    if (runtime.claudeSessionId) {
      startSubagentTailer(runtime).catch((e) => console.error('[subagent-tail]', e));
    }
    runtime.currentProc = { kill: () => runtime.ptySession?.kill() };

    for await (const event of ptyEventsUntilResult(runtime.ptySession)) {
      if (event.session_id) {
        runtime.claudeSessionId = event.session_id;
        runtime.session?.setClaudeSessionId(event.session_id).catch(() => {});
        startSubagentTailer(runtime).catch((e) => console.error('[subagent-tail]', e));
      }

      broadcast(runtime, { type: 'debug_raw', event });

      receivedText = handleOrchestratorText(runtime, event, activeCtx) || receivedText;

      await processStatsEvent(runtime, event, sessionDir);

      if (!rateLimit && event.type === 'assistant' && event.error === 'rate_limit') {
        const txt = event.message?.content?.find?.((b) => b?.type === 'text')?.text || '';
        rateLimit = { resetsAt: parseResetsAtFromText(txt), message: txt || null };
        noteRateLimit(runtime, rateLimit);
      }

      if (!rateLimit && event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'blocked') {
        rateLimit = event.rate_limit_info;
        noteRateLimit(runtime, rateLimit);
      }

      if (event.type === 'result') {
        sawResult = true;
        resultReason = event.reason || 'sentinel';
        driverLog(`result seen receivedText=${receivedText} reason=${resultReason} session=${runtime.session?.id}`);
        if (event.is_error) resultError = true;
        if (event.modelUsage && Object.keys(event.modelUsage).length > 0) {
          runtime.stats.tokensBreakdownCurrentSpawn = breakdownFromModelUsage(event.modelUsage);
          runtime.stats.tokensByModelCurrentSpawn = new Map();
          for (const [model, mu] of Object.entries(event.modelUsage)) {
            runtime.stats.tokensByModelCurrentSpawn.set(model, {
              breakdown: {
                input:       mu?.inputTokens               || 0,
                cacheCreate: mu?.cacheCreationInputTokens  || 0,
                output:      mu?.outputTokens              || 0,
                cacheRead:   mu?.cacheReadInputTokens      || 0,
              },
              costUsd: typeof mu?.costUSD === 'number' ? mu.costUSD : null,
            });
          }
        }
        runtime.stats.costUsdCurrentSpawn = event.total_cost_usd || 0;
        runtime.stats.activeAgents = 0;
        runtime.stats.activeAgentIds.clear();
        sendStats(runtime);
      }
    }

    if (!rateLimit && runtime.pendingRateLimit) rateLimit = runtime.pendingRateLimit;

    const exitCode = sawResult ? 0 : 1;
    const stderr = runtime.ptySession?.stderr ?? '';

    // `claude --resume <missing-id>` exits almost immediately with no transcript
    // events: no result, no text, PTY dead. Drop the stale id and replay the
    // turn once on a fresh conversation instead of surfacing a dead-end error.
    staleRetry = !sawResult && !receivedText && spawnedWithResume
      && !runtime.stopping && !rateLimit
      && (!runtime.ptySession || runtime.ptySession.closed)
      && !opts.staleRetried;

    if (runtime.stopping) {
      const stopText = '⏹ Session stopped.';
      broadcast(runtime, { type: 'message', role: 'assistant', content: stopText, ts: new Date().toISOString() });
      await runtime.session?.recordMessage('assistant', stopText).catch(() => {});
    // Stays turnFailedFrom (not classifyTurn): the `|| !receivedText` term here
    // already subsumes classifyTurn's silence-no-text rule, so converting would
    // be redundant. Only the settle-decision in the `finally` uses classifyTurn.
    } else if (!staleRetry && (turnFailedFrom({ resultError, sawResult }) || !receivedText || rateLimit)) {
      const errText = friendlyError({ exitCode, stderr, rateLimit, resultError });
      broadcast(runtime, { type: 'message', role: 'assistant', content: errText, ts: new Date().toISOString() });
      await runtime.session?.recordMessage('assistant', errText).catch(() => {});
      if (rateLimit) {
        const resetsAt = typeof rateLimit.resetsAt === 'number' ? rateLimit.resetsAt : null;
        broadcast(runtime, { type: 'rate_limited', resetsAt });
        await runtime.session?.setRateLimitResetsAt(resetsAt).catch(() => {});
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      const errText = "Something went wrong. Want to try again?";
      broadcast(runtime, { type: 'message', role: 'assistant', content: errText, ts: new Date().toISOString() });
      await runtime.session?.recordMessage('assistant', errText).catch(() => {});
    }
  } finally {
    // NB: the subagent tailer is NOT stopped here. The COMPLEX flow runs as
    // background turns between active processMessage calls, and the tailer must
    // keep polling across them so background-turn subagent activity (mergers,
    // reviewers) still reaches the live feed. It is stopped only when the wave
    // truly settles (below / in the bg driver) or on teardown.

    // Replace cumulative stats with the watcher's session-cumulative DEDUPED
    // total (the live source of truth). Falls back to the additive per-spawn
    // fold if the watcher reported nothing (e.g. a turn with no transcript
    // usage) so the header never regresses to zero.
    try {
      const cum = await runtime.ptySession?.cumulativeUsage?.();
      if (cum && Object.keys(cum).length > 0) applyCumulativeUsage(runtime, cum);
      else foldSpawnUsageIntoStats(runtime);
    } catch { foldSpawnUsageIntoStats(runtime); }
    runtime.currentProc = null;
    sendStats(runtime);

    const wasStopped = !!runtime.stopping;
    runtime.stopping = false;

    if (staleRetry) {
      runtime.claudeSessionId = null;
      runtime.session?.setClaudeSessionId(null).catch(() => {});
      runtime.busy = true;
      processMessage(runtime, prompt, { ...opts, staleRetried: true }).catch(() => { runtime.busy = false; });
    } else if (!wasStopped && !rateLimit && runtime.queue.length > 0) {
      broadcast(runtime, { type: 'status', working: false });
      const next = runtime.queue.shift();
      broadcast(runtime, { type: 'queue_updated', queuedIds: runtime.queue.map((q) => q.id) });
      processMessage(runtime, next.content).catch(() => { runtime.busy = false; });
    } else {
      if (wasStopped || rateLimit) runtime.queue = [];
      runtime.busy = false;

      // classifyTurn = turnFailedFrom + the silence-no-text rule: a result that
      // arrived via the 120 s fallback (no Stop sentinel) and produced no text
      // is a failure (the orchestrator died/hung). A silence result WITH text
      // stays 'completed' (long COMPLEX turns may legitimately miss the sentinel).
      const turnFailed = classifyTurn({ resultError, sawResult, resultReason, receivedText });
      const turnErrored = turnFailed || !receivedText || !!rateLimit;
      const asksQuestion = !wasStopped && !turnErrored && endsWithQuestion(activeCtx.lastText);
      const nextState = decideNextState({ wasStopped, rateLimit: !!rateLimit, turnFailed, asksQuestion });

      // A COMPLEX wave still in flight must NOT settle to `completed` between
      // background turns — that hides the progress bar in the UI. Stay
      // in_progress (bar visible, working:true) and hand off to the background
      // driver; it transitions to `completed` only once every ticket is terminal.
      const sessionId = runtime.session?.id;
      const sDir = sessionId ? `${LOG_DIR}/${sessionId}` : null;
      let waveInFlight = false;
      if (nextState === 'completed' && !turnErrored && sDir) {
        const { total, pendingCount } = await readTicketStatuses(sDir);
        driverLog(`turn settled: total=${total} pending=${pendingCount} session=${sessionId}`);
        waveInFlight = total > 0 && pendingCount > 0;
      }

      if (waveInFlight) {
        // Wave continues as background turns — keep the tailer running so their
        // subagent activity (mergers especially) stays in the live feed.
        await transitionState(runtime, 'in_progress');
        broadcast(runtime, { type: 'status', working: true });
        runtime.waveActive = true;
        startBgDriver(runtime, runtimes);
      } else {
        // Truly settling — flush and stop the tailer.
        await stopSubagentTailer(runtime).catch(() => {});
        await transitionState(runtime, nextState);
        broadcast(runtime, { type: 'status', working: false });
        // Documentator (Mode 2) is dispatched by the orchestrator at PD-RESPOND,
        // not spawned by chat-service — nothing to schedule here.
      }

      // Keep runtime alive while PTY is live — background turns may still fire.
      // The PTY exit handler covers teardown once all background work is done.
      if (runtime.clients.size === 0 && (!runtime.ptySession || runtime.ptySession.closed) && !runtime.ptyRestartPending) {
        await stopSubagentTailer(runtime).catch(() => {});
        runtime.session?.close();
        runtimes.delete(runtime.session.id);
      }
    }

    snapshotClaudeSession(runtime.claudeSessionId, runtime.session?.id).catch(() => {});
  }
}

async function snapshotClaudeSession(claudeSessionId, sessionId) {
  if (!claudeSessionId || !sessionId) return;
  const srcDir = claudeSessionDir(claudeSessionId);
  const destDir = join(LOG_DIR, sessionId, 'claude');

  await mkdir(destDir, { recursive: true });
  await copyFile(join(claudeProjectDir(), `${claudeSessionId}.jsonl`), join(destDir, 'transcript.jsonl'))
    .then(() => chmod(join(destDir, 'transcript.jsonl'), 0o644))
    .catch(() => {});
  for (const subdir of ['subagents', 'tool-results']) {
    const src = join(srcDir, subdir);
    const dst = join(destDir, subdir);
    await cp(src, dst, { recursive: true })
      .then(() => chmodDir(dst, 0o644, 0o755))
      .catch(() => {});
  }
}

async function chmodDir(dir, fileMode, dirMode) {
  await chmod(dir, dirMode).catch(() => {});
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await chmodDir(full, fileMode, dirMode);
    else await chmod(full, fileMode).catch(() => {});
  }
}
