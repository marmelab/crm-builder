import { on } from 'node:events';
import { readFile, unlink } from 'node:fs/promises';
import { LOG_DIR } from './config.js';
import { broadcast, sendStats } from './ws-bus.js';
import { runtimes, transitionState, noteRateLimit, cancelIdleTeardown } from './runtime.js';
import { rewriteUserMessage, extractText, extractToolUses, friendlyError } from './turn-helpers.js';
import { PtySession } from './pty-session.js';
import { endsWithQuestion } from './session-store.js';
import { decideNextState, turnFailedFrom, classifyTurn } from './turn-state.js';
import { startSubagentTailer, stopSubagentTailer } from './subagent-tail.js';
import { breakdownFromModelUsage } from '../stats/io.js';
import { updateProgressBar, predictedFlowExpected, flowExpectedForTickets } from './progress-bar.ts';
import {
  readTicketStatuses, AUTO_CONTINUE_NUDGE,
} from './auto-continue.js';
import { loadTicketsAndWaves } from '../stats/tickets.js';
import {
  driverLog, clearBgDriver, hasBgDriver, startBgDriver,
  settleBackgroundRateLimit, applyWaveFlagsOnTurnSettle, progressBarLive,
} from './bg-driver.js';
import { applyCumulativeUsage, foldSpawnUsageIntoStats } from './turn-usage.js';
import { snapshotClaudeSession } from './transcript-snapshot.js';

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
  if (dispatchedThisEvent && progressBarLive(runtime)) updateProgressBar(runtime);

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
      if (progressBarLive(runtime)) updateProgressBar(runtime);
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
// <session-title>…</session-title> tag to its first reply (orchestrator.md).
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

// POST-DEV interactive cartouches (satisfaction question + offer to switch to
// real data). The orchestrator (AtomicCRM) no longer embeds %%markers%% in its
// visible text — it replies in the user's language, plain words — and instead
// drops a one-shot signal file `<session_dir>/ask-state.json` when it enters
// STATE PD-ASK or STATE PD-LIVE-ASK. We read+delete it at turn settle (mailbox
// pattern) and emit a `satisfaction_ask` widget. POST-DEV can run as a
// background turn, so this is consumed in BOTH the active loop and the bg listener.
const ASK_STATE_FILE = 'ask-state.json';
const ASK_KINDS = new Set(['satisfaction', 'live-switch']);

// Validate + normalize the orchestrator's ask-state payload. Pure (no fs) so it
// can be unit-tested. Returns null for anything that isn't a known cartouche.
export function parseAskState(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
  if (!ASK_KINDS.has(kind)) return null;
  const str = (v) => (typeof v === 'string' && v.trim()) ? v.trim() : undefined;
  return {
    kind,
    header: str(raw.header),
    body:   str(raw.body),
    yes:    str(raw.yes),
    no:     str(raw.no),
  };
}

// Read the orchestrator's signal file once and consume it (delete). Broadcasts
// the cartouche and persists it on meta so a reconnecting client restores it.
// Returns true when a cartouche was emitted — the caller counts it as turn
// output, since the cartouche IS the orchestrator's reply (it ends the turn
// with no plain-text message so the question isn't duplicated).
// Exported for integration tests.
export async function applyPendingAsk(runtime, sessionDir) {
  runtime.askWriteSeen = false; // turn settled — release the text-suppression latch
  const path = `${sessionDir}/${ASK_STATE_FILE}`;
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch { return false; } // no pending ask
  await unlink(path).catch(() => {}); // one-shot: consume even if it doesn't parse
  const payload = parseAskState(text);
  if (!payload) return false;
  broadcast(runtime, { type: 'satisfaction_ask', ...payload });
  runtime.session?.setAsk(payload).catch(() => {});
  return true;
}

// Shared text pipeline for the active-turn loop and the background listener:
// title strip → dedup-vs-last → broadcast + recordMessage.
// `ctx.lastText` carries each path's own dedup state (mutated in place — keep a
// separate ctx per path so dedup state is never shared). Returns true whenever a
// non-empty assistant text was produced (even if it was a duplicate and thus not
// re-broadcast), matching the active loop's `receivedText` semantics.
// debug_raw and processStatsEvent stay at the call sites: their order relative to
// this text step differs between the two paths (active runs stats after text,
// background before) and must be preserved.
// True when this event writes the ask-state cartouche file. The same harness runs
// standalone in AtomicCRM (no chat-service → the question must be a plain text
// message) and under chat-service (cartouche). So the orchestrator ALWAYS prints
// the question as text AND writes ask-state.json; only here do we suppress the
// now-redundant text so the cartouche (which carries the question) isn't doubled.
function eventWritesAskState(event) {
  for (const t of extractToolUses(event)) {
    if (t.name === 'Write' && /(^|\/)ask-state\.json$/.test(t.input?.file_path || '')) return true;
  }
  return false;
}

export function handleOrchestratorText(runtime, event, ctx) {
  let text = applyAndStripSessionTitle(runtime, extractText(event));
  if (!text) return false;
  // A turn that writes ask-state.json is a POST-DEV cartouche turn: swallow its
  // text (the cartouche carries the question). `askWriteSeen` latches for the
  // rest of the turn — the write may arrive in the same event as the text or a
  // later one — and is cleared at settle by applyPendingAsk. Counted as output
  // (return true) so the turn-failed guard doesn't fire on the text-less turn.
  if (eventWritesAskState(event)) runtime.askWriteSeen = true;
  if (runtime.askWriteSeen) return true;
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
      runtime.askWriteSeen = false; // no cartouche carried over from a prior turn
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
        // POST-DEV (satisfaction / live-switch ask) usually settles in a bg turn;
        // the cartouche is real output even when the turn carries no text.
        applyPendingAsk(runtime, sessionDir)
          .then((emitted) => { if (emitted) runtime.sawBgProgressSinceTick = true; })
          .catch(() => {});
        if (progressBarLive(runtime)) updateProgressBar(runtime);
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
    runtime.subagentUsageOffsets ??= new Map();   // survives PTY restarts → no double-count
    // Session-cumulative deduped-by-message.id usage + its seen-id guard. Owned
    // by the runtime so they survive PTY restarts (a fresh watcher keeps the
    // running cumulative, never resets it mid-wave). This is the live source of
    // truth: sendStats reports it so the header matches /api/stats.
    runtime.cumulativeUsage ??= new Map();
    runtime.seenMsgIds ??= new Set();
    runtime.ptySession = new PtySession(runtime.claudeSessionId, sessionDir, {
      subagentUsageOffsets: runtime.subagentUsageOffsets,
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
      if (!runtime.busy && !hasBgDriver(runtime.session?.id)) {
        readTicketStatuses(`${LOG_DIR}/${runtime.session.id}`)
          .then(({ total, pendingCount }) => {
            if (total > 0 && pendingCount > 0 && !runtime.busy && !hasBgDriver(runtime.session?.id)) {
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
        // A POST-DEV ask ends the turn with no plain-text message (the cartouche
        // is the reply), so count it as output — otherwise the turn-failed guard
        // below ("|| !receivedText") would surface a spurious error.
        if (await applyPendingAsk(runtime, sessionDir)) receivedText = true;
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
        applyWaveFlagsOnTurnSettle(runtime, true);
        startBgDriver(runtime, runtimes);
      } else {
        // Truly settling — flush and stop the tailer. The wave flags must be
        // cleared here too: when the wave's last turn was an AUTO_CONTINUE,
        // processMessage left waveActive=true (only non-auto turns clear it),
        // and a stale true makes every later user message queue forever
        // (`r.busy || r.waveActive` guard in server.js).
        applyWaveFlagsOnTurnSettle(runtime, false);
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
