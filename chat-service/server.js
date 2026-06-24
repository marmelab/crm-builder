import { createServer } from 'http';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { PORT, MODE_DEMO, MODE_FULL, LOG_DIR } from './lib/server/config.js';
import {
  loadSystemPrompt, applySystemPrompt,
} from './lib/server/system-prompt.js';
import { openSession, deleteSession, readMessages, sessionHasTickets } from './lib/server/session-store.js';
import { createRequestHandler, switchMode } from './lib/server/http-routes.js';
import { runtimes, wsToRuntime, runtimeForWs, createRuntime, safeSend, killCurrentProc, scheduleIdleTeardown, cancelIdleTeardown } from './lib/server/runtime.js';
import { sendToWs, broadcast } from './lib/server/ws-bus.js';
import { updateProgressBar } from './lib/server/progress-bar.ts';
import { extractText, extractToolUses, planResume } from './lib/server/turn-helpers.js';
import { processMessage } from './lib/server/turn.js';
import { stopBackgroundWave, reconcileWaveState } from './lib/server/bg-driver.js';
import { endsWithQuestion } from './lib/server/session-store.js';

// Re-exported for unit tests (test/server.test.js imports from '../server.js').
export { extractText, extractToolUses, endsWithQuestion };

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Resolve how a resume re-enters the turn loop. Only a process-killed state
// (error / rate_limited) with a COMPLEX wave in flight (ticket files on disk)
// needs the fresh-session recovery path; everything else resumes normally. The
// ticket check is the one async step, so it's confined to those states — normal
// turns never touch the filesystem here.
async function resolveResumePlan(sessionId, state, message) {
  const processKilled = state === 'error' || state === 'rate_limited';
  const hasWork = processKilled && await sessionHasTickets(`${LOG_DIR}/${sessionId}`);
  return planResume(state, message, hasWork);
}

const httpServer = createServer(createRequestHandler({ publicDir: join(__dirname, 'public') }));

const wss = new WebSocketServer({ server: httpServer });
wss.on('error', (err) => console.error('WebSocket server error:', err));
httpServer.on('error', (err) => console.error('HTTP server error:', err));

wss.on('connection', async (ws, req) => {
  const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const requestedId = urlObj.searchParams.get('session');
  const session = await openSession(requestedId).catch(() => null);
  if (!session) {
    ws.close();
    return;
  }

  // A brand-new chat session always starts back on the FakeRest demo.
  // Otherwise the iframe would still be wired to the previous session's
  // real-data view, which is misleading and risky (writes hit Supabase).
  // Existing/rejoined sessions keep whatever mode the runtime is in.
  // Reuses the same helper the /api/mode POST handler runs, so the two
  // code paths can never drift apart.
  if (session.isNew && process.env.MODE === MODE_FULL) {
    switchMode(MODE_DEMO);
  }

  let runtime = runtimes.get(session.id);
  const joining = !!runtime;
  // `session.timeline` is a fresh snapshot read just now from the log —
  // always send it on init (the runtime's snapshot would be stale by the
  // time another tab joins). The timeline interleaves messages and debug
  // events in chronological order, so a refreshed tab paints them in the
  // same positions a live-connected tab saw them.
  const freshTimeline = session.timeline || [];
  const freshMessages = session.messages;
  if (!runtime) {
    runtime = createRuntime(session);
    runtimes.set(session.id, runtime);
  } else {
    // Another tab/reconnect is joining an existing runtime. Discard the
    // newly-opened session handle (it would duplicate the log stream);
    // the runtime keeps the original.
    session.close();
    // A runtime that survived a long idle gap can carry a stale waveActive=true
    // (e.g. a PTY that died without a heartbeat clearing it). Re-derive from
    // disk: if every ticket is terminal and nothing is actively driving, clear
    // it so the next message dispatches instead of queueing forever.
    reconcileWaveState(runtime).catch(() => {});
  }
  runtime.clients.add(ws);
  cancelIdleTeardown(runtime);
  wsToRuntime.set(ws, runtime.session.id);
  console.log(`Session ${session.isNew ? 'created' : joining ? 'rejoined' : 'resumed'}: ${runtime.session.id}`);

  // init is a per-WS snapshot rebuilt from the log on each (re)connect — don't
  // re-log it, otherwise long sessions with many reconnects accumulate large
  // duplicate message arrays in log.jsonl with no replay value.
  sendToWs(ws, {
    type: 'init',
    sessionId: runtime.session.id,
    title: runtime.session.meta.title,
    state: runtime.session.meta.state || 'in_progress',
    // Chronological interleave of messages and debug events — replaces the
    // separate `messages` + `debugEvents` fields. The client renders items in
    // order so debugs sit between the messages they happened between, not
    // bunched at the end after a refresh.
    timeline: freshTimeline,
    // `messages` is kept for back-compat with any older client; the new
    // client ignores it when `timeline` is present.
    messages: freshMessages,
    // Messages currently waiting in the queue are persisted in the log like
    // any other user message; the "waiting" badge is a pure client-side
    // marker. Tell the joining tab how many of the tail user messages are
    // still queued so it can re-apply the badge, and their queue ids so the
    // tab can wire each queued message to its server-side cancellation id.
    queuedCount: runtime.queue.length,
    queuedIds: runtime.queue.map((q) => q.id),
    // Re-hydrate the "working" UI (dots, stop button, spinner) when a turn
    // is in progress — conveyed inline rather than via a separate status
    // frame so the client doesn't mistakenly interpret it as a false→true
    // transition (which would demote a still-queued message).
    working: runtime.busy,
    // Unix-seconds timestamp when the 5h usage limit window resets. Set when
    // the session lands in `rate_limited` state so a refresh shows the same
    // countdown + resume button the live tab last rendered.
    rateLimitResetsAt: runtime.session.meta.rateLimitResetsAt ?? null,
    // Open POST-DEV cartouche (satisfaction or live-switch) to restore on reconnect.
    // `satisfactionAsk` kept as a fallback for sessions written before the unified field.
    ask: runtime.session.meta.ask ?? runtime.session.meta.satisfactionAsk ?? false,
    isNew: session.isNew,
    // Deploy progress is delivered over its own SSE channel
    // (GET /api/deploy/events), not the chat WebSocket — it's cross-session
    // global state and the modal must work even with no chat session open.
  });
  updateProgressBar(runtime, ws);
  // Repaint the cumulative tokens/cost ticker on (re)connect — runtime.stats
  // is seeded from the log digest, but resetChatUi just cleared the DOM.
  // Skip when there's nothing to show (fresh session) to avoid a "0 tokens
  // · $0.000" flash before the first turn lands.
  if (runtime.stats.tokensUsed > 0 || runtime.stats.costUsd > 0) {
    sendToWs(ws, {
      type: 'stats',
      tokensUsed: runtime.stats.tokensUsed,
      costUsd: runtime.stats.costUsd + runtime.stats.costUsdCurrentSpawn,
      activeAgents: runtime.stats.activeAgents,
    });
  }

  ws.on('message', (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { return; }

    const r = runtimeForWs(ws);
    if (!r) return;
    cancelIdleTeardown(r);

    // Resume button: user clicked "Resume" after the 5h limit reset, or after a
    // turn errored. Replay the last user message so the orchestrator picks up
    // where it left off.
    if (parsed.type === 'resume') {
      if (r.busy) return; // a turn is already running — nothing to resume
      const st = r.session.meta.state;
      if (st !== 'rate_limited' && st !== 'error') return;
      const resetsAt = r.session.meta.rateLimitResetsAt;
      // Defensive: the UI disables the button until reset, but a stale tab
      // could still post — reject so the user waits the right amount.
      if (typeof resetsAt === 'number' && Date.now() < resetsAt * 1000) return;
      // Claim the runtime synchronously: readMessages is async, and without
      // this another ws.on('message') firing in the gap (regular content
      // submit, second resume click) would also pass the busy guard and
      // start a concurrent processMessage on the same runtime.
      r.busy = true;
      readMessages(r.session.id).then(async (msgs) => {
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
        if (!lastUser?.content) { r.busy = false; return; }
        r.session.logWrite('in', { type: 'resume_requested' });
        // A crash or a usage limit both kill the process + its team. If a
        // COMPLEX wave was in flight, --resume would reinject the dead "team is
        // alive" belief and the orchestrator no-ops; resolveResumePlan picks a
        // fresh recovery spawn in that case and a plain --resume otherwise.
        const { prompt, freshSession } = await resolveResumePlan(r.session.id, st, lastUser.content);
        processMessage(r, prompt, { freshSession });
      }).catch(() => { r.busy = false; });
      return;
    }

    // Stop button: kill the running claude process and clear the queue.
    if (parsed.type === 'stop') {
      // A background wave keeps the session occupied with busy=false — STOP must
      // still act on it, otherwise the heartbeat runs on and waveActive stays set
      // forever (every future message would queue and never drain).
      if (!r.busy && !r.waveActive) return;
      r.stopping = true;
      const hadQueued = r.queue.length > 0;
      r.queue = [];
      // Tear down a background wave (clears waveActive, stops the heartbeat +
      // tailer, kills the idle PTY, settles state). No-op when no wave is active.
      // Fire-and-forget: the handler isn't async, and the synchronous teardown
      // below (queue clear, log, broadcast) is independent of it.
      stopBackgroundWave(r).catch(() => {});
      killCurrentProc(r);
      r.session?.logWrite('in', { type: 'stop_requested' });
      if (hadQueued) {
        // Tell all tabs the queue is now empty so any queued bubbles drop their
        // ⏳ badge / × button.
        broadcast(r, { type: 'queue_updated', queuedIds: [] });
      }
      return;
    }

    // Cancel a specific queued message by its server-assigned id. Idempotent:
    // a stale id (already shifted or cancelled) just re-broadcasts the current
    // queue so the requester reconciles. The user message stays in the log but
    // is flagged via a paired `cancel_queued` entry, which digestLog filters
    // out — so refresh / rejoin won't resurrect the cancelled bubble.
    if (parsed.type === 'cancel_queued') {
      const id = Number(parsed.id);
      if (!Number.isFinite(id)) return;
      const idx = r.queue.findIndex((q) => q.id === id);
      if (idx !== -1) {
        r.queue.splice(idx, 1);
        r.session?.logWrite('in', { type: 'cancel_queued', queueId: id });
      }
      const queuedIds = r.queue.map((q) => q.id);
      const payload = idx !== -1
        ? { type: 'queue_updated', queuedIds, cancelledId: id }
        : { type: 'queue_updated', queuedIds };
      broadcast(r, payload);
      return;
    }

    if (!parsed.content?.trim()) return;
    // `display` is an optional client-side label (e.g. for choice buttons) —
    // what the user actually saw. `content` is what we forward to claude.
    const displayed = typeof parsed.display === 'string' && parsed.display.trim()
      ? parsed.display
      : parsed.content;
    // Tag the log entry with `queueId` only when the message lands in the
    // queue: that id is what `cancel_queued` references, and digestLog uses
    // the pair to drop cancelled bubbles on rehydrate. Messages that run
    // immediately can never be cancelled, so they stay untagged.
    let queueId = null;
    if (r.busy || r.waveActive) {
      queueId = ++r.queueIdSeq;
      r.queue.push({ id: queueId, content: parsed.content });
    }
    const logEntry = { type: 'user_message', content: parsed.content, display: displayed };
    if (queueId !== null) logEntry.queueId = queueId;
    r.session.logWrite('in', logEntry);
    r.session.recordMessage('user', displayed).catch(() => {});
    // Session titling is no longer a separate Haiku spawn: the orchestrator emits
    // a <session-title>…</session-title> tag on its first reply (parsed in turn.js).
    if (queueId !== null) {
      const queuedIds = r.queue.map((q) => q.id);
      broadcast(r, { type: 'queue_updated', queuedIds, addedId: queueId });
    } else if (/^\s*\/fake\b/i.test(parsed.content)) {
      // /fake [scenario=<name>] [speed=<n>] — inject a synthetic turn into the
      // current session without spawning Claude (zero tokens).
      // Each scenario manages runtime.busy itself (cleared in its last timer).
      r.busy = true;
      (async () => {
        const { runFakeTurn } = await import('./lib/server/synthetic-session.js');
        const params = {};
        const sm = parsed.content.match(/scenario=(\S+)/i);
        const sp = parsed.content.match(/speed=(\d+(?:\.\d+)?)/i);
        if (sm) params.scenario = sm[1];
        if (sp) params.speed = parseFloat(sp[1]);
        await runFakeTurn(r, params);
      })().catch((err) => {
        broadcast(r, { type: 'message', role: 'assistant', content: `❌ /fake error: ${err.message}` });
        r.busy = false;
      });
    } else {
      // Claim the runtime synchronously (before any await) so a second message
      // racing in can't start a concurrent turn.
      r.busy = true;
      const st = r.session.meta.state;
      if (st === 'error' || st === 'rate_limited') {
        // A message typed while the session is process-killed (e.g. the user
        // types "resume"/"continue" instead of clicking the button) must get the
        // same recovery treatment as the Resume button — otherwise it would
        // --resume the dead transcript and the orchestrator no-ops.
        resolveResumePlan(r.session.id, st, parsed.content)
          .then(({ prompt, freshSession }) => processMessage(r, prompt, { freshSession }))
          .catch(() => processMessage(r, parsed.content));
      } else {
        processMessage(r, parsed.content);
      }
    }
  });

  ws.on('close', async () => {
    const r = runtimeForWs(ws);
    wsToRuntime.delete(ws);
    if (!r) return;
    r.clients.delete(ws);
    // Only tear down when the session is fully idle. If a turn is still
    // running, processMessage's finally block will release the runtime once
    // it finishes (if no clients are left by then).
    if (
      r.clients.size === 0 &&
      !r.busy &&
      (!r.ptySession || r.ptySession.closed) &&
      !r.ptyRestartPending
    ) {
      const id = r.session.id;
      const empty = (r.session.meta.messageCount || 0) === 0;
      // Await the log stream flush before rm so we don't race writes against
      // deletion (cf. the same pattern in http-routes' DELETE handler).
      await r.session?.close();
      runtimes.delete(id);
      if (empty) await deleteSession(id);
    } else if (r.clients.size === 0) {
      // PTY (or a turn) still alive with nobody watching: arm the idle reaper.
      scheduleIdleTeardown(r);
    }
  });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Load the orchestrator model before accepting connections. The documentator
  // is no longer spawned headless by chat-service (the orchestrator dispatches it
  // via Agent, which loads documentator.md directly), so nothing to preload for it.
  Promise.all([
    loadSystemPrompt().then((parsed) => {
      applySystemPrompt(parsed);
      console.log(parsed.content ? `Orchestrator loaded (model: ${parsed.model || 'default'}).` : 'No orchestrator prompt, using default.');
    }),
  ]).then(() => {
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`Chat service listening on port ${PORT}`);
    });
  });
}
