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
  // timeBreakdown now reports workMs (sum of child tool_use durations), not
  // wall-clock durationMs. The fixture has no tool_uses so workMs == 0; we
  // assert only that the entries exist in the breakdown.
  const tb = out.summary.timeBreakdown;
  assert.ok(tb.find((r) => r.agent === 'orchestrator'));
  assert.ok(tb.find((r) => r.agent === 'developer'));
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

test('aggregateSession: tool durations come from tool_use_id → tool_result pairing', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('tool-timings-with-gaps.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-gaps',
  });
  const read = out.phases[0].children.find((c) => c.kind === 'tool_use' && c.tool === 'Read');
  assert.equal(read.durationMs, 500);
  assert.equal(read.isApprox, false);
  const bashFast = out.phases[0].children.find((c) => c.kind === 'tool_use' && c.tool === 'Bash' && c.durationMs === 200);
  assert.ok(bashFast);
  // batched Grep tool_uses share the same assistant-message ts but have separate results
  const greps = out.phases[0].children.filter((c) => c.kind === 'tool_use' && c.tool === 'Grep');
  assert.equal(greps.length, 2);
  assert.deepEqual(greps.map((g) => g.durationMs).sort((a, b) => a - b), [250, 450]);
});

test('aggregateSession: attaches thinking/text preview to stream_gap rows when available', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('tool-timings-with-gaps.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-gaps',
  });
  const processing = out.phases[0].children.filter((c) => c.kind === 'stream_gap');
  const withPreview = processing.find((p) => p.preview);
  assert.ok(withPreview, 'expected at least one stream_gap row with preview');
  assert.match(withPreview.preview, /export const foo|list \/tmp/i);
  // Gap buffer resets after each tool_use, so a subsequent gap with no intervening
  // thinking/text block must have preview === null.
  const withoutPreview = processing.find((p) => !p.preview);
  assert.ok(withoutPreview, 'expected at least one stream_gap row without preview');
});

test('aggregateSession: inserts stream_gap rows for gaps ≥ threshold, not within a tool_use batch', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('tool-timings-with-gaps.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-gaps',
  });
  const gaps = out.phases[0].children.filter((c) => c.kind === 'stream_gap');
  // Two gaps meet the threshold: ~4500ms (Read→Bash) and ~1200ms (Grep batch→slow Bash).
  // The 150ms gap between Bash→Grep batch is below the threshold, and the gap between the two
  // batched Greps is zero (they share the same assistant-message timestamp) — neither should appear.
  assert.equal(gaps.length, 2);
  const durs = gaps.map((p) => p.durationMs).sort((a, b) => a - b);
  assert.equal(durs[0], 1200);
  assert.equal(durs[1], 4500);
});

test('aggregateSession: stream_gap carries eventsDuringGap count (strict between boundaries)', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('tool-timings-with-gaps.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-gaps',
  });
  const gaps = out.phases[0].children.filter((c) => c.kind === 'stream_gap');
  // The 4.5s Read→Bash gap contains one assistant thinking message (the preview source) — 1 event.
  const activeGap = gaps.find((g) => g.durationMs === 4500);
  assert.equal(activeGap.eventsDuringGap, 1);
  assert.ok(activeGap.preview, 'active gap should have preview');
  // The 1.2s Grep→slow-Bash gap has no intervening events — 0 events, no preview.
  const silentGap = gaps.find((g) => g.durationMs === 1200);
  assert.equal(silentGap.eventsDuringGap, 0);
  assert.equal(silentGap.preview, null);
});

test('aggregateSession: topToolCalls flags ops >30s as flaggedSlow (real tool_result durations)', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('tool-timings-with-gaps.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-gaps',
  });
  const slow = out.topToolCalls.filter((c) => c.flaggedSlow);
  assert.equal(slow.length, 1);
  assert.equal(slow[0].tool, 'Bash');
  assert.ok(slow[0].durationMs >= 30000);
});

test('aggregateSession: orchestrator duration uses interval-union over parallel agents', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-parallel',
  });
  const orch = out.phases.find((p) => p.kind === 'orchestrator');
  // Sanity: agents overlap (TASK-003/004 dispatched within ~1s, then parallel reviews),
  // so sum(agentDurations) >> totalMs. The old totalMs - sum formula would clamp to 0.
  // Interval-union yields a small but positive orchestrator window covering the bits between dispatches.
  assert.ok(orch.durationMs > 0, `orchestrator durationMs should be > 0, got ${orch.durationMs}`);
  assert.ok(orch.durationMs < out.durationMs);
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

test('aggregateSession: aggregates skills and rules', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('skills-rules.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-sr',
  });
  assert.equal(out.skills.length, 1);
  assert.equal(out.skills[0].skill, 'superpowers:test-driven-development');
  assert.equal(out.skills[0].count, 2);
  assert.equal(out.rules.length, 1);
  assert.equal(out.rules[0].ruleFile, 'agent-output-format.md');
  assert.equal(out.rules[0].reads, 2);
});

test('aggregateSession: detects (retry) suffix retries', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: fx('hooks.log.parallel-teams'),
    sessionId: 'sess-parallel',
  });
  const retries = out.retries.filter((r) => r.matchMethod === 'suffix-parens-retry');
  assert.ok(retries.length >= 1);
  assert.ok(retries.find((r) => /TASK-004/.test(r.description)));
});

test('aggregateSession: summary error/retry counts match arrays', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: fx('hooks.log.parallel-teams'),
    sessionId: 'sess-parallel',
  });
  assert.equal(out.summary.errorsCount, out.errors.length);
  assert.equal(out.summary.retriesCount, out.retries.length);
});

test('aggregateSession: blocking hooks EXIT=2 are NOT errors', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: fx('hooks.log.parallel-teams'),
    sessionId: 'sess-parallel',
  });
  const blocked = ['block-bash-file-write.sh','block-bash-validation.sh','circuit-breaker.sh','silent-mode-check.sh'];
  for (const e of out.errors) {
    if (e.kind !== 'hook_failed') continue;
    assert.ok(!blocked.includes(e.payload?.hookName));
  }
});

test('phases group multiple task_started for the same task_id (SendMessage resume)', async () => {
  const result = await aggregateSession({
    sessionLogPath: fx('sendmessage-resume.jsonl'),
    hooksLogPath: '/dev/null',
    sessionId: 'fixture-resume',
  });
  const agentPhases = result.phases.filter((p) => p.kind === 'agent');
  const devPhases = agentPhases.filter((p) => p.agentType === 'developer');
  assert.equal(devPhases.length, 1, 'should have a single developer phase');
  const unknown = agentPhases.filter((p) => p.agentType === 'unknown');
  assert.equal(unknown.length, 0, 'no unknown phases');
  assert.ok((devPhases[0].activations || []).length >= 2, 'developer should have >=2 activations');
});
