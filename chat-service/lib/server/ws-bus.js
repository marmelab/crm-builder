export function sendToWs(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// Fan-out to every WebSocket attached to the same session. Logged once.
// Use this for any event that reflects shared state (status, assistant
// messages, stats, state/title changes, debug) — otherwise tabs opened after
// the turn started would miss it.
export function broadcast(runtime, payload) {
  if (!runtime) return;
  for (const client of runtime.clients) sendToWs(client, payload);
  runtime.session?.logWrite('out', payload);
}

// Merge committed totals with the in-flight spawn's snapshot. The current
// spawn's modelUsage is REPLACED on each result event (cumulative-within-spawn)
// so adding the current snapshot to the committed total gives the right live
// figure. Same shape as `summary.tokensBreakdown` on /api/stats.
export function sendStats(runtime) {
  if (!runtime) return;
  const committed = runtime.stats.tokensBreakdown;
  const current = runtime.stats.tokensBreakdownCurrentSpawn;
  const tokensBreakdown = {
    input:       (committed.input       || 0) + (current.input       || 0),
    cacheCreate: (committed.cacheCreate || 0) + (current.cacheCreate || 0),
    output:      (committed.output      || 0) + (current.output      || 0),
    cacheRead:   (committed.cacheRead   || 0) + (current.cacheRead   || 0),
  };
  // Headline: grand total of all four components (cache_read INCLUDED — the
  // user sees the real consumption; the breakdown lets them inspect on hover).
  const tokensTotal =
    tokensBreakdown.input + tokensBreakdown.cacheCreate +
    tokensBreakdown.output + tokensBreakdown.cacheRead;
  broadcast(runtime, {
    type: 'stats',
    tokensTotal,
    tokensBreakdown,
    // Legacy field (excludes cache_read) — kept so older clients keep working.
    tokensUsed: tokensBreakdown.input + tokensBreakdown.cacheCreate + tokensBreakdown.output,
    costUsd: runtime.stats.costUsd + runtime.stats.costUsdCurrentSpawn,
    activeAgents: runtime.stats.activeAgents,
  });
}
