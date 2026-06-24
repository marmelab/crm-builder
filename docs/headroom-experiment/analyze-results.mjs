#!/usr/bin/env node
// analyze-results.mjs — aggregate the 12-run benchmark into a report.
// Usage: node docs/headroom-experiment/analyze-results.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { median, mean } from '#stats';

// Inline the two helpers (no deps)
function _median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function _mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

const ARMS = ['baseline', 'headroom-cache', 'headroom-token', 'rtk'];

const data = {};
for (const arm of ARMS) {
  data[arm] = [];
  for (const rep of [1, 2, 3]) {
    const f = `docs/headroom-experiment/results/${arm}-${rep}.json`;
    const d = JSON.parse(readFileSync(f, 'utf8'));
    const s = d.stats.summary;
    const b = s.tokensBreakdown;
    const cc = b.cacheCreate + (b.cacheCreate1h || 0);
    data[arm].push({
      rep,
      sessionId: d.session_id,
      input: b.input,
      cc,
      cr: b.cacheRead,
      out: b.output,
      cost: s.costUsd,
      agents: s.agentsCount,
      ops: s.opsCount,
      ccCrRatio: b.cacheRead ? cc / b.cacheRead * 100 : 0,
      durationMin: s.totalMs / 60000,
      agentBreakdown: s.timeBreakdown,
      tokensByModel: s.tokensByModel,
    });
  }
}

const stats = {};
for (const arm of ARMS) {
  const rows = data[arm];
  stats[arm] = {
    cost:  { med: _median(rows.map(r => r.cost)),  min: Math.min(...rows.map(r => r.cost)),  max: Math.max(...rows.map(r => r.cost)) },
    cc:    { med: _median(rows.map(r => r.cc)),    min: Math.min(...rows.map(r => r.cc)),    max: Math.max(...rows.map(r => r.cc)) },
    cr:    { med: _median(rows.map(r => r.cr)),    min: Math.min(...rows.map(r => r.cr)),    max: Math.max(...rows.map(r => r.cr)) },
    out:   { med: _median(rows.map(r => r.out)),   min: Math.min(...rows.map(r => r.out)),   max: Math.max(...rows.map(r => r.out)) },
    ratio: { med: _median(rows.map(r => r.ccCrRatio)), values: rows.map(r => r.ccCrRatio) },
    agents:{ med: _median(rows.map(r => r.agents)) },
    ops:   { med: _median(rows.map(r => r.ops)) },
  };
}

const base = stats['baseline'].cost.med;
const report = {
  generated: new Date().toISOString(),
  arms: ARMS,
  summary: ARMS.map(arm => ({
    arm,
    cost_median: stats[arm].cost.med,
    cost_min: stats[arm].cost.min,
    cost_max: stats[arm].cost.max,
    delta_vs_baseline_pct: (stats[arm].cost.med - base) / base * 100,
    cc_cr_ratio_median_pct: stats[arm].ratio.med,
    agents_median: stats[arm].agents.med,
    ops_median: stats[arm].ops.med,
  })),
  raw: data,
};

const out = 'docs/headroom-experiment/results/analysis.json';
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`Saved ${out}`);

// Print human-readable table
console.log('\n=== BENCHMARK RESULTS — 4 arms × 3 reps ===\n');
console.log('Workload: AtomicCRM base + "add rental entity" feature request');
console.log('Metric: synthetic cost (Anthropic pricing, no discounts)\n');
console.log(`${'ARM'.padEnd(18)} ${'MEDIAN $':>9} ${'MIN':>7} ${'MAX':>7} ${'Δ BASE':>7} ${'CC/CR':>6} ${'AGENTS':>7}`);
console.log('─'.repeat(65));
for (const row of report.summary) {
  const d = row.delta_vs_baseline_pct;
  const sign = d >= 0 ? '+' : '';
  console.log(
    row.arm.padEnd(18),
    `$${row.cost_median.toFixed(2)}`.padStart(9),
    `$${row.cost_min.toFixed(2)}`.padStart(7),
    `$${row.cost_max.toFixed(2)}`.padStart(7),
    `${sign}${d.toFixed(0)}%`.padStart(7),
    `${row.cc_cr_ratio_median_pct.toFixed(1)}%`.padStart(6),
    `${row.agents_median}`.padStart(7),
  );
}
console.log('\nCC/CR = cacheCreate / cacheRead ratio. Baseline ~4.6% = healthy cache.');
console.log('Token mode inflates this to ~11% → tokens recategorised ×1.25 instead of ×0.1.\n');

// Per-model breakdown for baseline vs headroom-token
console.log('=== PER-MODEL TOKEN BREAKDOWN (median rep) ===\n');
for (const arm of ['baseline', 'headroom-token']) {
  // Use the median rep by cost
  const sorted = [...data[arm]].sort((a, b) => a.cost - b.cost);
  const medRep = sorted[1]; // middle of 3
  console.log(`${arm} (rep ${medRep.rep}, $${medRep.cost.toFixed(2)}, ${medRep.agents} agents):`);
  for (const m of medRep.tokensByModel) {
    const b2 = m.breakdown;
    const cc2 = b2.cacheCreate + (b2.cacheCreate1h || 0);
    const ratio2 = b2.cacheRead ? cc2 / b2.cacheRead * 100 : 0;
    console.log(`  ${m.model.padEnd(32)} cc/cr=${ratio2.toFixed(1)}%  cost=$${m.costUsd.toFixed(3)}`);
  }
  console.log();
}
