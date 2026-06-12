import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aggregateSession } from '../lib/stats.js';
import {
  computeSummary, tokensFromModelUsage,
  breakdownFromModelUsage, breakdownFromUsage, sumBreakdown,
  costFromBreakdown, summarizeFromPhases,
} from '../lib/stats/io.js';

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
  // endTs takes the last substantive event (debug_raw with the result),
  // ignoring the trailing client-noise `status` event at 03.100 — fixes a
  // bug where reconnect-time noise inflated session duration by 30+ min.
  assert.equal(out.startTs, '2026-04-23T12:00:00.000Z');
  assert.equal(out.endTs, '2026-04-23T12:00:03.000Z');
  assert.equal(out.durationMs, 3000);
  assert.equal(out.summary.totalMs, 3000);
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

test('aggregateSession: orchestrator phase children include Agent/Task/Team* dispatches', async () => {
  // Dispatch-control tool calls (Agent, TeamCreate, TeamDelete) are now kept
  // in the orchestrator timeline so the gap between planner reply and first
  // GO is explained — they used to be skipped, leaving an unexplained ~2 min
  // dead zone in the chronology.
  const out = await aggregateSession({
    sessionLogPath: fx('single-team-single-ticket.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-single',
  });
  const orch = out.phases.find((p) => p.kind === 'orchestrator');
  const toolNames = orch.children.filter((c) => c.kind === 'tool_use').map((c) => c.tool);
  assert.ok(toolNames.includes('Agent') || toolNames.includes('Task'),
    `expected Agent/Task in orchestrator children, got: ${toolNames.join(', ')}`);
  assert.ok(toolNames.includes('TeamCreate'),
    `expected TeamCreate in orchestrator children, got: ${toolNames.join(', ')}`);
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

// ----- computeSummary unit tests (multi-spawn cost + modelUsage tokens) -----

const r = (totalCostUsd, modelUsage = null, usage = { input_tokens: 1, output_tokens: 1 }) => ({
  type: 'debug_raw',
  event: { type: 'result', total_cost_usd: totalCostUsd, usage, ...(modelUsage ? { modelUsage } : {}) },
});

test('computeSummary: single spawn — costUsd is the spawn max, not the sum', () => {
  // total_cost_usd is cumulative within a spawn; summing all N result events
  // would over-count by N×. Take the final/max value.
  const events = [r(0.1), r(0.3), r(0.5), r(0.7)];
  const { costUsd } = computeSummary(events);
  assert.ok(Math.abs(costUsd - 0.7) < 1e-9);
});

test('computeSummary: multi-spawn — decrease in total_cost_usd marks a new spawn', () => {
  // Three spawns ending at 0.5, 0.3, 0.8 should sum to $1.60 (not $0.80,
  // which would be the global Math.max).
  const events = [
    r(0.2), r(0.5),            // spawn 1 max = 0.5
    r(0.1), r(0.3),            // spawn 2 max = 0.3 (decrease 0.5→0.1)
    r(0.05), r(0.4), r(0.8),   // spawn 3 max = 0.8 (decrease 0.3→0.05)
  ];
  const { costUsd } = computeSummary(events);
  assert.ok(Math.abs(costUsd - (0.5 + 0.3 + 0.8)) < 1e-9, `got $${costUsd}`);
});

test('computeSummary: tokens prefer modelUsage (cumulative) over result.usage (per-turn)', () => {
  // result.usage misses sub-agent tokens; modelUsage is cumulative-within-spawn
  // and includes ALL model calls. cache_read excluded from the displayed total.
  const events = [
    r(0.5, {
      'claude-sonnet-4-6': { inputTokens: 100, cacheCreationInputTokens: 200, cacheReadInputTokens: 99999, outputTokens: 50 },
      'claude-opus-4-6':   { inputTokens: 10,  cacheCreationInputTokens: 20,  cacheReadInputTokens: 99999, outputTokens: 5 },
    }),
  ];
  const { tokensTotal } = computeSummary(events);
  // 100+200+50 + 10+20+5 = 385
  assert.equal(tokensTotal, 385);
});

test('computeSummary: modelUsage is replaced per-result (cumulative), not summed', () => {
  // Multiple result events in one spawn report a growing cumulative modelUsage.
  // The LAST value is the spawn's final state, not the sum.
  const events = [
    r(0.1, { 'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 5 } }),
    r(0.3, { 'claude-sonnet-4-6': { inputTokens: 30, outputTokens: 20 } }),
    r(0.5, { 'claude-sonnet-4-6': { inputTokens: 50, outputTokens: 40 } }),
  ];
  const { tokensTotal } = computeSummary(events);
  assert.equal(tokensTotal, 90, 'should be 50+40 (last cumulative), not 10+5+30+20+50+40');
});

test('computeSummary: modelUsage tokens sum correctly across multiple spawns', () => {
  // Two spawns, each ending with its own cumulative modelUsage.
  const events = [
    r(0.5, { 'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50 } }),  // spawn 1 final
    r(0.1, { 'claude-sonnet-4-6': { inputTokens: 20,  outputTokens: 10 } }),  // spawn 2 starts (decrease)
    r(0.3, { 'claude-sonnet-4-6': { inputTokens: 60,  outputTokens: 30 } }),  // spawn 2 final
  ];
  const { tokensTotal, costUsd } = computeSummary(events);
  assert.equal(tokensTotal, 150 + 90, '(100+50) + (60+30) = 240');
  assert.ok(Math.abs(costUsd - 0.8) < 1e-9, '0.5 + 0.3 = 0.8');
});

test('computeSummary: falls back to result.usage when no modelUsage is present', () => {
  // Legacy fixtures and synthetic test data have no modelUsage — fall back
  // to summing per-turn result.usage so existing tests keep working.
  const events = [
    r(0.5, null, { input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 25, cache_read_input_tokens: 99999 }),
    r(0.7, null, { input_tokens: 200, cache_creation_input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 99999 }),
  ];
  const { tokensTotal } = computeSummary(events);
  assert.equal(tokensTotal, 100 + 50 + 25 + 200 + 100 + 50, 'sum of in+cc+out across both results, cache_read excluded');
});

test('tokensFromModelUsage: excludes cache_read', () => {
  const t = tokensFromModelUsage({
    'claude-opus-4-6': { inputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 1000, outputTokens: 5 },
  });
  assert.equal(t, 35);
});

test('tokensFromModelUsage: handles empty/null', () => {
  assert.equal(tokensFromModelUsage(null), 0);
  assert.equal(tokensFromModelUsage(undefined), 0);
  assert.equal(tokensFromModelUsage({}), 0);
});

// ----- Token breakdown + user_message spawn boundary -----

test('breakdownFromModelUsage: sums input/cacheCreate/output/cacheRead across models', () => {
  const b = breakdownFromModelUsage({
    'claude-sonnet-4-6': { inputTokens: 100, cacheCreationInputTokens: 200, cacheReadInputTokens: 1000, outputTokens: 50 },
    'claude-opus-4-6':   { inputTokens: 10,  cacheCreationInputTokens: 20,  cacheReadInputTokens: 100,  outputTokens: 5 },
  });
  assert.deepEqual(b, { input: 110, cacheCreate: 220, output: 55, cacheRead: 1100 });
  assert.equal(sumBreakdown(b), 1485);
});

test('breakdownFromUsage: maps snake_case fields to breakdown shape', () => {
  const b = breakdownFromUsage({
    input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4,
  });
  assert.deepEqual(b, { input: 1, cacheCreate: 2, output: 4, cacheRead: 3 });
});

test('computeSummary: returns tokensBreakdown alongside tokensTotal', () => {
  const events = [{
    type: 'debug_raw',
    event: {
      type: 'result',
      total_cost_usd: 0.5,
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 100, cacheCreationInputTokens: 200, cacheReadInputTokens: 9999, outputTokens: 50 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }];
  const { tokensTotal, tokensBreakdown } = computeSummary(events);
  // Legacy headline excludes cache_read.
  assert.equal(tokensTotal, 350);
  assert.deepEqual(tokensBreakdown, { input: 100, cacheCreate: 200, output: 50, cacheRead: 9999 });
});

test('computeSummary: user_message events mark spawn boundaries (regression: cost-decrease heuristic absorbed small spawns)', () => {
  // Real-world scenario observed on session d0ebd234: 4 user messages,
  // spawn 3 max cost = $0.05, spawn 4 max cost = $11.46. With the old
  // cost-decrease heuristic, spawn 4's first result ($3.27 > $0.05) failed
  // to trigger a boundary commit, swallowing spawn 3's cost entirely. The
  // user_message boundary commits unconditionally, recovering it.
  const r = (ts, cost, modelUsage) => ({
    type: 'debug_raw', ts,
    event: { type: 'result', total_cost_usd: cost, modelUsage },
  });
  const um = (ts) => ({ type: 'user_message', ts, content: 'x' });
  const events = [
    um('2026-05-11T13:48:20Z'),
    r('2026-05-11T13:50:00Z', 11.5753, { 'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50 } }),
    um('2026-05-11T14:19:21Z'),
    r('2026-05-11T14:19:54Z', 0.1973,  { 'claude-sonnet-4-6': { inputTokens: 10,  outputTokens: 5 } }),
    um('2026-05-11T14:20:09Z'),
    r('2026-05-11T14:20:34Z', 0.0522,  { 'claude-sonnet-4-6': { inputTokens: 5,   outputTokens: 2 } }),
    um('2026-05-11T14:24:46Z'),
    r('2026-05-11T14:32:58Z', 3.2753,  { 'claude-sonnet-4-6': { inputTokens: 200, outputTokens: 100 } }),
    r('2026-05-11T14:47:21Z', 11.4629, { 'claude-sonnet-4-6': { inputTokens: 300, outputTokens: 150 } }),
  ];
  const { costUsd, tokensTotal } = computeSummary(events);
  const expectedCost = 11.5753 + 0.1973 + 0.0522 + 11.4629;
  assert.ok(Math.abs(costUsd - expectedCost) < 1e-9, `got $${costUsd}, expected $${expectedCost}`);
  // Tokens: spawn1=150, spawn2=15, spawn3=7, spawn4=450 → 622
  assert.equal(tokensTotal, 622);
});

test('computeSummary: tokensByModel sums per-model costUSD across spawns (SDK authoritative)', () => {
  // modelUsage[m].costUSD is the per-model cost the SDK has already computed.
  // Their sum within a result event equals total_cost_usd; across spawns, the
  // per-model committed costs should sum to summary.costUsd.
  const r = (ts, cost, modelUsage) => ({
    type: 'debug_raw', ts,
    event: { type: 'result', total_cost_usd: cost, modelUsage },
  });
  const um = (ts) => ({ type: 'user_message', ts, content: 'x' });
  const events = [
    um('2026-05-12T10:00:00Z'),
    r('2026-05-12T10:00:30Z', 0.50, {
      'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50, costUSD: 0.30 },
      'claude-opus-4-6':   { inputTokens: 10,  outputTokens: 5,  costUSD: 0.20 },
    }),
    um('2026-05-12T10:01:00Z'),
    r('2026-05-12T10:01:30Z', 0.10, {
      'claude-sonnet-4-6': { inputTokens: 20, outputTokens: 10, costUSD: 0.10 },
    }),
  ];
  const { costUsd, tokensByModel } = computeSummary(events);
  assert.ok(Math.abs(costUsd - 0.60) < 1e-9);
  const sumPerModel = tokensByModel.reduce((s, r) => s + r.costUsd, 0);
  assert.ok(Math.abs(sumPerModel - costUsd) < 1e-9,
    `per-model sum $${sumPerModel} should equal total $${costUsd}`);
  // Sonnet got two spawns (0.30 + 0.10), Opus got one (0.20).
  const sonnet = tokensByModel.find((r) => r.model === 'claude-sonnet-4-6');
  const opus   = tokensByModel.find((r) => r.model === 'claude-opus-4-6');
  assert.ok(Math.abs(sonnet.costUsd - 0.40) < 1e-9);
  assert.ok(Math.abs(opus.costUsd - 0.20) < 1e-9);
});

test('computeSummary: cost-decrease fallback still works when no user_message events present (legacy fixtures)', () => {
  // Synthetic event list (no user_message markers) — the multi-spawn test
  // higher up depends on this fallback path. Re-asserting here so the dual
  // path is locked in.
  const r = (cost) => ({ type: 'debug_raw', event: { type: 'result', total_cost_usd: cost } });
  const events = [r(0.2), r(0.5), r(0.1), r(0.3), r(0.05), r(0.4), r(0.8)];
  const { costUsd } = computeSummary(events);
  assert.ok(Math.abs(costUsd - 1.6) < 1e-9);
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

// ----- summarizeFromPhases: deduped single-source-of-truth summary -----

test('summarizeFromPhases: sums per-model deduped breakdowns; cost = Σ costFromBreakdown', () => {
  // Two phases, same model. The summary breakdown is the per-component sum and
  // the summary cost equals costFromBreakdown applied to that summed breakdown
  // (linear), which also equals the sum of the per-phase costs.
  const phases = [
    { tokensByModel: [{ model: 'claude-opus-4-8', breakdown: { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 0 } }] },
    { tokensByModel: [{ model: 'claude-opus-4-8', breakdown: { input: 0, cacheCreate: 0, cacheRead: 0, output: 1_000_000 } }] },
  ];
  const s = summarizeFromPhases(phases);
  assert.deepEqual(s.tokensBreakdown, { input: 1_000_000, cacheCreate: 0, output: 1_000_000, cacheRead: 0 });
  // Opus: $5/M input + $25/M output = $30.
  assert.equal(s.costUsd, 30);
  assert.equal(s.tokensByModel.length, 1);
  assert.equal(s.tokensByModel[0].costUsd, 30);
});

test('summarizeFromPhases: a message.id counted once per phase is counted once in the summary', () => {
  // The per-phase enrichment already dedups by message.id, so each phase
  // breakdown reflects unique messages. A repeated message.id across the
  // synthetic transcript would have been folded into ONE phase contribution;
  // summarizeFromPhases must not re-inflate it. Model the deduped result of two
  // phases — the second carries the SAME tokens a naive (non-deduped) summer
  // would have double-counted, but here it appears exactly once.
  const dedupedPerPhase = { input: 100, cacheCreate: 50, cacheRead: 200, output: 25 };
  const phases = [
    { tokensByModel: [{ model: 'claude-sonnet-4-6', breakdown: dedupedPerPhase }] },
  ];
  const once = summarizeFromPhases(phases);
  // Counting the same phase twice (the bug) would double every component.
  const twice = summarizeFromPhases([phases[0], phases[0]]);
  assert.deepEqual(once.tokensBreakdown, { input: 100, cacheCreate: 50, output: 25, cacheRead: 200 });
  assert.equal(twice.tokensBreakdown.input, 200);
  assert.ok(Math.abs(twice.costUsd - 2 * once.costUsd) < 1e-9);
});

test('aggregateSession: summary equals Σ phases (orchestrator + subagents) — no calibrate rescale', async () => {
  // After removing calibratePhaseCostsToSdk, the summary IS the sum of the
  // per-phase deduped breakdowns, so summary.costUsd === Σ phase.costUsd and
  // summary.tokensByModel === the per-model sum across phases, by construction.
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-parallel',
  });
  const phaseCost = out.phases.reduce((s, p) => s + (p.costUsd || 0), 0);
  assert.ok(Math.abs(out.summary.costUsd - phaseCost) < 1e-9,
    `summary $${out.summary.costUsd} should equal Σ phases $${phaseCost}`);
  // Per-model: summing each phase's per-model cost must match summary per model.
  const byModel = new Map();
  for (const p of out.phases) for (const r of p.tokensByModel || []) {
    byModel.set(r.model, (byModel.get(r.model) || 0) + (r.costUsd || 0));
  }
  for (const r of out.summary.tokensByModel) {
    assert.ok(Math.abs(r.costUsd - (byModel.get(r.model) || 0)) < 1e-9,
      `summary model ${r.model} $${r.costUsd} should equal Σ phases $${byModel.get(r.model)}`);
  }
});

test('costFromBreakdown: claude-opus-4-8 is priced at the Opus tier, not sonnet', () => {
  const b = { input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 1_000_000 };
  const opus48 = costFromBreakdown('claude-opus-4-8', b);
  const opus47 = costFromBreakdown('claude-opus-4-7', b);
  const sonnet = costFromBreakdown('claude-sonnet-4-6', b);
  // Opus 4.8 must match the existing Opus tier (4.7) exactly...
  assert.equal(opus48, opus47, 'opus-4-8 should equal opus-4-7 cost');
  // ...and must NOT silently fall back to the cheaper sonnet rate.
  assert.notEqual(opus48, sonnet, 'opus-4-8 must not be priced as sonnet');
  // Opus tier: $5/M input + $25/M output = $30 for this breakdown.
  assert.equal(opus48, 30);
});
