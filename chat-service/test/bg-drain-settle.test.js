import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldSettleDrain, applyCumulativeUsage } from '../lib/server/turn.js';
import { emptyBreakdown } from '../lib/stats/io.js';

// Mirror the live constant (turn.js: HEARTBEAT_DRAIN_QUIET_TICKS = 12).
const QUIET_TICKS = 12;
const MAX_MS = 3 * 60 * 1000;

// Drive shouldSettleDrain across N ticks the way startBgDriver's drain branch
// does: feed the per-tick signals, fold the decision back into `state`.
function runDrain(state, ticks) {
  let settledAt = null;
  let reason = null;
  for (let i = 0; i < ticks.length; i++) {
    const dec = shouldSettleDrain(state, ticks[i]);
    state.drainQuiet = dec.drainQuiet;
    state.prevDrainSig = dec.prevDrainSig;
    if (dec.settle && settledAt == null) { settledAt = i; reason = dec.reason; }
  }
  return { settledAt, reason };
}

test('REGRESSION: nudge echoes (bgResultCount climbing) do NOT keep the drain alive — settles after the quiet threshold', () => {
  // The bug: each tick the heartbeat nudges → orchestrator emits an EMPTY
  // background_result → bgResultCount++. The old code keyed quiet on
  // bgResultCount, so quiet reset every tick and the wave never settled.
  // Now quiet is keyed on REAL progress (pendingSig change / new text), so a
  // climbing bgResultCount with no new text MUST let drainQuiet reach threshold.
  const state = { drainQuiet: 0, prevDrainSig: 'all-merged', drainSince: 1000 };
  let bgResultCount = 100;            // simulate the nudge-echo counter
  const ticks = [];
  for (let i = 0; i < QUIET_TICKS + 2; i++) {
    bgResultCount += 1;               // climbs every tick (the poison signal)
    ticks.push({ pendingSig: 'all-merged', sawProgress: false, nowMs: 1000 + i * 6000 });
  }
  const { settledAt, reason } = runDrain(state, ticks);
  assert.notEqual(settledAt, null, 'drain must settle despite bgResultCount climbing');
  assert.equal(reason, 'quiet');
  assert.equal(settledAt, QUIET_TICKS - 1, 'settles exactly when drainQuiet hits the threshold');
});

test('new orchestrator text during drain resets the quiet counter (keeps waiting)', () => {
  const state = { drainQuiet: 0, prevDrainSig: 'all-merged', drainSince: 1000 };
  // 5 quiet ticks, then real text, then we should NOT have settled yet.
  const ticks = [];
  for (let i = 0; i < 5; i++) ticks.push({ pendingSig: 'all-merged', sawProgress: false, nowMs: 1000 + i * 6000 });
  ticks.push({ pendingSig: 'all-merged', sawProgress: true, nowMs: 1000 + 5 * 6000 });   // recap text lands
  const { settledAt } = runDrain(state, ticks);
  assert.equal(settledAt, null, 'must not settle while the orchestrator is still emitting recap text');
  assert.equal(state.drainQuiet, 0, 'real text reset the quiet counter');
});

test('a late merge (pendingSig change) during drain resets the quiet counter', () => {
  const state = { drainQuiet: 0, prevDrainSig: 'sig-A', drainSince: 1000 };
  const ticks = [];
  for (let i = 0; i < 5; i++) ticks.push({ pendingSig: 'sig-A', sawProgress: false, nowMs: 1000 + i * 6000 });
  ticks.push({ pendingSig: 'sig-B', sawProgress: false, nowMs: 1000 + 5 * 6000 });   // a merge changed the set
  const { settledAt } = runDrain(state, ticks);
  assert.equal(settledAt, null);
  assert.equal(state.drainQuiet, 0, 'a pendingSig change reset the quiet counter');
});

test('wall-clock cap force-settles even if the quiet signal never reaches threshold', () => {
  // Pathological: progress reported every tick (quiet never climbs), but the
  // drain has run past HEARTBEAT_DRAIN_MAX_MS — the cap must settle it anyway.
  const start = 1000;
  const state = { drainQuiet: 0, prevDrainSig: 'all-merged', drainSince: start };
  const ticks = [];
  // Every tick claims progress so the quiet path can never fire.
  for (let i = 0; i < 40; i++) {
    ticks.push({ pendingSig: `sig-${i}`, sawProgress: true, nowMs: start + (i + 1) * 6000 });
  }
  const { settledAt, reason } = runDrain(state, ticks);
  assert.notEqual(settledAt, null, 'wall-clock cap must force a settle');
  assert.equal(reason, 'cap');
  // First tick whose nowMs - drainSince >= MAX_MS.
  const expectedTick = Math.ceil(MAX_MS / 6000) - 1;
  assert.equal(settledAt, expectedTick);
});

test('cap does not fire early (within the window) when there is genuine progress', () => {
  const start = 1000;
  const state = { drainQuiet: 0, prevDrainSig: 'all-merged', drainSince: start };
  // Half the window, all progress → should not settle.
  const ticks = [];
  for (let i = 0; i < 10; i++) {
    ticks.push({ pendingSig: `sig-${i}`, sawProgress: true, nowMs: start + (i + 1) * 6000 });
  }
  assert.ok(start + 10 * 6000 - start < MAX_MS, 'sanity: still inside the window');
  const { settledAt } = runDrain(state, ticks);
  assert.equal(settledAt, null);
});

// ── applyCumulativeUsage: live header = deduped cumulative (single source) ──
function freshStats() {
  return {
    tokensUsed: 0, tokensBreakdown: emptyBreakdown(),
    tokensBreakdownCurrentSpawn: { input: 1, cacheCreate: 1, output: 1, cacheRead: 1 },
    tokensByModel: [], tokensByModelCurrentSpawn: new Map([['x', {}]]),
    costUsd: 0, costUsdCurrentSpawn: 7,
  };
}

test('applyCumulativeUsage: sets cumulative stats from the watcher and zeroes *CurrentSpawn', () => {
  const runtime = { stats: freshStats() };
  // Deduped cumulative modelUsage (camelCase) — as cumulativeUsage() returns.
  applyCumulativeUsage(runtime, {
    'claude-opus-4-8': { inputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1_000_000 },
  });
  // cost = costFromBreakdown over the WHOLE cumulative ($5/M in + $25/M out = $30).
  assert.equal(runtime.stats.costUsd, 30);
  assert.deepEqual(runtime.stats.tokensBreakdown, { input: 1_000_000, cacheCreate: 0, output: 1_000_000, cacheRead: 0 });
  assert.equal(runtime.stats.tokensByModel.length, 1);
  assert.equal(runtime.stats.tokensByModel[0].model, 'claude-opus-4-8');
  // *CurrentSpawn must be cleared so sendStats (which adds them) reports exactly
  // the cumulative — not cumulative + a stale in-flight snapshot (the old inflation).
  assert.deepEqual(runtime.stats.tokensBreakdownCurrentSpawn, emptyBreakdown());
  assert.equal(runtime.stats.costUsdCurrentSpawn, 0);
  assert.equal(runtime.stats.tokensByModelCurrentSpawn.size, 0);
});

test('applyCumulativeUsage: REPLACES (not adds) on each call — header tracks cumulative, never inflates', () => {
  const runtime = { stats: freshStats() };
  const mu = (out) => ({ 'claude-opus-4-8': { inputTokens: 0, outputTokens: out } });
  applyCumulativeUsage(runtime, mu(1_000_000)); // cumulative so far
  const after1 = runtime.stats.costUsd;
  applyCumulativeUsage(runtime, mu(2_000_000)); // grown cumulative (NOT a delta)
  // Replace semantics: the second call reflects the new cumulative ($50), not
  // $25 + $50. This is the fix for summing per-spawn snapshots ($24.94 bug).
  assert.equal(after1, 25);
  assert.equal(runtime.stats.costUsd, 50);
});

test('applyCumulativeUsage: empty usage is a no-op (keeps digest-seeded values)', () => {
  const runtime = { stats: { ...freshStats(), costUsd: 12.5, tokensByModel: [{ model: 'seed', breakdown: emptyBreakdown(), costUsd: 12.5 }] } };
  applyCumulativeUsage(runtime, {});
  applyCumulativeUsage(runtime, null);
  assert.equal(runtime.stats.costUsd, 12.5, 'seeded digest value preserved when watcher has nothing');
});
