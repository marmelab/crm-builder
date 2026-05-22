// Integration smoke test for session persistence + HTTP API.
// Boots server.js against a temp log dir and exercises create/list/resume/rename.
// Does NOT hit Claude — we only test the persistence layer + protocol.
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';

const LOG_DIR = await mkdtemp(join(tmpdir(), 'chat-smoke-'));
const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, CHAT_LOG_DIR: LOG_DIR, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));

async function waitReady() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/sessions`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

function wsConnect(query = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}${query}`);
    const events = [];
    ws.on('message', (d) => {
      try { events.push(JSON.parse(d.toString())); } catch {}
    });
    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
  });
}

async function waitFor(events, predicate, label, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label}; got: ${JSON.stringify(events.map((e) => e.type))}`);
}

try {
  await waitReady();

  // 1. New session: connect without query
  const { ws: ws1, events: e1 } = await wsConnect();
  const init1 = await waitFor(e1, (e) => e.type === 'init', 'init');
  assert.equal(init1.isNew, true, 'first connection is new');
  assert.ok(init1.sessionId, 'got a sessionId');
  assert.equal(init1.title, '');
  assert.deepEqual(init1.messages, []);
  const id1 = init1.sessionId;
  console.log(`✓ new session created: ${id1}`);

  // 2. Send a user message. Claude is not installed on the host, so the server
  //    will emit a friendly-error assistant message — we expect BOTH the user
  //    message and that error to be persisted.
  ws1.send(JSON.stringify({ content: 'Hello world from smoke test' }));
  // Wait for status:false → turn finished, then files are fully written.
  await waitFor(e1, (e) => e.type === 'status' && e.working === false, 'turn complete', 4000);
  // Read log.jsonl (single source of truth)
  const readLog = async () => {
    const raw = await readFile(join(LOG_DIR, id1, 'log.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const log1 = await readLog();
  const userMsgs = log1.filter((e) => e.dir === 'in' && e.type === 'user_message');
  assert.equal(userMsgs.length, 1, 'one user message logged');
  assert.equal(userMsgs[0].content, 'Hello world from smoke test');
  const meta1 = JSON.parse(await readFile(join(LOG_DIR, id1, 'meta.json'), 'utf8'));
  assert.equal(meta1.title, 'Hello world from smoke test', 'title auto-generated');
  assert.ok(meta1.lastMessageAt, 'lastMessageAt set');
  assert.ok(meta1.messageCount >= 1, 'messageCount incremented');
  // Claude's spawn failed (no binary on host), so the turn ends and state auto-
  // transitions back to 'completed'.
  assert.equal(meta1.state, 'completed', 'state auto → completed after turn');
  assert.equal(meta1.userMessageCount, 1, 'userMessageCount=1 after first message');
  console.log(`✓ user message persisted, title auto-generated, state auto→completed`);

  // 2b. Verify the client received the 'completed' transition
  const stateEvents = e1.filter((e) => e.type === 'state');
  assert.ok(stateEvents.some((e) => e.state === 'completed'), 'completed broadcast');
  console.log('✓ completed broadcast over WS at turn end');

  // 3. Choice with display label → saved as label
  ws1.send(JSON.stringify({ content: 'QUICK_EDIT', display: '⚡ Make a quick change' }));
  const lastStatusCount = e1.filter((e) => e.type === 'status' && e.working === false).length;
  await waitFor(e1,
    (e, i, arr) => e.type === 'status' && e.working === false && arr.filter((x) => x.type === 'status' && x.working === false).length > lastStatusCount,
    'second turn complete', 4000);
  const log1b = await readLog();
  const userMsgs1b = log1b.filter((e) => e.dir === 'in' && e.type === 'user_message');
  assert.equal(userMsgs1b.length, 2, 'two user messages now');
  assert.equal(userMsgs1b[1].content, 'QUICK_EDIT', 'raw ID kept in content');
  assert.equal(userMsgs1b[1].display, '⚡ Make a quick change', 'display label preserved');
  console.log('✓ choice label preserved (content=ID, display=label)');

  // 3b. Second message: state should have flipped in_progress → completed again
  const stateEvents2 = e1.filter((e) => e.type === 'state');
  assert.ok(stateEvents2.some((e) => e.state === 'in_progress'), 'in_progress rebroadcast on 2nd message');
  assert.ok(
    stateEvents2.filter((e) => e.state === 'completed').length >= 2,
    'completed broadcast twice (end of turn 1 and turn 2)'
  );
  console.log('✓ state auto-cycled in_progress → completed on relaunch');

  // 3c. 1st user message triggered a Haiku retitle, but claude binary is absent
  //     on the test host, so the title should remain the initial auto-title and
  //     titleAutoGenerated must NOT have been set.
  const metaAfter2nd = JSON.parse(await readFile(join(LOG_DIR, id1, 'meta.json'), 'utf8'));
  assert.equal(metaAfter2nd.userMessageCount, 2, 'userMessageCount=2 on 2nd msg');
  assert.ok(!metaAfter2nd.titleAutoGenerated, 'titleAutoGenerated stays false when haiku call fails');
  assert.equal(metaAfter2nd.title, 'Hello world from smoke test', 'title unchanged on haiku failure');
  console.log('✓ 1st user message attempted haiku retitle (no-op without claude binary)');

  ws1.close();
  await new Promise((r) => setTimeout(r, 100));

  // 4. List sessions
  const listRes = await fetch(`${BASE}/api/sessions`);
  const list = await listRes.json();
  assert.ok(Array.isArray(list));
  const found = list.find((d) => d.id === id1);
  assert.ok(found, 'session appears in list');
  assert.ok(found.messageCount >= 2, 'at least 2 messages');
  assert.equal(found.title, 'Hello world from smoke test');
  console.log(`✓ list returned ${list.length} session(s)`);

  // 5. Get one session — messages derived from log.jsonl on the fly
  const getRes = await fetch(`${BASE}/api/sessions/${id1}`);
  const one = await getRes.json();
  assert.equal(one.meta.id, id1);
  assert.ok(one.messages.length >= 2, 'messages derived from log.jsonl');
  // Verify display-label replaced the raw choice ID in the derived messages
  const displayedUser = one.messages.filter((m) => m.role === 'user');
  assert.equal(displayedUser[1].content, '⚡ Make a quick change');
  console.log('✓ GET /api/sessions/:id reconstructs messages from log');

  // 6. Rename
  const patchRes = await fetch(`${BASE}/api/sessions/${id1}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Renamed by smoke test' }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.title, 'Renamed by smoke test');
  const meta1Renamed = JSON.parse(await readFile(join(LOG_DIR, id1, 'meta.json'), 'utf8'));
  assert.equal(meta1Renamed.title, 'Renamed by smoke test');
  assert.equal(meta1Renamed.titleLocked, true, 'manual rename locks auto-regen');
  console.log('✓ rename persisted + titleLocked flag set');

  // 6b. PATCH with state is still accepted (kept for programmatic use)
  const stateRes = await fetch(`${BASE}/api/sessions/${id1}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'completed' }),
  });
  assert.equal(stateRes.status, 200);
  const stateMeta = await stateRes.json();
  assert.equal(stateMeta.state, 'completed');
  console.log('✓ PATCH state=completed still works');

  // 6c. Invalid state rejected
  const badState = await fetch(`${BASE}/api/sessions/${id1}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'unknown' }),
  });
  assert.equal(badState.status, 400);
  console.log('✓ invalid state → 400');

  // 7. Resume: reconnect with ?session=<id>
  const { ws: ws2, events: e2 } = await wsConnect(`?session=${id1}`);
  const init2 = await waitFor(e2, (e) => e.type === 'init', 'init on resume');
  assert.equal(init2.isNew, false, 'resume → isNew=false');
  assert.equal(init2.sessionId, id1);
  assert.equal(init2.title, 'Renamed by smoke test');
  assert.equal(init2.state, 'completed', 'state restored on resume');
  assert.ok(init2.messages.length >= 2, 'history restored');
  console.log('✓ resume works — history + state restored');
  ws2.close();

  // 8. Bogus session ID → should fall back to new session. Closing the WS
  //    without ever sending a user message must clean the empty session dir
  //    off disk (no point keeping a log-less folder that just pollutes /sessions).
  const { ws: ws3, events: e3 } = await wsConnect(`?session=not-a-uuid`);
  const init3 = await waitFor(e3, (e) => e.type === 'init', 'init on bogus id');
  assert.equal(init3.isNew, true, 'bogus id → new session');
  assert.notEqual(init3.sessionId, 'not-a-uuid');
  const orphanId = init3.sessionId;
  ws3.close();
  // Cleanup runs in the server's async close handler — poll briefly.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const dirs = await readdir(LOG_DIR);
    if (!dirs.includes(orphanId)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const dirsAfter = await readdir(LOG_DIR);
  assert.ok(!dirsAfter.includes(orphanId), 'empty session removed on disconnect');
  console.log('✓ invalid UUID → falls back to new session, empty session cleaned up on close');

  // 9. GET /api/sessions/:id on missing → 404
  const missingRes = await fetch(`${BASE}/api/sessions/00000000-0000-0000-0000-000000000000`);
  assert.equal(missingRes.status, 404);
  console.log('✓ missing session → 404');

  // 10. PATCH with empty body → 400
  const badPatch = await fetch(`${BASE}/api/sessions/${id1}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notitle: 'nope' }),
  });
  assert.equal(badPatch.status, 400);
  console.log('✓ PATCH without title or state → 400');

  // 11. Folder structure on disk — only log.jsonl + meta.json, no messages.json
  const dirs = await readdir(LOG_DIR);
  const sessionDirs = dirs.filter((d) => /^[0-9a-f-]{36}$/.test(d));
  assert.ok(sessionDirs.includes(id1), 'id1 folder present');
  const files = await readdir(join(LOG_DIR, id1));
  assert.ok(files.includes('log.jsonl'), 'log.jsonl present');
  assert.ok(files.includes('meta.json'), 'meta.json present');
  assert.ok(!files.includes('messages.json'), 'no messages.json');
  console.log('✓ folder structure: log.jsonl + meta.json only');

  console.log('\n🎉 all smoke tests passed');
} catch (err) {
  console.error('\n❌ smoke test failed:', err);
  process.exitCode = 1;
} finally {
  server.kill();
  await rm(LOG_DIR, { recursive: true, force: true }).catch(() => {});
}
