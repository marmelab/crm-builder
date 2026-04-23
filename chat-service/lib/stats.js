import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

async function* readJsonl(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip malformed */ }
  }
}

function extractToolUsesFromAssistant(ev) {
  if (ev.type !== 'assistant') return [];
  return (ev.message?.content || []).filter((b) => b.type === 'tool_use');
}

function msBetween(a, b) { return new Date(b).getTime() - new Date(a).getTime(); }

function computeSummary(events) {
  let opsCount = 0, tokensTotal = 0, costUsd = 0;
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    for (const _ of extractToolUsesFromAssistant(ev)) opsCount++;
    if (ev.type === 'result') {
      const u = ev.usage || {};
      tokensTotal += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      costUsd += ev.total_cost_usd || 0;
    }
  }
  return { opsCount, tokensTotal, costUsd };
}

export async function aggregateSession({ sessionLogPath, hooksLogPath, sessionId }) {
  const events = [];
  for await (const ev of readJsonl(sessionLogPath)) events.push(ev);

  const startTs = events[0]?.ts ?? null;
  const endTs = events[events.length - 1]?.ts ?? null;
  const durationMs = startTs && endTs ? msBetween(startTs, endTs) : 0;

  const s = computeSummary(events);

  return {
    sessionId: sessionId ?? null,
    logPath: sessionLogPath,
    startTs,
    endTs,
    durationMs,
    summary: {
      totalMs: durationMs,
      agentsCount: 0,
      opsCount: s.opsCount,
      tokensTotal: s.tokensTotal,
      costUsd: s.costUsd,
      errorsCount: 0,
      retriesCount: 0,
      timeBreakdown: [],
    },
    teams: [], phases: [],
    topAgents: [], topToolCalls: [], toolCounts: [],
    skills: [], hooks: [], rules: [], errors: [], retries: [],
  };
}
