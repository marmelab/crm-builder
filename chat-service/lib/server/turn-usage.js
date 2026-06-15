// Per-turn usage folding into the runtime's cumulative session stats.
// Shared by the active-turn finally (turn.js) and the background drain settle
// (bg-driver.js) so both paths produce the same downstream stats shape.
import {
  emptyBreakdown, addBreakdown, costFromBreakdown,
} from '../stats/io.js';

// Fold the just-finished spawn's `*CurrentSpawn` usage into the cumulative
// session stats, then reset the per-spawn accumulators. Run identically by the
// active-turn `finally` and by the background drain-completed branch, so both
// paths produce the same downstream stats shape.
// Replace the runtime's cumulative stats with the watcher's session-cumulative
// DEDUPED-by-message.id usage (camelCase modelUsage). This is the live single
// source of truth: it converges to the same per-message-id-deduped figure
// /api/stats reports, instead of summing per-spawn deltas (which double-count).
// Zeroes the *CurrentSpawn accumulators so sendStats (which adds them) reports
// exactly the cumulative. No-op when the watcher has no usage yet (keeps the
// digest-seeded values from runtime init). Exported for unit tests.
export function applyCumulativeUsage(runtime, modelUsage) {
  if (!modelUsage || Object.keys(modelUsage).length === 0) return;
  let breakdown = emptyBreakdown();
  let costUsd = 0;
  const byModel = [];
  for (const [model, mu] of Object.entries(modelUsage)) {
    const b = {
      input:       mu?.inputTokens               || 0,
      cacheCreate: mu?.cacheCreationInputTokens  || 0,
      output:      mu?.outputTokens              || 0,
      cacheRead:   mu?.cacheReadInputTokens      || 0,
    };
    breakdown = addBreakdown(breakdown, b);
    const c = costFromBreakdown(model, b);
    costUsd += c;
    byModel.push({ model, breakdown: b, costUsd: c });
  }
  byModel.sort((a, b) => b.costUsd - a.costUsd);
  runtime.stats.tokensBreakdown = breakdown;
  runtime.stats.tokensUsed = breakdown.input + breakdown.cacheCreate + breakdown.output;
  runtime.stats.tokensByModel = byModel;
  runtime.stats.costUsd = costUsd;
  // The cumulative already includes the in-flight spawn — clear the per-spawn
  // accumulators so sendStats doesn't add them on top.
  runtime.stats.tokensBreakdownCurrentSpawn = emptyBreakdown();
  runtime.stats.tokensByModelCurrentSpawn = new Map();
  runtime.stats.costUsdCurrentSpawn = 0;
}

export function foldSpawnUsageIntoStats(runtime) {
  runtime.stats.costUsd += runtime.stats.costUsdCurrentSpawn;
  runtime.stats.costUsdCurrentSpawn = 0;
  runtime.stats.tokensBreakdown = addBreakdown(
    runtime.stats.tokensBreakdown,
    runtime.stats.tokensBreakdownCurrentSpawn,
  );
  const bk = runtime.stats.tokensBreakdown;
  runtime.stats.tokensUsed = bk.input + bk.cacheCreate + bk.output;
  runtime.stats.tokensBreakdownCurrentSpawn = emptyBreakdown();
  const byModelIdx = new Map(runtime.stats.tokensByModel.map((r) => [r.model, r]));
  for (const [model, mb] of runtime.stats.tokensByModelCurrentSpawn) {
    const prev = byModelIdx.get(model);
    const mergedBreakdown = prev
      ? addBreakdown(prev.breakdown, mb.breakdown)
      : { ...mb.breakdown };
    const addCost = mb.costUsd != null ? mb.costUsd : costFromBreakdown(model, mb.breakdown);
    const mergedCost = (prev?.costUsd || 0) + addCost;
    if (prev) { prev.breakdown = mergedBreakdown; prev.costUsd = mergedCost; }
    else byModelIdx.set(model, { model, breakdown: mergedBreakdown, costUsd: mergedCost });
  }
  runtime.stats.tokensByModel = [...byModelIdx.values()].sort((a, b) => b.costUsd - a.costUsd);
  runtime.stats.tokensByModelCurrentSpawn = new Map();
}
