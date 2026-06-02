import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSpawnEnv } from '../lib/spawn-env.js';
import { rewriteUserMessage, buildRecoveryPrompt, planResume } from '../lib/server/claude-spawn.js';

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

test('buildRecoveryPrompt states the prior team is dead and forbids no-op', () => {
  const out = buildRecoveryPrompt('whatever');
  // The whole point: signal that nothing from the crashed process survives, so
  // the orchestrator re-evaluates real state instead of trusting its memory.
  assert.match(out, /dead/i);
  assert.match(out, /do not assume/i);
});

test('planResume after error uses a fresh session with a recovery prompt', () => {
  const original = 'Add a priority field to deals';
  const plan = planResume('error', original);
  assert.equal(plan.freshSession, true, 'error resume must drop --resume');
  assert.notEqual(plan.prompt, original, 'error resume must not replay the verbatim request');
  assert.match(plan.prompt, /<intent>recovery<\/intent>/);
});

test('planResume after rate limit replays the request verbatim under --resume', () => {
  const original = 'Add a priority field to deals';
  const plan = planResume('rate_limited', original);
  assert.equal(plan.freshSession, false, 'rate-limit resume legitimately continues the turn');
  assert.equal(plan.prompt, original, 'rate-limit resume replays the request unchanged');
});
