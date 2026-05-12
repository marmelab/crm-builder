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

export function computeSummary(events) {
  let opsCount = 0;
  let costUsd = 0;
  let tokensBreakdown = emptyBreakdown();
  let tokensTotal = 0;  // legacy: input + cache_create + output (excludes cache_read)

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
    } else {
      // No modelUsage seen for this spawn: keep its fallback contribution.
      fallbackBreakdown = addBreakdown(fallbackBreakdown, currentSpawnFallback);
    }
    currentSpawnMaxCost = 0;
    currentSpawnModelUsage = null;
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
  return { opsCount, tokensTotal, tokensBreakdown, costUsd };
}
