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
  decideAutoContinue, readTicketStatuses,
  AUTO_CONTINUE_DELAY_MS, AUTO_CONTINUE_NUDGE,
} from './auto-continue.js';
import { loadTicketsAndWaves } from '../stats/tickets.js';

const AGENT_DISPATCH_TOOLS = new Set(['Agent', 'Task']);

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

const autoContinueTimers = new Map();

function clearAutoContinueTimer(sessionId) {
  const t = autoContinueTimers.get(sessionId);
  if (t) { clearTimeout(t); autoContinueTimers.delete(sessionId); }
}

function scheduleAutoContinue(sessionId, runtimes) {
  clearAutoContinueTimer(sessionId);
  const t = setTimeout(() => {
    autoContinueTimers.delete(sessionId);
    const current = runtimes.get(sessionId);
    if (!current || current.busy) return;
    current.busy = true;
    processMessage(current, AUTO_CONTINUE_NUDGE, { auto: true })
      .catch(() => { current.busy = false; });
  }, AUTO_CONTINUE_DELAY_MS);
  autoContinueTimers.set(sessionId, t);
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

  if (runtime.session?.id) {
    clearDocumentatorTimer(runtime.session.id);
    clearAutoContinueTimer(runtime.session.id);
    if (!isAutoContinue) runtime.autoContinue = { count: 0, noProgress: 0, prevSig: null };
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

  const toolMap = new Map();
  const taskRole = new Map();
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
      if (runtime.busy) return;
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
        updateProgressBar(runtime);
        sendStats(runtime);
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

      let dispatchedThisEvent = false;
      for (const tool of extractToolUses(event)) {
        const alreadySeen = toolMap.has(tool.id);
        toolMap.set(tool.id, tool);
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

      if (!rateLimit && event.type === 'assistant' && event.error === 'rate_limit') {
        const txt = event.message?.content?.find?.((b) => b?.type === 'text')?.text || '';
        rateLimit = { resetsAt: parseResetsAtFromText(txt), message: txt || null };
        noteRateLimit(runtime, rateLimit);
      }

      if (!rateLimit && event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'blocked') {
        rateLimit = event.rate_limit_info;
        noteRateLimit(runtime, rateLimit);
      }

      if (event.type === 'system') {
        const isAgentTaskType =
          event.task_type === 'local_agent' || event.task_type === 'in_process_teammate';
        if (event.subtype === 'task_started' && isAgentTaskType && event.task_id) {
          runtime.stats.activeAgentIds.add(event.task_id);
          runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
          const role = toolMap.get(event.tool_use_id)?.input?.subagent_type;
          if (role) taskRole.set(event.task_id, role);
          sendStats(runtime);
        } else if (event.subtype === 'task_notification' && event.status === 'completed' && event.task_id && runtime.stats.activeAgentIds.has(event.task_id)) {
          runtime.stats.activeAgentIds.delete(event.task_id);
          runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
          runtime.stats.agentsCompleted++;
          const doneRole = taskRole.get(event.task_id);
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

      if (event.type === 'result') {
        sawResult = true;
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
    await stopSubagentTailer(runtime).catch(() => {});

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

    broadcast(runtime, { type: 'status', working: false });
    const wasStopped = !!runtime.stopping;
    runtime.stopping = false;

    if (!wasStopped && !rateLimit && runtime.queue.length > 0) {
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
      await transitionState(runtime, nextState);

      if (nextState === 'completed' && !turnErrored) {
        const sessionId = runtime.session?.id;
        const sDir = sessionId ? `${LOG_DIR}/${sessionId}` : null;
        if (sDir) {
          const { total, pendingCount, pendingSig } = await readTicketStatuses(sDir);
          const ac = runtime.autoContinue || { count: 0, noProgress: 0, prevSig: null };
          const decision = decideAutoContinue({
            nextState, turnErrored,
            totalTickets: total, pendingCount, pendingSig,
            prevPendingSig: ac.prevSig,
            autoContinueCount: ac.count,
            noProgressCount: ac.noProgress,
          });
          if (decision.go) {
            runtime.autoContinue = {
              count: ac.count + 1,
              noProgress: decision.noProgressCount ?? 0,
              prevSig: pendingSig,
            };
            scheduleAutoContinue(sessionId, runtimes);
          } else {
            if (decision.stalled) {
              const done = Math.max(0, total - pendingCount);
              const stallText = `I finished ${done} of ${total} planned pieces, but ${pendingCount} ${pendingCount === 1 ? 'is' : 'are'} still unfinished. Say "continue" and I'll pick the rest back up.`;
              broadcast(runtime, { type: 'message', role: 'assistant', content: stallText, ts: new Date().toISOString() });
              await runtime.session?.recordMessage('assistant', stallText).catch(() => {});
              await transitionState(runtime, 'error');
            }
            runtime.autoContinue = { count: 0, noProgress: 0, prevSig: null };
            if (await sessionHasMergedTickets(sDir)) {
              scheduleDocumentatorRun(sessionId, runtimes);
            }
          }
        }
      }

      // Keep runtime alive while PTY is live — background turns may still fire.
      // The PTY exit handler covers teardown once all background work is done.
      if (runtime.clients.size === 0 && (!runtime.ptySession || runtime.ptySession.closed) && !runtime.ptyRestartPending) {
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
