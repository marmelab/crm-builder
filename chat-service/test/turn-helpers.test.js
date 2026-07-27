import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSpawnEnv } from '../lib/spawn-env.js';
import { rewriteUserMessage, buildRecoveryPrompt, planResume } from '../lib/server/turn-helpers.js';

test('buildSpawnEnv injects CLAUDE_SESSION_ID', () => {
  const baseEnv = { PATH: '/usr/bin', HOME: '/home/x' };
  const result = buildSpawnEnv(baseEnv, 'eefd5f20-305b-4768-b47f-d9ff718c690a');
  assert.equal(result.CLAUDE_SESSION_ID, 'eefd5f20-305b-4768-b47f-d9ff718c690a');
  // Existing env preserved
  assert.equal(result.PATH, '/usr/bin');
  assert.equal(result.HOME, '/home/x');
});

test('buildSpawnEnv with empty session id leaves var unset', () => {
  const baseEnv = { PATH: '/usr/bin' };
  const result = buildSpawnEnv(baseEnv, '');
  assert.equal('CLAUDE_SESSION_ID' in result, false, 'should not set empty session id');
});

test('buildSpawnEnv with null session id leaves var unset', () => {
  const baseEnv = { PATH: '/usr/bin' };
  const result = buildSpawnEnv(baseEnv, null);
  assert.equal('CLAUDE_SESSION_ID' in result, false);
});

test('rewriteUserMessage rewrites FULL_SETUP into intent marker', () => {
  const out = rewriteUserMessage('FULL_SETUP');
  assert.match(out, /<intent>setup<\/intent>/);
  assert.match(out, /Define your business/);
});

test('rewriteUserMessage passes free text through unchanged', () => {
  const text = 'Add an Importance field on companies';
  assert.equal(rewriteUserMessage(text), text);
});

test('rewriteUserMessage does not match FULL_SETUP substring', () => {
  // Free-text mentions of the literal string should not be rewritten —
  // only the exact marker counts.
  const text = 'I want to do a FULL_SETUP, do I click somewhere?';
  assert.equal(rewriteUserMessage(text), text);
});

test('buildRecoveryPrompt carries the recovery intent marker', () => {
  const out = buildRecoveryPrompt('Add a priority field to deals');
  assert.match(out, /<intent>recovery<\/intent>/);
});

test('buildRecoveryPrompt embeds the original request for context', () => {
  const original = 'Add a priority field to deals';
  const out = buildRecoveryPrompt(original);
  assert.ok(out.includes(original), 'recovery prompt should quote the original request');
});

test('buildRecoveryPrompt delegates the procedure to STATE RECOVERY (single source of truth)', () => {
  const out = buildRecoveryPrompt('whatever');
  // The constraints/procedure live in STATE RECOVERY (orchestrator.md); the
  // directive only triggers it via the marker + points at it, no duplicated prose.
  assert.match(out, /STATE RECOVERY/);
});

test('planResume: error WITH a wave in flight uses a fresh recovery session', () => {
  const original = 'Add a priority field to deals';
  const plan = planResume('error', original, true);
  assert.equal(plan.freshSession, true, 'must drop --resume when a team was dispatched');
  assert.notEqual(plan.prompt, original, 'must not replay the verbatim request');
  assert.match(plan.prompt, /<intent>recovery<\/intent>/);
});

test('planResume: rate_limited WITH a wave in flight also recovers (same no-op risk as a crash)', () => {
  const original = 'Add a priority field to deals';
  const plan = planResume('rate_limited', original, true);
  assert.equal(plan.freshSession, true, 'a limit that struck mid-wave must not --resume the stale team belief');
  assert.match(plan.prompt, /<intent>recovery<\/intent>/);
});

test('planResume: process-killed but NO wave in flight resumes verbatim (preserve interview/SIMPLE context)', () => {
  const original = 'I sell bakery products';
  for (const state of ['error', 'rate_limited']) {
    const plan = planResume(state, original, false);
    assert.equal(plan.freshSession, false, `${state} without tickets must keep --resume`);
    assert.equal(plan.prompt, original, `${state} without tickets must replay unchanged`);
  }
});

test('planResume: a non-killed state never recovers, even with tickets present', () => {
  const original = 'Add a priority field to deals';
  const plan = planResume('completed', original, true);
  assert.equal(plan.freshSession, false);
  assert.equal(plan.prompt, original);
});
