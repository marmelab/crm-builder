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

export function computeSummary(events) {
  let opsCount = 0, tokensTotal = 0, costUsd = 0;
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'assistant') {
      for (const _ of (ev.message?.content || []).filter((b) => b.type === 'tool_use')) opsCount++;
    }
    if (ev.type === 'result') {
      const u = ev.usage || {};
      tokensTotal += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      // total_cost_usd is cumulative WITHIN a Claude CLI spawn — every result
      // reports the running total. With --resume, the same spawn issues many
      // result events as the orchestrator processes user turns. Summing them
      // double-counts each prior turn's cost (38 results in this session
      // produced $265 instead of the real $14.69). Take the max instead —
      // it's the comprehensive end-state for the spawn.
      costUsd = Math.max(costUsd, ev.total_cost_usd || 0);
    }
  }
  return { opsCount, tokensTotal, costUsd };
}
