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

export function sendStats(runtime) {
  if (!runtime) return;
  broadcast(runtime, {
    type: 'stats',
    tokensUsed: runtime.stats.tokensUsed,
    costUsd: runtime.stats.costUsd + runtime.stats.costUsdCurrentSpawn,
    activeAgents: runtime.stats.activeAgents,
  });
}
