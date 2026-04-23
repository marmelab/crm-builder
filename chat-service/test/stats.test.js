import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aggregateSession } from '../lib/stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');
const fx = (name) => join(fixturesDir, name);

test('aggregateSession: empty session returns zeroed shape', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('empty-session.jsonl'),
    hooksLogPath: null,
    sessionId: '00000000-0000-0000-0000-000000000001',
  });
  assert.equal(out.sessionId, '00000000-0000-0000-0000-000000000001');
  assert.equal(out.phases.length, 0);
  assert.equal(out.teams.length, 0);
  assert.equal(out.summary.agentsCount, 0);
});

test('aggregateSession: skips malformed JSONL lines', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('malformed-lines.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-malformed',
  });
  assert.equal(out.sessionId, 'sess-malformed');
  // The fixture has 2 valid lines bracketing 1 malformed line. Skipping must
  // preserve the valid ones, so startTs/endTs come from the first/last valid line.
  assert.equal(out.startTs, '2026-04-23T14:00:00.000Z');
  assert.equal(out.endTs, '2026-04-23T14:00:01.000Z');
});

test('aggregateSession: computes summary totals from simple session', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('simple-quick-edit.jsonl'),
    hooksLogPath: null,
    sessionId: '00000000-0000-0000-0000-000000000002',
  });
  assert.equal(out.startTs, '2026-04-23T12:00:00.000Z');
  assert.equal(out.endTs, '2026-04-23T12:00:03.100Z');
  assert.equal(out.durationMs, 3100);
  assert.equal(out.summary.totalMs, 3100);
  assert.equal(out.summary.opsCount, 2);
  assert.equal(out.summary.tokensTotal, 100 + 200 + 50);
  assert.equal(out.summary.costUsd, 0.01);
});
