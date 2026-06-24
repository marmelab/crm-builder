import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPendingAsk, handleOrchestratorText } from '../lib/server/turn.js';

// Builds a fake runtime whose broadcast() (via ws-bus) lands in `sent`, with a
// session stub capturing setAsk + recorded assistant messages.
function fakeRuntime() {
  const sent = [];
  const asks = [];
  const recorded = [];
  const ws = { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) };
  return {
    sent, asks, recorded,
    runtime: {
      clients: [ws],
      session: {
        setAsk: async (p) => { asks.push(p); },
        recordMessage: async (role, content) => { recorded.push({ role, content }); },
        logWrite: () => {},
      },
    },
  };
}

const assistantEvent = (blocks) => ({ type: 'assistant', message: { content: blocks } });

async function dir() { return mkdtemp(join(tmpdir(), 'ask-state-')); }
const exists = (p) => access(p).then(() => true, () => false);

test('consumes ask-state.json: broadcasts widget, persists, deletes file', async () => {
  const sessionDir = await dir();
  const file = join(sessionDir, 'ask-state.json');
  await writeFile(file, JSON.stringify({ kind: 'live-switch', header: 'Données', yes: 'Oui', no: 'Non' }));

  const { sent, asks, runtime } = fakeRuntime();
  const emitted = await applyPendingAsk(runtime, sessionDir);

  assert.equal(emitted, true, 'returns true so the caller counts it as turn output');
  const widget = sent.find((m) => m.type === 'satisfaction_ask');
  assert.ok(widget, 'a satisfaction_ask widget was broadcast');
  assert.equal(widget.kind, 'live-switch');
  assert.equal(widget.yes, 'Oui');
  assert.deepEqual(asks, [{ kind: 'live-switch', header: 'Données', body: undefined, yes: 'Oui', no: 'Non' }]);
  assert.equal(await exists(file), false, 'signal file consumed (deleted)');
});

test('no file → no-op (no widget, no throw)', async () => {
  const sessionDir = await dir();
  const { sent, runtime } = fakeRuntime();
  const emitted = await applyPendingAsk(runtime, sessionDir); // must not throw
  assert.equal(emitted, false, 'no file → returns false');
  assert.equal(sent.filter((m) => m.type === 'satisfaction_ask').length, 0);
});

test('a turn that writes ask-state.json has its plain text suppressed (no duplicate)', () => {
  const { sent, recorded, runtime } = fakeRuntime();
  const ctx = { lastText: '' };
  // The orchestrator prints the question AND writes the cartouche in one reply.
  const emitted = handleOrchestratorText(runtime, assistantEvent([
    { type: 'text', text: 'Tout te convient, ou je dois ajuster quelque chose ?' },
    { type: 'tool_use', name: 'Write', input: { file_path: '/chat-service/logs/x/ask-state.json', content: '{}' } },
  ]), ctx);
  assert.equal(emitted, true, 'counts as turn output so the turn is not flagged failed');
  assert.equal(sent.filter((m) => m.type === 'message').length, 0, 'plain text NOT broadcast');
  assert.equal(recorded.length, 0, 'plain text NOT recorded (clean history/reconnect)');
  assert.equal(runtime.askWriteSeen, true, 'latched for the rest of the turn');
});

test('a normal turn (no ask-state write) broadcasts its text as usual', () => {
  const { sent, runtime } = fakeRuntime();
  handleOrchestratorText(runtime, assistantEvent([{ type: 'text', text: 'Done, take a look.' }]), { lastText: '' });
  assert.equal(sent.filter((m) => m.type === 'message').length, 1, 'normal text still broadcast');
});

test('malformed file is still consumed but emits nothing', async () => {
  const sessionDir = await dir();
  const file = join(sessionDir, 'ask-state.json');
  await writeFile(file, 'garbage{');

  const { sent, runtime } = fakeRuntime();
  await applyPendingAsk(runtime, sessionDir);

  assert.equal(sent.filter((m) => m.type === 'satisfaction_ask').length, 0, 'no widget for garbage');
  assert.equal(await exists(file), false, 'garbage file still consumed so it cannot replay');
});
