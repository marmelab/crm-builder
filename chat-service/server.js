import { createServer } from 'http';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { PORT } from './lib/server/config.js';
import { loadSystemPrompt, applySystemPrompt } from './lib/server/system-prompt.js';
import { openSession } from './lib/server/session-store.js';
import { createRequestHandler, switchMode } from './lib/server/http-routes.js';
import { runtimes, wsToRuntime, runtimeForWs, createRuntime, safeSend } from './lib/server/runtime.js';
import { sendToWs } from './lib/server/ws-bus.js';
import { sendProgress } from './lib/server/ticket-progress.js';
import { regenerateTitleWithHaiku, extractText, extractToolUses } from './lib/server/claude-spawn.js';
import { processMessage } from './lib/server/turn.js';
import { endsWithQuestion } from './lib/server/session-store.js';

// Re-exported for unit tests (test/server.test.js imports from '../server.js').
export { extractText, extractToolUses, endsWithQuestion };

const __dirname = fileURLToPath(new URL('.', import.meta.url));

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
  if (session.isNew && process.env.MODE === 'full') {
    switchMode('demo');
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
  }
  runtime.clients.add(ws);
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
    // still queued so it can re-apply the badge.
    queuedCount: runtime.queue.length,
    // Re-hydrate the "working" UI (dots, stop button, spinner) when a turn
    // is in progress — conveyed inline rather than via a separate status
    // frame so the client doesn't mistakenly interpret it as a false→true
    // transition (which would demote a still-queued message).
    working: runtime.busy,
    isNew: session.isNew,
  });
  // Send the current progress snapshot so a (re)joining tab paints the
  // counter immediately instead of waiting for the next merge / write event.
  sendProgress(runtime).catch(() => {});
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

    // Stop button: kill the running claude process and clear the queue.
    if (parsed.type === 'stop') {
      if (!r.busy) return;
      r.stopping = true;
      r.queue = [];
      const p = r.currentProc;
      if (p && !p.killed) {
        try { p.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          try { if (p && !p.killed) p.kill('SIGKILL'); } catch {}
        }, 2000);
      }
      r.session?.logWrite('in', { type: 'stop_requested' });
      return;
    }

    if (!parsed.content?.trim()) return;
    // `display` is an optional client-side label (e.g. for choice buttons) —
    // what the user actually saw. `content` is what we forward to claude.
    const displayed = typeof parsed.display === 'string' && parsed.display.trim()
      ? parsed.display
      : parsed.content;
    r.session.logWrite('in', { type: 'user_message', content: parsed.content, display: displayed });
    r.session.recordMessage('user', displayed).then(() => {
      // Trigger Haiku retitling on the 1st user message, once per session.
      const m = r.session.meta;
      if (m.userMessageCount === 1 && !m.titleLocked && !m.titleAutoGenerated) {
        regenerateTitleWithHaiku(r).catch(() => {});
      }
    }).catch(() => {});
    if (r.busy) {
      r.queue.push(parsed.content);
    } else {
      r.busy = true;
      processMessage(r, parsed.content);
    }
  });

  ws.on('close', () => {
    const r = runtimeForWs(ws);
    wsToRuntime.delete(ws);
    if (!r) return;
    r.clients.delete(ws);
    // Only tear down when the session is fully idle. If a turn is still
    // running, processMessage's finally block will release the runtime once
    // it finishes (if no clients are left by then).
    if (r.clients.size === 0 && !r.busy) {
      r.session?.close();
      runtimes.delete(r.session.id);
    }
  });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadSystemPrompt().then((parsed) => {
    applySystemPrompt(parsed);
    const t = parsed.tools?.length ? parsed.tools.join(',') : 'default';
    console.log(parsed.content ? `Orchestrator loaded (model: ${parsed.model || 'default'}, tools: ${t}).` : 'No orchestrator prompt, using default.');
  });
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Chat service listening on port ${PORT}`);
  });
}
