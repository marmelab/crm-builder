import { sendToWs, broadcast } from './ws-bus.js';
import { emptyBreakdown } from '../stats/io.js';

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
    queueIdSeq: 0,
    stopping: false,
    currentProc: null,
    // Set when a blocked rate_limit_event is seen — either on the main stream
    // (turn.js) or in a subagent transcript (subagent-tail.js). The turn's read
    // loop reconciles it into the local `rateLimit` so a subagent-triggered
    // limit settles the session on `rate_limited` instead of hanging forever.
    pendingRateLimit: null,
    clients: new Set(),
    // Subagent-transcript tailer state. Lives on the runtime so it survives
    // across turns: a long-running session re-dispatches the same subagent
    // types repeatedly, and we need uuid-based dedup to avoid re-emitting
    // events from prior turns' transcripts on each new turn.
    subagentTailerStop: null,
    subagentSeenUuids: new Set(),
    subagentFileOffsets: new Map(),
    subagentFileMtimes: new Map(),
    subagentAgentTypeCache: new Map(),
    stats: {
      // tokensUsed = legacy headline (input + cache_creation + output). Kept as
      // a derived number so older consumers keep working. The authoritative
      // per-type detail lives in `tokensBreakdown` (input/cacheCreate/output/
      // cacheRead). Tokens come from modelUsage (cumulative within a spawn,
      // includes sub-agent consumption), not result.usage which is per-turn
      // and misses sub-agent activity.
      // Seeded from the log digest so the ticker survives a runtime teardown.
      tokensUsed: session.stats?.tokensUsed || 0,
      tokensBreakdown: session.stats?.tokensBreakdown || emptyBreakdown(),
      // tokensBreakdownCurrentSpawn = latest snapshot from this spawn's
      // modelUsage (cumulative-within-spawn → replace, not add).
      tokensBreakdownCurrentSpawn: emptyBreakdown(),
      // Per-model committed totals + current spawn snapshot. Drives the
      // cost-by-model tooltip in the live ticker.
      tokensByModel: session.stats?.tokensByModel ? session.stats.tokensByModel.map((row) => ({
        model: row.model,
        breakdown: { ...row.breakdown },
        costUsd: row.costUsd,
      })) : [],
      tokensByModelCurrentSpawn: new Map(),
      // costUsd = committed cost from finished spawns
      costUsd: session.stats?.costUsd || 0,
      // costUsdCurrentSpawn = cumulative total_cost_usd from the in-progress spawn
      // (Claude CLI emits this as cumulative-within-spawn, so we replace not add)
      costUsdCurrentSpawn: 0,
      activeAgents: 0,
      // activeAgentIds tracks Claude Code task_ids for task_type="local_agent"
      // (planner, simple-developer) and task_type="in_process_teammate"
      // (every COMPLEX team member: developer-TASK-XXX, reviewers, merger).
      // The set's size IS activeAgents. Using a Set lets us properly match
      // start/complete pairs by task_id (not all task_notifications have
      // matching task_started events — e.g., MCP tools emit completion without
      // our tracked start).
      activeAgentIds: new Set(),
      // Per-turn agent step counters driving the progress bar. `flowExpected`
      // is locked on the FIRST dispatch from its subagent_type so SIMPLE/
      // MEMORY flows show a stable total upfront. `dispatchedSubagentTypes`
      // keeps subagent_type in dispatch order — length is the dispatched
      // count; per-position role drives the remaining time in progress-bar.ts.
      agentsCompleted: 0,
      flowExpected: 0,
      dispatchedSubagentTypes: [],
    },
  };
}

// Kill the current claude spawn with SIGTERM, falling back to SIGKILL after 2s
// for the (rare) process that ignores SIGTERM (e.g. blocked on uninterruptible
// IO). The timer is unref'd so it never holds the event loop open past a clean
// SIGTERM exit. Shared by the stop handler, the main-stream rate-limit branch,
// and the subagent tailer.
export function killCurrentProc(runtime) {
  const p = runtime?.currentProc;
  if (!p || p.killed) return;
  try { p.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { if (p && !p.killed) p.kill('SIGKILL'); } catch {}
  }, 2000).unref();
}

// Record a blocked rate-limit and kill the hung spawn. The CLI does not exit on
// a blocked limit — it hangs indefinitely — so killing it lets the read loop
// drain and the turn settle on `rate_limited`. Idempotent: a second call (e.g.
// main stream + subagent both report it) just re-kills an already-dead process.
export function noteRateLimit(runtime, info) {
  if (!runtime) return;
  runtime.pendingRateLimit = info;
  killCurrentProc(runtime);
}

export async function transitionState(runtime, newState) {
  if (!runtime?.session) return;
  const changed = await runtime.session.setState(newState).catch(() => false);
  if (changed) broadcast(runtime, { type: 'state', state: newState });
}
