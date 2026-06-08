// Debug-only HTTP endpoints for UI testing. All routes are under /api/debug/.
//
// GET /api/debug/synthetic-session?scenario=simple3|complex4&speed=20
//   Creates a fully-formed COMPLEX session (TASK-*.json + log.jsonl) and
//   broadcasts all events live. Navigate to the returned URL to watch it
//   unfold in real-time, or open it later to see the full history.
//   Equivalent to typing `/fake` in the chat but produces a standalone session.
//
// GET /api/debug/replay?sessionId=<target>&source=<recordedId>&speed=20
//   Replays all dir:'out' events from a recorded session onto an open session.
//   Requires the target session to be open in a browser tab (active WS).

import { readJsonl } from '../stats/io.js';
import { LOG_DIR } from './config.js';
import { runtimes } from './runtime.js';
import { broadcast } from './ws-bus.js';

const jsonError = (res, code, msg) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
};

async function handleSyntheticSession(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const scenario = url.searchParams.get('scenario') || 'simple3';
  const speed = Math.max(1, Math.min(200, parseFloat(url.searchParams.get('speed') || '20')));
  try {
    const { createSyntheticSession } = await import('./synthetic-session.js');
    const result = await createSyntheticSession({ scenario, speed });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...result, url: `/sessions/${result.sessionId}` }));
  } catch (err) {
    jsonError(res, 400, err.message);
  }
}

async function handleReplay(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const targetId = url.searchParams.get('sessionId');
  const sourceId = url.searchParams.get('source');
  const speed    = Math.max(1, Math.min(200, parseFloat(url.searchParams.get('speed') || '20')));

  if (!sourceId) return jsonError(res, 400, 'source param required — pass ?source=<sessionId>');
  const runtime = targetId ? runtimes.get(targetId) : null;
  if (!runtime) return jsonError(res, 400, 'sessionId not found or no active runtime — open the session in the UI first');

  const outEvents = [];
  try {
    for await (const event of readJsonl(`${LOG_DIR}/${sourceId}/log.jsonl`)) {
      if (event.dir === 'out') outEvents.push(event);
    }
  } catch {
    return jsonError(res, 404, `source session ${sourceId} not found`);
  }
  if (outEvents.length === 0) return jsonError(res, 400, 'no outbound events in source session');
  const t0 = new Date(outEvents[0].ts).getTime();
  for (const event of outEvents) {
    const delay = Math.round((new Date(event.ts).getTime() - t0) / speed);
    const { ts, dir, ...payload } = event;
    setTimeout(() => broadcast(runtime, payload), delay);
  }
  const totalDurationMs = Math.round((new Date(outEvents[outEvents.length - 1].ts).getTime() - t0) / speed);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, source: sourceId, events: outEvents.length, speed, totalDurationMs }));
}

export function handleDebugRequest(req, res) {
  if (req.url?.startsWith('/api/debug/synthetic-session') && req.method === 'GET') return handleSyntheticSession(req, res);
  if (req.url?.startsWith('/api/debug/replay') && req.method === 'GET') return handleReplay(req, res);
  return false;
}
