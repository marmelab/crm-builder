import { msBetween, mergeIntervals } from './io.js';
import { extractToolUsesFromAssistant, isAgentTaskStart } from './events.js';

function subagentTypeFromAgentToolUse(toolUseId, agentTypeByToolId) {
  return agentTypeByToolId.get(toolUseId);
}

export function extractPhases(events, agentToolIdToTeam) {
  const byTaskId = new Map();
  const agentTypeByToolId = new Map();
  const agentNameByToolId = new Map();
  const agentTypeByTaskId = new Map();
  // First pass: index Agent/Task tool_uses by their tool_use_id.
  // Also capture the dispatch `name` (e.g. "developer-TASK-001") which is needed
  // to map a phase to its per-activation subagent transcripts (N reveils via
  // SendMessage = N files, all sharing the same name in their meta.agentType).
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if ((b.name === 'Agent' || b.name === 'Task') && b.input?.subagent_type) {
        agentTypeByToolId.set(b.id, b.input.subagent_type);
        if (b.input.name) agentNameByToolId.set(b.id, b.input.name);
      }
    }
  }
  // Second pass: bind task_id → subagent_type via the FIRST task_started's tool_use_id.
  // Subsequent task_started for the same task_id (SendMessage-resume) get a different
  // tool_use_id but must inherit the original subagent_type.
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (isAgentTaskStart(ev)) {
      if (!agentTypeByTaskId.has(ev.task_id)) {
        const t = subagentTypeFromAgentToolUse(ev.tool_use_id, agentTypeByToolId);
        if (t) agentTypeByTaskId.set(ev.task_id, t);
      }
    }
  }
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (isAgentTaskStart(ev)) {
      const existing = byTaskId.get(ev.task_id);
      if (existing) {
        // Resume case — append an activation, keep the phase.
        existing.activations.push({
          startTs: rec.ts, endTs: null, durationMs: 0,
          toolUseId: ev.tool_use_id, opsCount: 0, tokensTotal: 0,
        });
      } else {
        byTaskId.set(ev.task_id, {
          phaseId: ev.task_id,
          kind: 'agent',
          agentType:
            agentTypeByTaskId.get(ev.task_id) ??
            subagentTypeFromAgentToolUse(ev.tool_use_id, agentTypeByToolId) ??
            'unknown',
          // Suffixed dispatch name (e.g. "developer-TASK-001"). Used to locate
          // per-activation subagent transcripts whose meta.agentType matches.
          // Falls back to undefined for local_agent dispatches without a name.
          agentName: agentNameByToolId.get(ev.tool_use_id),
          taskType: ev.task_type, // 'local_agent' | 'in_process_teammate' — distinguishes COMPLEX team members from planner/simple-developer
          description: ev.description || '',
          teamName: agentToolIdToTeam.get(ev.tool_use_id) ?? null,
          startTs: rec.ts,
          endTs: null, durationMs: 0, opsCount: 0, tokensTotal: 0,
          errorsCount: 0, retriesCount: 0, children: [],
          activations: [{
            startTs: rec.ts, endTs: null, durationMs: 0,
            toolUseId: ev.tool_use_id, opsCount: 0, tokensTotal: 0,
          }],
          _toolUseId: ev.tool_use_id,
        });
      }
    } else if (ev.type === 'system' && ev.subtype === 'task_notification' && byTaskId.has(ev.task_id)) {
      const p = byTaskId.get(ev.task_id);
      const u = ev.usage || {};
      // Match the activation by tool_use_id (most reliable).
      const act =
        p.activations.find((a) => a.toolUseId === ev.tool_use_id && a.endTs === null) ??
        p.activations.find((a) => a.endTs === null) ??
        p.activations[p.activations.length - 1];
      if (act) {
        act.endTs = rec.ts;
        act.durationMs = u.duration_ms || msBetween(act.startTs, act.endTs);
        act.opsCount = u.tool_uses || 0;
        act.tokensTotal = u.total_tokens || 0;
      }
      // Phase aggregates: end at the latest notification, sum across activations.
      p.endTs = rec.ts;
      p.durationMs = p.activations.reduce((s, a) => s + (a.durationMs || 0), 0)
        || msBetween(p.startTs, p.endTs);
      p.opsCount = p.activations.reduce((s, a) => s + (a.opsCount || 0), 0);
      p.tokensTotal = p.activations.reduce((s, a) => s + (a.tokensTotal || 0), 0);
    }
  }
  return [...byTaskId.values()].sort((a, b) => a.startTs.localeCompare(b.startTs));
}

export function buildOrchestratorPhase(events, agentPhases, startTs, endTs) {
  const totalMs = startTs && endTs ? msBetween(startTs, endTs) : 0;
  const intervals = agentPhases
    .filter((p) => p.startTs && p.endTs)
    .map((p) => [new Date(p.startTs).getTime(), new Date(p.endTs).getTime()]);
  const merged = mergeIntervals(intervals);
  const agentCoverageMs = merged.reduce((a, [s, e]) => a + (e - s), 0);
  let opsCount = 0;
  let tokensTotal = 0;
  const skip = new Set(['Agent', 'Task', 'TeamCreate', 'TeamDelete']);
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'assistant') {
      // Only orchestrator-emitted tool_uses — sub-agent tool_uses carry a
      // parent_tool_use_id and are already counted in their phase's opsCount
      // via the task_notification.usage.tool_uses field.
      if (ev.parent_tool_use_id != null) continue;
      for (const b of extractToolUsesFromAssistant(ev)) {
        if (skip.has(b.name)) continue;
        opsCount++;
      }
    } else if (ev.type === 'result') {
      // result.usage carries this turn's token cost (cache_read excluded —
      // it's cheap rehydration, not billed against the working set).
      const u = ev.usage || {};
      tokensTotal += (u.input_tokens || 0)
        + (u.cache_creation_input_tokens || 0)
        + (u.output_tokens || 0);
    }
  }
  return {
    phaseId: 'orchestrator', kind: 'orchestrator', agentType: 'orchestrator',
    description: 'Orchestrator', teamName: null,
    startTs, endTs, durationMs: Math.max(0, totalMs - agentCoverageMs),
    opsCount, tokensTotal, errorsCount: 0, retriesCount: 0, children: [],
  };
}

export function buildTimeBreakdown(orchestrator, agentPhases) {
  // For sub-agents, workMs (tool durations + bounded thinking gaps) excludes
  // long idle waits on peers — the right "active" measure.
  // For the orchestrator, almost all its tool_uses are SendMessage (filtered
  // out of workMs), so workMs collapses to ~0. Its durationMs (computed as
  // session wallclock minus the coverage of its sub-agent intervals) is the
  // closer proxy for "time the orchestrator was actively driving".
  const byAgent = new Map([['orchestrator', orchestrator.durationMs ?? 0]]);
  for (const p of agentPhases) {
    const ms = p.workMs ?? p.durationMs;
    byAgent.set(p.agentType, (byAgent.get(p.agentType) || 0) + ms);
  }
  return [...byAgent].map(([agent, ms]) => ({ agent, ms })).sort((a, b) => b.ms - a.ms);
}

// Active-work time of a phase = sum of tool durations + thinking gaps
// between consecutive tools (only when the gap is short enough to plausibly
// be the model deciding what to do next, not a long idle wait on a peer).
//
// SendMessage is excluded from both the tool duration AND the gap span: its
// duration contains the validate-before-review hook (typecheck + tests, often
// 60-150s) which is not active work for the sender. Long gaps after a
// SendMessage are also waits, not thinking — they get clipped by the threshold.
//
// THINKING_GAP_THRESHOLD: bumped to 60s based on observed traces where the
// orchestrator legitimately thinks ~30-50s when classifying a request or
// drafting a plan. Anything beyond a minute is almost certainly an idle wait.
const COMM_TOOLS = new Set(['SendMessage']);
const THINKING_GAP_THRESHOLD = 60000;

export function computePhaseWorkMs(phase) {
  const tools = (phase.children || [])
    .filter((c) => c.kind === 'tool_use' || c.kind === 'skill')
    .filter((c) => !(c.kind === 'tool_use' && COMM_TOOLS.has(c.tool)))
    .map((c) => ({
      ts: c.ts || c.startTs,
      durationMs: c.durationMs || 0,
    }))
    .filter((c) => c.ts)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (tools.length === 0) return 0;
  let active = 0;
  let prevEndMs = null;
  for (const t of tools) {
    const startMs = new Date(t.ts).getTime();
    if (prevEndMs !== null) {
      const gap = startMs - prevEndMs;
      if (gap > 0 && gap < THINKING_GAP_THRESHOLD) active += gap;
    }
    active += t.durationMs;
    prevEndMs = startMs + t.durationMs;
  }
  return active;
}

export function buildPhaseOwnerMap(events, agentPhases) {
  const phaseByToolUseId = new Map();
  for (const p of agentPhases) if (p._toolUseId) phaseByToolUseId.set(p._toolUseId, p);
  return phaseByToolUseId;
}

export function resolvePhase(ev, phaseByToolUseId) {
  const cursor = ev.parent_tool_use_id;
  if (cursor && phaseByToolUseId.has(cursor)) return phaseByToolUseId.get(cursor);
  return null;
}
