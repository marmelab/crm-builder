import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleIdleTeardown, cancelIdleTeardown, runtimes } from '../lib/server/runtime.js';

function fakeRuntime(id) {
  let closed = false;
  let killed = false;
  const runtime = {
    session: { id, meta: {}, close: async () => { closed = true; } },
    clients: new Set(),
    busy: false,
    ptySession: { closed: false, kill: () => { killed = true; } },
    subagentTailerStop: null,
    idleTimer: null,
    tearingDown: false,
  };
  return { runtime, wasClosed: () => closed, wasKilled: () => killed };
}

test('idle teardown kills the PTY and releases the runtime after the delay', async () => {
  const { runtime, wasClosed, wasKilled } = fakeRuntime('idle-1');
  runtimes.set('idle-1', runtime);
  scheduleIdleTeardown(runtime, { delayMs: 20 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(wasKilled(), true);
  assert.equal(wasClosed(), true);
  assert.equal(runtime.tearingDown, true);
  assert.equal(runtimes.has('idle-1'), false);
});

test('idle teardown is cancelled by cancelIdleTeardown', async () => {
  const { runtime, wasKilled } = fakeRuntime('idle-2');
  runtimes.set('idle-2', runtime);
  scheduleIdleTeardown(runtime, { delayMs: 20 });
  cancelIdleTeardown(runtime);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(wasKilled(), false);
  assert.equal(runtimes.has('idle-2'), true);
  runtimes.delete('idle-2');
});

test('idle teardown aborts when a client reconnected or a turn is running', async () => {
  const { runtime, wasKilled } = fakeRuntime('idle-3');
  runtimes.set('idle-3', runtime);
  scheduleIdleTeardown(runtime, { delayMs: 20 });
  runtime.clients.add({});                      // client reconnected in the gap
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(wasKilled(), false);
  runtimes.delete('idle-3');
});
