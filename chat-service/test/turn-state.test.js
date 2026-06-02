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

test('a result is_error fails the turn', () => {
  assert.equal(turnFailedFrom({ resultError: true, sawResult: true, exitCode: 1 }), true);
});

test('an auth signature on stderr fails the turn (API error killed the CLI)', () => {
  assert.equal(turnFailedFrom({ resultError: false, stderr: 'Error: invalid api key', sawResult: false, exitCode: 1 }), true);
});

test('a network signature on stderr fails the turn', () => {
  assert.equal(turnFailedFrom({ resultError: false, stderr: 'connect ECONNREFUSED 127.0.0.1', sawResult: false, exitCode: 1 }), true);
});

test('a blocking hook does NOT fail the turn — Claude finished (result seen), exit 0', () => {
  // The reported bug: a hook exits 2 / a tool fails, but the CLI still emits its
  // terminal result and exits 0. The session must settle on 'completed', not the
  // resumable 'error' state.
  assert.equal(
    turnFailedFrom({ resultError: false, stderr: 'validate-before-review: typecheck failed', sawResult: true, exitCode: 0 }),
    false,
  );
});

test('a zombie-subagent timeout kill after the result does NOT fail the turn', () => {
  // result was seen (Claude finished) but a zombie held the pipe → kill, exit 1.
  // Non-zero exit AFTER a result is not a failure.
  assert.equal(turnFailedFrom({ resultError: false, sawResult: true, exitCode: 1 }), false);
});

test('a crash mid-flight (no result, non-zero exit) IS a failure — must stay resumable', () => {
  // Killed before Claude finished: keep it a resumable 'error' so crash recovery
  // can rebuild state. Settling on 'completed' would strand an interrupted run.
  assert.equal(turnFailedFrom({ resultError: false, sawResult: false, exitCode: 137 }), true);
});

test('an internal exception (exitCode null, no result) IS a failure', () => {
  assert.equal(turnFailedFrom({ resultError: false, sawResult: false, exitCode: null }), true);
});

test('a clean completion (result seen, exit 0) does NOT fail', () => {
  assert.equal(turnFailedFrom({ resultError: false, sawResult: true, exitCode: 0 }), false);
});

// Regression: once the `result` was seen, a stderr signature is just noise and
// must NOT flip a completed turn into the resumable 'error' state. The spawn's
// stderr accumulates the whole turn (CLI retry logging, forwarded tool/hook
// output), so 'network'/'authentication'/'401' substrings are common on a
// successful run — they only count when the CLI died before emitting a result.
test('a stderr signature does NOT fail a completed turn (result seen, exit 0)', () => {
  assert.equal(turnFailedFrom({ resultError: false, stderr: 'network error, retrying...', sawResult: true, exitCode: 0 }), false);
  assert.equal(turnFailedFrom({ resultError: false, stderr: '401 modules transformed', sawResult: true, exitCode: 0 }), false);
});

test('a stderr signature still fails when the CLI died before a result (exit 0, no result)', () => {
  // The auth-killed-the-CLI case the gate must preserve: no result seen and an
  // auth signature on stderr, even if the exit code happened to come back 0.
  assert.equal(turnFailedFrom({ resultError: false, stderr: 'invalid api key', sawResult: false, exitCode: 0 }), true);
});

test('isApiErrorStderr splits into auth vs network', () => {
  assert.ok(isAuthErrorStderr('401 unauthorized'));
  assert.ok(isNetworkErrorStderr('getaddrinfo ENOTFOUND api.anthropic.com'));
  assert.ok(isApiErrorStderr('authentication failed'));
  assert.equal(isApiErrorStderr('a regular tool error'), false);
  assert.equal(isApiErrorStderr(''), false);
  assert.equal(isApiErrorStderr(undefined), false);
});
