#!/usr/bin/env node
// A/B compare two sessions' cost profiles, aggregated by agent type.
// Usage: node scripts/stats-diff.mjs <baseline-session-dir> <candidate-session-dir>
// Each arg is a sessions/<uuid>/ directory (must contain log.jsonl).
// Prints per-agent-type: API calls, ctx/call (cacheRead per call), cost — and deltas.

import { aggregateSession } from '../lib/stats.js';
import { join, basename } from 'node:path';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: stats-diff.mjs <baseline-session-dir> <candidate-session-dir>');
  process.exit(1);
}

async function profile(dir) {
  const out = await aggregateSession({
    sessionLogPath: join(dir, 'log.jsonl'),
    hooksLogPath: join(dir, 'hooks.log'),
    sessionId: basename(dir),
  });
  const byType = new Map();
  for (const p of out.phases || []) {
    const t = p.agentType || '?';
    const acc = byType.get(t) || { calls: 0, read: 0, cost: 0, n: 0 };
    acc.calls += p.callsCount || 0;
    acc.read += p.tokensBreakdown?.cacheRead || 0;
    acc.cost += p.costUsd || 0;
    acc.n += 1;
    byType.set(t, acc);
  }
  return { byType, total: out.summary?.costUsd || 0 };
}

const fmtK = (n) => `${Math.round(n / 1000)}k`;
const pct = (from, to) => (from > 0 ? ` (${to >= from ? '+' : ''}${Math.round(((to - from) / from) * 100)}%)` : '');

const [A, B] = await Promise.all([profile(a), profile(b)]);
const types = [...new Set([...A.byType.keys(), ...B.byType.keys()])]
  .sort((x, y) => (B.byType.get(y)?.cost || 0) - (B.byType.get(x)?.cost || 0));

console.log(`baseline:  ${a}`);
console.log(`candidate: ${b}\n`);
console.log(['agent'.padEnd(18), 'calls A→B'.padEnd(16), 'ctx/call A→B'.padEnd(18), 'cost A→B'].join('  '));
for (const t of types) {
  const x = A.byType.get(t) || { calls: 0, read: 0, cost: 0 };
  const y = B.byType.get(t) || { calls: 0, read: 0, cost: 0 };
  const cx = x.calls ? x.read / x.calls : 0;
  const cy = y.calls ? y.read / y.calls : 0;
  console.log([
    t.padEnd(18),
    `${x.calls}→${y.calls}${pct(x.calls, y.calls)}`.padEnd(16),
    `${fmtK(cx)}→${fmtK(cy)}${pct(cx, cy)}`.padEnd(18),
    `$${x.cost.toFixed(2)}→$${y.cost.toFixed(2)}${pct(x.cost, y.cost)}`,
  ].join('  '));
}
console.log(`\nTOTAL  $${A.total.toFixed(2)} → $${B.total.toFixed(2)}${pct(A.total, B.total)}`);
