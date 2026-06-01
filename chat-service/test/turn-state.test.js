import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideNextState } from '../lib/server/turn-state.js';
import { ALLOWED_STATES } from '../lib/server/config.js';

const base = { wasStopped: false, rateLimit: false, turnFailed: false, asksQuestion: false };

test('STOP wins over everything', () => {
  assert.equal(decideNextState({ ...base, wasStopped: true, rateLimit: true, turnFailed: true }), 'cancelled');
});

test('rate limit settles on rate_limited', () => {
  assert.equal(decideNextState({ ...base, rateLimit: true, turnFailed: true }), 'rate_limited');
});

test('a plain error (no rate limit) settles on error', () => {
  assert.equal(decideNextState({ ...base, turnFailed: true }), 'error');
});

test('a clean exit with no text is not a failure — settles on completed', () => {
  // !receivedText alone is not turnFailed: a turn that only ran tool calls
  // completes silently rather than surfacing a resumable 'error' bubble.
  assert.equal(decideNextState(base), 'completed');
});

test('a trailing question settles on waiting', () => {
  assert.equal(decideNextState({ ...base, asksQuestion: true }), 'waiting');
});

test('a clean turn settles on completed', () => {
  assert.equal(decideNextState(base), 'completed');
});

test('error takes precedence over a stale asksQuestion', () => {
  // The caller gates asksQuestion on !turnErrored, but the helper must still be
  // safe if both are passed — error must not be masked by waiting.
  assert.equal(decideNextState({ ...base, turnFailed: true, asksQuestion: true }), 'error');
});

test('error is an allowed (persistable) state', () => {
  assert.ok(ALLOWED_STATES.has('error'));
});
