import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideNextState, turnFailedFrom, isApiErrorStderr,
  isAuthErrorStderr, isNetworkErrorStderr,
} from '../lib/server/turn-state.js';
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

// --- turnFailedFrom: a finished-Claude turn fails only on a real API error ---
// PTY model: no process exit code. `sawResult` is the sole discriminator —
// a result seen ⇒ Claude finished; no result ⇒ it died mid-flight (failure).

test('a result is_error fails the turn', () => {
  assert.equal(turnFailedFrom({ resultError: true, sawResult: true }), true);
});

test('no result fails the turn (Claude died before completing — auth case)', () => {
  // Was: an auth signature on stderr with no result. In the PTY model the death
  // (!sawResult) is the failure; stderr only feeds friendlyError phrasing now.
  assert.equal(turnFailedFrom({ resultError: false, sawResult: false }), true);
});

test('no result fails the turn (Claude died before completing — network case)', () => {
  // Was: a network signature on stderr with no result. Same collapse: the lack
  // of a result is what fails it, regardless of buffer contents.
  assert.equal(turnFailedFrom({ resultError: false, sawResult: false }), true);
});

test('a blocking hook does NOT fail the turn — Claude finished (result seen)', () => {
  // The reported bug: a hook exits 2 / a tool fails, but the CLI still emits its
  // terminal result. The session must settle on 'completed', not the resumable
  // 'error' state.
  assert.equal(turnFailedFrom({ resultError: false, sawResult: true }), false);
});

test('a zombie-subagent kill after the result does NOT fail the turn', () => {
  // result was seen (Claude finished) but a zombie held the pipe and was killed.
  // Anything after the result is noise — the turn completed.
  assert.equal(turnFailedFrom({ resultError: false, sawResult: true }), false);
});

test('a crash mid-flight (no result) IS a failure — must stay resumable', () => {
  // Died before Claude finished: keep it a resumable 'error' so crash recovery
  // can rebuild state. Settling on 'completed' would strand an interrupted run.
  assert.equal(turnFailedFrom({ resultError: false, sawResult: false }), true);
});

test('a clean completion (result seen) does NOT fail', () => {
  assert.equal(turnFailedFrom({ resultError: false, sawResult: true }), false);
});

// Regression: once the `result` was seen, the turn never fails — buffer noise
// (CLI retry logging, forwarded tool/hook output containing 'network'/'401'/etc)
// must NOT flip a completed turn into the resumable 'error' state. stderr no
// longer participates in the verdict at all, so passing it is a no-op.
test('a stderr-like buffer does NOT fail a completed turn (result seen)', () => {
  assert.equal(turnFailedFrom({ resultError: false, stderr: 'network error, retrying...', sawResult: true }), false);
  assert.equal(turnFailedFrom({ resultError: false, stderr: '401 modules transformed', sawResult: true }), false);
});

test('isApiErrorStderr splits into auth vs network', () => {
  assert.ok(isAuthErrorStderr('401 unauthorized'));
  assert.ok(isNetworkErrorStderr('getaddrinfo ENOTFOUND api.anthropic.com'));
  assert.ok(isApiErrorStderr('authentication failed'));
  assert.equal(isApiErrorStderr('a regular tool error'), false);
  assert.equal(isApiErrorStderr(''), false);
  assert.equal(isApiErrorStderr(undefined), false);
});
