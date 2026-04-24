import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('aggregateSession integration: parallel fixture produces shaped output', async () => {
  const { aggregateSession } = await import('../lib/stats.js');
  const out = await aggregateSession({
    sessionLogPath: join(__dirname, 'fixtures', 'parallel-two-teams.jsonl'),
    hooksLogPath: join(__dirname, 'fixtures', 'hooks.log.parallel-teams'),
    sessionId: 'integration-test',
  });
  assert.ok(out.summary);
  assert.ok(out.phases.length > 0);
  assert.equal(out.teams.length, 2);
  assert.ok(Array.isArray(out.topAgents));
  assert.ok(Array.isArray(out.topToolCalls));
  assert.ok(Array.isArray(out.hooks));
  assert.ok(Array.isArray(out.errors));
  assert.ok(Array.isArray(out.retries));
});
