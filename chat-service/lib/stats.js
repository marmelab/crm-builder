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

export async function aggregateSession({ sessionLogPath, hooksLogPath, sessionId }) {
  const events = [];
  for await (const ev of readJsonl(sessionLogPath)) events.push(ev);
  return {
    sessionId: sessionId ?? null,
    logPath: sessionLogPath,
    startTs: events[0]?.ts ?? null,
    endTs: events[events.length - 1]?.ts ?? null,
    durationMs: 0,
    summary: {
      totalMs: 0, agentsCount: 0, opsCount: 0, tokensTotal: 0, costUsd: 0,
      errorsCount: 0, retriesCount: 0, timeBreakdown: [],
    },
    teams: [], phases: [],
    topAgents: [], topToolCalls: [], toolCounts: [],
    skills: [], hooks: [], rules: [], errors: [], retries: [],
  };
}
