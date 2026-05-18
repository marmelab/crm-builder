import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export async function* readJsonl(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip malformed */ }
  }
}

export function msBetween(a, b) { return new Date(b).getTime() - new Date(a).getTime(); }
export function toUnixMs(ts) { return new Date(ts).getTime(); }

export function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [[...sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function tailPayload(obj, maxLen = 800) {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
  } catch { return null; }
}

// Token breakdown shape: { input, cacheCreate, output, cacheRead }. All four
// components are exposed so the UI can display the full split on hover while
// the headline shows the grand total. cache_read is the cheapest tier (~10×
// discount) but is real billable consumption and now contributes to the total.
export function emptyBreakdown() {
  return { input: 0, cacheCreate: 0, output: 0, cacheRead: 0 };
}

export function addBreakdown(a, b) {
  return {
    input: (a.input || 0) + (b.input || 0),
    cacheCreate: (a.cacheCreate || 0) + (b.cacheCreate || 0),
    output: (a.output || 0) + (b.output || 0),
    cacheRead: (a.cacheRead || 0) + (b.cacheRead || 0),
  };
}

export function sumBreakdown(b) {
  return (b?.input || 0) + (b?.cacheCreate || 0) + (b?.output || 0) + (b?.cacheRead || 0);
}

// Extract a token breakdown from the SDK's `modelUsage` map (camelCase fields,
// per-model). Sums across all models in a single spawn snapshot.
export function breakdownFromModelUsage(modelUsage) {
  const out = emptyBreakdown();
  for (const m of Object.values(modelUsage || {})) {
    out.input       += m.inputTokens               || 0;
    out.cacheCreate += m.cacheCreationInputTokens  || 0;
    out.output      += m.outputTokens              || 0;
    out.cacheRead   += m.cacheReadInputTokens      || 0;
  }
  return out;
}

// Extract a breakdown from a per-turn `result.usage` block (snake_case fields).
export function breakdownFromUsage(u) {
  return {
    input:       u?.input_tokens                || 0,
    cacheCreate: u?.cache_creation_input_tokens || 0,
    output:      u?.output_tokens               || 0,
    cacheRead:   u?.cache_read_input_tokens     || 0,
  };
}

// Per-message assistant usage (subagent JSONL transcripts use these fields).
export function breakdownFromAssistantUsage(u) {
  return breakdownFromUsage(u);
}

// Legacy alias: returns `input + cacheCreate + output` (cache_read excluded).
// Kept so older callers and the existing test that asserts this exact sum keep
// working. New code should prefer `sumBreakdown` against a breakdown bag.
export function tokensFromModelUsage(modelUsage) {
  const b = breakdownFromModelUsage(modelUsage);
  return b.input + b.cacheCreate + b.output;
}

// Build the chronological list of spawn-boundary timestamps from a session
// stream. Every `user_message` in the chat log triggers a new `claude -p`
// process (chat-service's `processMessage` is one-spawn-per-user-message), so
// these events are the canonical spawn boundaries. We use them instead of
// the older "cost decrease" heuristic, which silently swallowed a spawn
// whenever spawn N+1's first cost event landed above spawn N's max (observed
// on real sessions: spawn 3 of d0ebd234 cost $0.05 and was absorbed into a
// neighbouring $11 spawn). For fixtures/legacy logs without user_message
// markers, callers fall back to cost-decrease detection.
export function spawnBoundaryTimestamps(events) {
  const out = [];
  for (const rec of events) {
    if (rec?.type === 'user_message' && rec.ts) out.push(rec.ts);
  }
  return out;
}

// Per-million-tokens USD rates by model. Used to derive an approximate
// per-model cost breakdown from `modelUsage`. The SDK's `total_cost_usd` is
// always the authoritative total; these rates exist only to attribute that
// total across models for the cost tooltip. Numbers track Anthropic's current
// published standard pricing — they may drift; the derived per-model figures
// are best-effort and may not sum to the SDK total to the penny.
export const MODEL_RATES = {
  'claude-opus-4-7':           { input: 5,   cacheCreate: 6.25,  cacheRead: 0.5,  output: 25 },
  'claude-opus-4-6':           { input: 5,   cacheCreate: 6.25,  cacheRead: 0.5,  output: 25 },
  'claude-opus-4-5':           { input: 5,   cacheCreate: 6.25,  cacheRead: 0.5,  output: 25 },
  'claude-sonnet-4-6':         { input: 3,   cacheCreate: 3.75,  cacheRead: 0.3,  output: 15 },
  'claude-sonnet-4-5':         { input: 3,   cacheCreate: 3.75,  cacheRead: 0.3,  output: 15 },
  'claude-haiku-4-5-20251001': { input: 1,   cacheCreate: 1.25,  cacheRead: 0.1,  output: 5  },
  'claude-haiku-4-5':          { input: 1,   cacheCreate: 1.25,  cacheRead: 0.1,  output: 5  },
};

// Short label for the cost-tooltip header. Strips the `claude-` prefix and
// any trailing date stamp so `claude-haiku-4-5-20251001` reads `haiku-4-5`.
export function shortModelName(name) {
  return String(name || '?')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

export function costFromBreakdown(model, b) {
  const r = MODEL_RATES[model] || MODEL_RATES['claude-sonnet-4-6'];
  return (
    (b?.input       || 0) * r.input +
    (b?.cacheCreate || 0) * r.cacheCreate +
    (b?.cacheRead   || 0) * r.cacheRead +
    (b?.output      || 0) * r.output
  ) / 1_000_000;
}

function breakdownFromOneModelUsage(mu) {
  return {
    input:       mu?.inputTokens               || 0,
    cacheCreate: mu?.cacheCreationInputTokens  || 0,
    output:      mu?.outputTokens              || 0,
    cacheRead:   mu?.cacheReadInputTokens      || 0,
  };
}

// Read the SDK-provided authoritative per-model cost. `costFromBreakdown`
// (using the local rates table) is a best-effort fallback for when the SDK
// hasn't populated this field — the sum of all `costUSD` across models in a
// single result event equals that event's `total_cost_usd`, so this IS the
// right number to attribute per model.
export function costFromModelUsage(mu) {
  return typeof mu?.costUSD === 'number' ? mu.costUSD : null;
}

export function computeSummary(events) {
  let opsCount = 0;
  let costUsd = 0;
  let tokensBreakdown = emptyBreakdown();
  let tokensTotal = 0;  // legacy: input + cache_create + output (excludes cache_read)
  // Per-model accumulator. modelUsage is cumulative within a spawn so we
  // replace the running per-model snapshot on each result event, then add
  // the final spawn snapshot to the cross-session map on commit. The cost
  // is the SDK-authoritative `costUSD` field (also cumulative-within-spawn).
  const tokensByModelMap = new Map(); // model → { breakdown, costUsd }
  let currentSpawnByModel = new Map();

  const boundaries = spawnBoundaryTimestamps(events);
  let nextBoundaryIdx = 0;
  let currentSpawnMaxCost = 0;
  let currentSpawnModelUsage = null;
  let sawAnyModelUsage = false;
  let fallbackBreakdown = emptyBreakdown();
  let currentSpawnFallback = emptyBreakdown();

  const commitSpawn = () => {
    costUsd += currentSpawnMaxCost;
    if (currentSpawnModelUsage) {
      const b = breakdownFromModelUsage(currentSpawnModelUsage);
      tokensBreakdown = addBreakdown(tokensBreakdown, b);
      tokensTotal += b.input + b.cacheCreate + b.output;
      for (const [model, mb] of currentSpawnByModel) {
        const prev = tokensByModelMap.get(model) || { breakdown: emptyBreakdown(), costUsd: 0 };
        tokensByModelMap.set(model, {
          breakdown: addBreakdown(prev.breakdown, mb.breakdown),
          costUsd: prev.costUsd + (mb.costUsd || 0),
        });
      }
    } else {
      // No modelUsage seen for this spawn: keep its fallback contribution.
      fallbackBreakdown = addBreakdown(fallbackBreakdown, currentSpawnFallback);
    }
    currentSpawnMaxCost = 0;
    currentSpawnModelUsage = null;
    currentSpawnByModel = new Map();
    currentSpawnFallback = emptyBreakdown();
  };

  for (const rec of events) {
    // Spawn-boundary marker: every user_message starts a new spawn. Commit
    // whatever the prior spawn accumulated before processing the message.
    if (rec?.type === 'user_message' && rec.ts) {
      if (nextBoundaryIdx > 0) commitSpawn();
      nextBoundaryIdx++;
      continue;
    }
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'assistant') {
      for (const _ of (ev.message?.content || []).filter((b) => b.type === 'tool_use')) opsCount++;
    }
    if (ev.type === 'result') {
      const c = ev.total_cost_usd || 0;
      // Defensive: even with user_message boundaries available, also commit
      // on cost decrease — covers the case where a fixture's spawn sequence
      // contains no user_message markers (legacy / synthetic event lists).
      if (boundaries.length === 0 && c < currentSpawnMaxCost) commitSpawn();
      currentSpawnMaxCost = Math.max(currentSpawnMaxCost, c);
      if (ev.modelUsage && Object.keys(ev.modelUsage).length > 0) {
        currentSpawnModelUsage = ev.modelUsage;
        // Replace per-model snapshot (cumulative-within-spawn). Pull both the
        // 4-way token breakdown AND the SDK's authoritative costUSD per model.
        currentSpawnByModel = new Map();
        for (const [model, mu] of Object.entries(ev.modelUsage)) {
          currentSpawnByModel.set(model, {
            breakdown: breakdownFromOneModelUsage(mu),
            costUsd: typeof mu?.costUSD === 'number' ? mu.costUSD : null,
          });
        }
        sawAnyModelUsage = true;
      }
      // Fallback per-spawn accumulator: needed when modelUsage is absent.
      currentSpawnFallback = addBreakdown(currentSpawnFallback, breakdownFromUsage(ev.usage));
    }
  }
  commitSpawn();
  // If no modelUsage was ever seen, the breakdown so far is all-zero; promote
  // the fallback (sum of per-turn `result.usage` across all spawns).
  if (!sawAnyModelUsage) {
    tokensBreakdown = fallbackBreakdown;
    tokensTotal = fallbackBreakdown.input + fallbackBreakdown.cacheCreate + fallbackBreakdown.output;
  }
  const tokensByModel = [...tokensByModelMap].map(([model, v]) => ({
    model,
    breakdown: v.breakdown,
    // Prefer the SDK-reported per-model cost (sum of costUSD across models in
    // a single result event equals total_cost_usd). Fall back to local rate
    // table if the SDK didn't populate costUSD (older/synthetic events).
    costUsd: v.costUsd != null ? v.costUsd : costFromBreakdown(model, v.breakdown),
  })).sort((a, b) => b.costUsd - a.costUsd);
  return { opsCount, tokensTotal, tokensBreakdown, tokensByModel, costUsd };
}
