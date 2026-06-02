import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPECTED_SECRETS } from '../lib/server/deploy-secrets-manifest.js';

test('EXPECTED_SECRETS is a non-empty array of unique upper-snake-case strings', () => {
  assert.ok(Array.isArray(EXPECTED_SECRETS));
  assert.ok(EXPECTED_SECRETS.length > 0);
  const seen = new Set();
  for (const k of EXPECTED_SECRETS) {
    assert.equal(typeof k, 'string');
    assert.match(k, /^[A-Z][A-Z0-9_]*$/);
    assert.ok(!seen.has(k), `duplicate secret name: ${k}`);
    seen.add(k);
  }
});
