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

test('aggregateSession: extracts agent phases and links to team via Agent tool_use_id', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('single-team-single-ticket.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-single',
  });
  assert.equal(out.teams.length, 1);
  assert.equal(out.teams[0].team_name, 'ticket-TASK-100');
  assert.equal(out.teams[0].description, 'Add X feature');
  assert.equal(out.teams[0].agentsCount, 2);
  assert.equal(out.summary.agentsCount, 2);
  assert.equal(out.phases.length, 3);
  const orch = out.phases.find((p) => p.kind === 'orchestrator');
  assert.ok(orch);
  assert.equal(orch.teamName, null);
  const dev = out.phases.find((p) => p.description === 'Implement TASK-100');
  assert.equal(dev.agentType, 'developer');
  assert.equal(dev.teamName, 'ticket-TASK-100');
  assert.equal(dev.durationMs, 6900);
  const tb = out.summary.timeBreakdown;
  assert.ok(tb.find((r) => r.agent === 'orchestrator'));
  assert.ok(tb.find((r) => r.agent === 'developer' && r.ms === 6900));
});

test('aggregateSession: parallel-two-teams fixture has correct team assignments', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-parallel',
  });
  const teamNames = out.teams.map((t) => t.team_name).sort();
  assert.deepEqual(teamNames, ['ticket-TASK-003', 'ticket-TASK-004']);
  const t003 = out.phases.filter((p) => p.kind === 'agent' && /TASK-003/.test(p.description));
  assert.ok(t003.length >= 3);
  for (const p of t003) assert.equal(p.teamName, 'ticket-TASK-003');
  const bootstrap = out.phases.find((p) => p.description === 'Bootstrap project context');
  assert.equal(bootstrap.teamName, null);
});

test('aggregateSession: orchestrator phase children exclude Agent/Task/Team* dispatches', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('single-team-single-ticket.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-single',
  });
  const orch = out.phases.find((p) => p.kind === 'orchestrator');
  assert.equal(orch.children.filter((c) => c.kind === 'tool_use').length, 0);
});

test('aggregateSession: toolCounts ordered by count desc', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('simple-quick-edit.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-simple',
  });
  assert.equal(out.toolCounts.length, 2);
  const names = out.toolCounts.map((t) => t.tool).sort();
  assert.deepEqual(names, ['Edit', 'Read']);
  for (const t of out.toolCounts) assert.equal(t.count, 1);
});

test('aggregateSession: topAgents sorted by durationMs desc', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-parallel',
  });
  assert.ok(out.topAgents.length > 0 && out.topAgents.length <= 5);
  for (let i = 1; i < out.topAgents.length; i++) {
    assert.ok(out.topAgents[i - 1].durationMs >= out.topAgents[i].durationMs);
  }
});

test('aggregateSession: topToolCalls flags ops >30s as flaggedSlow', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: fx('hooks.log.parallel-teams'),
    sessionId: 'sess-parallel',
  });
  assert.ok(out.topToolCalls.filter((c) => c.flaggedSlow).length >= 1);
});

test('aggregateSession: correlates hooks.log with session window (single-team)', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('single-team-single-ticket.jsonl'),
    hooksLogPath: fx('hooks.log.single-team'),
    sessionId: 'sess-single',
  });
  const typecheck = out.hooks.find((h) => h.hookName === 'typecheck-on-commit.sh');
  assert.ok(typecheck);
  assert.equal(typecheck.runs, 1);
  assert.equal(typecheck.okCount, 1);
  assert.equal(typecheck.failCount, 0);
  assert.equal(typecheck.blocking, false);
  const unitFn = out.hooks.find((h) => h.hookName === 'run-unit-tests-functions.sh');
  assert.ok(unitFn);
  assert.equal(unitFn.skipCount, 1);
});

test('aggregateSession: blocking hooks marked blocking=true (parallel fixture)', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: fx('hooks.log.parallel-teams'),
    sessionId: 'sess-parallel',
  });
  const allowed = ['block-bash-file-write.sh','block-bash-validation.sh','circuit-breaker.sh','silent-mode-check.sh'];
  for (const h of out.hooks) {
    if (h.blocking) assert.ok(allowed.includes(h.hookName));
  }
});
