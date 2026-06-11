import { on } from 'node:events';
import { cp, copyFile, mkdir, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LOG_DIR, claudeProjectDir, claudeSessionDir } from './config.js';
import { broadcast, sendStats } from './ws-bus.js';
import { runtimes, transitionState, noteRateLimit } from './runtime.js';
import { rewriteUserMessage, extractText, extractToolUses, friendlyError } from './claude-spawn.js';
import { PtySession } from './pty-session.js';
import { endsWithQuestion } from './session-store.js';
import { decideNextState, turnFailedFrom } from './turn-state.js';
import { startSubagentTailer, stopSubagentTailer } from './subagent-tail.js';
import {
  emptyBreakdown, addBreakdown, breakdownFromModelUsage, costFromBreakdown,
} from '../stats/io.js';
import { updateProgressBar, predictedFlowExpected, flowExpectedForTickets } from './progress-bar.ts';
import {
  sessionHasMergedTickets, scheduleDocumentatorRun, clearDocumentatorTimer,
} from './documentator-spawn.js';
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
// When every ticket is merged the wave isn't done yet: promotion (session→main)
// and any follow-up (e.g. a translation fix) still run as background turns. Stay
// in_progress (bar visible) and only settle `completed` after this many ticks
// with NO new background turn — so the orchestrator's final recap lands in chat
// before the bar disappears. Must exceed the promotion merger's run time (~30-60s)
// so we never complete during the idle gap while it runs. 12 ticks ≈ 72 s.
const HEARTBEAT_DRAIN_QUIET_TICKS = 12;

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

// Start (or restart) the heartbeat that nudges the idle PTY so background turns
// fire. Reads ticket statuses each tick: all terminal → finish; otherwise nudge
// and track no-progress for stall escalation.
function startBgDriver(runtime, runtimes) {
  const sessionId = runtime.session?.id;
  if (!sessionId) return;
  clearBgDriver(sessionId);
  const sDir = `${LOG_DIR}/${sessionId}`;
  const state = { prevSig: null, noProgress: 0, resumed: false, timer: null, seenBgCount: runtime.bgResultCount || 0, drainQuiet: 0 };
  driverLog(`heartbeat started session=${sessionId}`);

  state.timer = setInterval(async () => {
    const current = runtimes.get(sessionId);
    // Stop the heartbeat if the runtime is gone, an active turn is running, or
    // the PTY has died (a fresh PTY's exit handler / next turn re-arms it).
    if (!current) { clearBgDriver(sessionId); return; }
    if (current.busy) return;
    if (!current.ptySession || current.ptySession.closed) {
      driverLog(`heartbeat stop: PTY gone session=${sessionId}`);
      clearBgDriver(sessionId);
      return;
    }

    const { total, pendingCount, pendingSig } = await readTicketStatuses(sDir);
    if (total === 0) { clearBgDriver(sessionId); return; }          // not a COMPLEX wave

    const bgCount = current.bgResultCount || 0;

    if (pendingCount === 0) {
      // All tickets merged, but promotion (session→main) and any follow-up still
      // run as background turns. Stay in_progress (bar visible) and keep nudging
      // until the orchestrator goes quiet — only then settle, so the final recap
      // message reaches chat first.
      if (bgCount !== state.seenBgCount) { state.drainQuiet = 0; state.seenBgCount = bgCount; }
      else state.drainQuiet = (state.drainQuiet || 0) + 1;
      if (state.drainQuiet >= HEARTBEAT_DRAIN_QUIET_TICKS) {
        driverLog(`heartbeat done: drained quiet session=${sessionId}`);
        clearBgDriver(sessionId);
        await stopSubagentTailer(current).catch(() => {});
        await transitionState(current, 'completed');
        broadcast(current, { type: 'status', working: false });
        if (await sessionHasMergedTickets(sDir)) scheduleDocumentatorRun(sessionId, runtimes);
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
      clearBgDriver(sessionId);
      await stopSubagentTailer(current).catch(() => {});
      const done = Math.max(0, total - pendingCount);
      const stallText = `I finished ${done} of ${total} planned pieces, but ${pendingCount} ${pendingCount === 1 ? 'is' : 'are'} still unfinished. Say "continue" and I'll pick the rest back up.`;
      broadcast(current, { type: 'message', role: 'assistant', content: stallText, ts: new Date().toISOString() });
      await current.session?.recordMessage('assistant', stallText).catch(() => {});
      await transitionState(current, 'error');
      return;
    }

    if (state.noProgress >= HEARTBEAT_STALL_TICKS && !state.resumed) {
      // Nudges alone haven't advanced the wave — escalate once to a heavyweight
      // resume that re-states the STATE B instructions, then keep nudging.
      driverLog(`heartbeat escalate: AUTO_CONTINUE after ${state.noProgress} ticks pending=${pendingCount} session=${sessionId}`);
      state.resumed = true;
      current.busy = true;
      processMessage(current, AUTO_CONTINUE_NUDGE, { auto: true })
        .catch(() => { current.busy = false; });
      return;
    }

    // Normal tick: poke the idle TUI so it delivers pending background-agent
    // completions and runs its Step 2 background turn.
    driverLog(`heartbeat nudge: noProgress=${state.noProgress} pending=${pendingCount} session=${sessionId}`);
    current.ptySession.nudge();
  }, HEARTBEAT_MS);

  bgDrivers.set(sessionId, { timer: state.timer });
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

export async function processMessage(runtime, prompt, opts = {}) {
  if (!runtime) return;
  const isAutoContinue = opts.auto === true;

  driverLog(`processMessage enter auto=${isAutoContinue} session=${runtime.session?.id} ptyAlive=${!!runtime.ptySession && !runtime.ptySession.closed}`);
  if (runtime.session?.id) {
    clearDocumentatorTimer(runtime.session.id);
    clearBgDriver(runtime.session.id);
    if (!isAutoContinue) {
      runtime.autoContinue = { count: 0, noProgress: 0, prevSig: null };
      // Fresh user turn — drop stale dispatch/task correlation from a prior request.
      runtime.toolMap.clear();
      runtime.taskRole.clear();
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
  let lastAssistantText = '';
  let sawResult = false;

  const sessionDir = `${LOG_DIR}/${runtime.session.id}`;

  // ── PTY lifecycle ──────────────────────────────────────────────────────────
  // attachBgListener: forwards background orchestrator turns (fired when a
  // run_in_background subagent completes) to WS clients while the session is
  // idle (no active processMessage). No InboxPoller watchdog needed: noAgentTeam
  // uses Agent({run_in_background:true}) — no team inbox to poll.
  function attachBgListener(ptyRef) {
    if (ptyRef._bgAttached) return;
    ptyRef._bgAttached = true;
    let bgLastText = '';

    const bgHandler = (event) => {
      // While an active turn is running, ptyEventsUntilResult owns the events —
      // skip here to avoid double-processing.
      if (runtime.busy) return;
      if (event.type === 'background_result') driverLog(`background_result received (idle) session=${runtime.session?.id}`);
      broadcast(runtime, { type: 'debug_raw', event });
      // Advance progress/stats from this background turn's events, identical to
      // the active-turn loop, so the bar keeps moving between user turns.
      processStatsEvent(runtime, event, sessionDir).catch(() => {});
      const text = extractText(event);
      if (text) {
        const isDuplicate = text.trim() === bgLastText.trim();
        bgLastText = text;
        if (!isDuplicate) {
          broadcast(runtime, { type: 'message', role: 'assistant', content: text, ts: new Date().toISOString() });
          runtime.session?.recordMessage('assistant', text).catch(() => {});
        }
      }
      if (event.type === 'background_result') {
        // Count background turns so the heartbeat treats them as progress and
        // doesn't escalate to a heavyweight resume while the wave is advancing.
        runtime.bgResultCount = (runtime.bgResultCount || 0) + 1;
        updateProgressBar(runtime);
        sendStats(runtime);
        // Snapshot subagent transcripts now: most COMPLEX work (dev, reviewers,
        // merger) runs in background turns, and snapshotClaudeSession otherwise
        // only fires at active-turn end — so without this, /api/stats would miss
        // every agent that ran since the last user turn.
        snapshotClaudeSession(runtime.claudeSessionId, runtime.session?.id).catch(() => {});
      }
    };
    ptyRef.on('event', bgHandler);
    ptyRef.once('exit', () => {
      ptyRef.off('event', bgHandler);
      ptyRef._bgAttached = false;
    });
  }

  function spawnOrResumePty() {
    runtime.ptySession = new PtySession(runtime.claudeSessionId, sessionDir);
    attachBgListener(runtime.ptySession);

    runtime.ptySession.once('exit', () => {
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

  if (!runtime.ptySession || runtime.ptySession.closed) {
    spawnOrResumePty();
  } else {
    attachBgListener(runtime.ptySession);
  }

  runtime.ptySession.send(buildPrompt(prompt));
  runtime.currentProc = { kill: () => runtime.ptySession?.kill() };

  try {
    for await (const event of ptyEventsUntilResult(runtime.ptySession)) {
      if (event.session_id) {
        runtime.claudeSessionId = event.session_id;
        runtime.session?.setClaudeSessionId(event.session_id).catch(() => {});
        startSubagentTailer(runtime).catch((e) => console.error('[subagent-tail]', e));
      }

      broadcast(runtime, { type: 'debug_raw', event });

      const text = extractText(event);
      if (text) {
        receivedText = true;
        const isDuplicate = text.trim() === lastAssistantText.trim();
        lastAssistantText = text;
        if (!isDuplicate) {
          broadcast(runtime, { type: 'message', role: 'assistant', content: text, ts: new Date().toISOString() });
          runtime.session?.recordMessage('assistant', text).catch(() => {});
        }
      }

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
        driverLog(`result seen receivedText=${receivedText} session=${runtime.session?.id}`);
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

    if (runtime.stopping) {
      const stopText = '⏹ Session stopped.';
      broadcast(runtime, { type: 'message', role: 'assistant', content: stopText, ts: new Date().toISOString() });
      await runtime.session?.recordMessage('assistant', stopText).catch(() => {});
    } else if (turnFailedFrom({ resultError, stderr, sawResult, exitCode }) || !receivedText || rateLimit) {
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
    runtime.currentProc = null;
    sendStats(runtime);

    const wasStopped = !!runtime.stopping;
    runtime.stopping = false;

    if (!wasStopped && !rateLimit && runtime.queue.length > 0) {
      broadcast(runtime, { type: 'status', working: false });
      const next = runtime.queue.shift();
      broadcast(runtime, { type: 'queue_updated', queuedIds: runtime.queue.map((q) => q.id) });
      processMessage(runtime, next.content);
    } else {
      if (wasStopped || rateLimit) runtime.queue = [];
      runtime.busy = false;

      const exitCode = sawResult ? 0 : 1;
      const stderr = runtime.ptySession?.stderr ?? '';
      const turnFailed = turnFailedFrom({ resultError, stderr, sawResult, exitCode });
      const turnErrored = turnFailed || !receivedText || !!rateLimit;
      const asksQuestion = !wasStopped && !turnErrored && endsWithQuestion(lastAssistantText);
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
        startBgDriver(runtime, runtimes);
      } else {
        // Truly settling — flush and stop the tailer.
        await stopSubagentTailer(runtime).catch(() => {});
        await transitionState(runtime, nextState);
        broadcast(runtime, { type: 'status', working: false });
        if (nextState === 'completed' && !turnErrored && sDir && await sessionHasMergedTickets(sDir)) {
          scheduleDocumentatorRun(sessionId, runtimes);
        }
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
