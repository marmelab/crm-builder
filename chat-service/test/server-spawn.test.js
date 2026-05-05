import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildSpawnEnv } from '../lib/spawn-env.js';

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
