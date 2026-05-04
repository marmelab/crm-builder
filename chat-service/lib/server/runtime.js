import { sendToWs, broadcast } from './ws-bus.js';

// One runtime per open session. Multiple WebSockets (tabs, reconnects
// after navigating away and back) share the same runtime — so a turn that
// started in one tab still delivers its status, assistant messages, and
// stats to every tab currently viewing the session.
export const runtimes = new Map();
// Reverse lookup: which session id does this WebSocket belong to?
export const wsToRuntime = new Map();

export function runtimeForWs(ws) {
  const id = wsToRuntime.get(ws);
  return id ? runtimes.get(id) : null;
}

// Per-WS send (init, welcome). Logged once against the session.
export function safeSend(ws, payload) {
  sendToWs(ws, payload);
  runtimeForWs(ws)?.session?.logWrite('out', payload);
}

export function createRuntime(session) {
  return {
    session,
    claudeSessionId: session.meta.claudeSessionId || null,
    busy: false,
    queue: [],
    stopping: false,
    currentProc: null,
    clients: new Set(),
    stats: {
      // tokensUsed = fresh input + cache_creation + output (cache_read excluded:
      // it's re-hydrated cached context, not "burned" from the user's budget).
      // Seeded from the log digest so the ticker survives a runtime teardown.
      tokensUsed: session.stats?.tokensUsed || 0,
      // costUsd = committed cost from finished spawns
      costUsd: session.stats?.costUsd || 0,
      // costUsdCurrentSpawn = cumulative total_cost_usd from the in-progress spawn
      // (Claude CLI emits this as cumulative-within-spawn, so we replace not add)
      costUsdCurrentSpawn: 0,
      activeAgents: 0,
      // activeAgentIds tracks Claude Code task_ids for task_type="local_agent"
      // events. The set's size IS activeAgents. Using a Set lets us properly
      // match start/complete pairs by task_id (not all task_notifications have
      // matching task_started events — e.g., MCP tools emit completion without
      // our tracked start).
      activeAgentIds: new Set(),
    },
  };
}

export async function transitionState(runtime, newState) {
  if (!runtime?.session) return;
  const changed = await runtime.session.setState(newState).catch(() => false);
  if (changed) broadcast(runtime, { type: 'state', state: newState });
}
