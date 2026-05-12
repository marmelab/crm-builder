import {
  msBetween, mergeIntervals, emptyBreakdown, addBreakdown, breakdownFromUsage,
  costFromBreakdown,
} from './io.js';
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
          tokensBreakdown: emptyBreakdown(),
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

// Time the user spent idle between turns: sum of (next user_message ts − last
// assistant message ts) for each reply→question transition. This is genuine
// human think-time — not model latency — and should be excluded from the
// "orchestrator working time" metric.
export function computeUserWaitMs(events) {
  let waitMs = 0;
  let lastAssistantTs = null;
  for (const rec of events) {
    if (rec.type === 'message' && rec.role === 'assistant') {
      lastAssistantTs = rec.ts;
    } else if (rec.type === 'user_message' && lastAssistantTs) {
      const gap = msBetween(lastAssistantTs, rec.ts);
      if (gap > 0) waitMs += gap;
      lastAssistantTs = null;
    }
  }
  return waitMs;
}

export function buildOrchestratorPhase(events, agentPhases, startTs, endTs, userWaitMs = 0) {
  const totalMs = startTs && endTs ? msBetween(startTs, endTs) : 0;
  const intervals = agentPhases
    .filter((p) => p.startTs && p.endTs)
    .map((p) => [new Date(p.startTs).getTime(), new Date(p.endTs).getTime()]);
  const merged = mergeIntervals(intervals);
  const agentCoverageMs = merged.reduce((a, [s, e]) => a + (e - s), 0);
  let opsCount = 0;
  let tokensBreakdown = emptyBreakdown();
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
      // result.usage carries this turn's token cost. All four components
      // (input, cache_creation, output, cache_read) are accumulated so the
      // panel can show the breakdown on hover.
      tokensBreakdown = addBreakdown(tokensBreakdown, breakdownFromUsage(ev.usage));
    }
  }
  const wallDurationMs = Math.max(0, totalMs - agentCoverageMs);
  const tokensTotal = tokensBreakdown.input + tokensBreakdown.cacheCreate + tokensBreakdown.output;
  return {
    phaseId: 'orchestrator', kind: 'orchestrator', agentType: 'orchestrator',
    description: 'Orchestrator', teamName: null,
    startTs, endTs,
    durationMs: Math.max(0, wallDurationMs - userWaitMs),
    wallDurationMs,
    userWaitMs,
    opsCount, tokensTotal, tokensBreakdown,
    errorsCount: 0, retriesCount: 0, children: [],
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

// Walk the main event stream to build a per-phase token breakdown for the
// orchestrator AND every `local_agent` phase (planner, simple-developer).
// Their assistant messages stream into the orchestrator's log:
//   - orchestrator-emitted messages have parent_tool_use_id == null
//   - local_agent subagent messages have parent_tool_use_id == the Agent
//     tool_use that dispatched them (matches the phase's `_toolUseId`)
//
// `in_process_teammate` phases are SKIPPED here — their messages live only
// in `~/.claude/projects/.../subagents/*.jsonl` and are populated by
// `enrichSubagentChildren`. Touching them here would zero out work already
// done. Computes per-model breakdown too so each row can compute its own
// approximate cost via the rate table (same approach the subagent enrichment
// already uses for COMPLEX team members).
export function accumulatePerPhaseTokens(events, phases) {
  const orch = phases.find((p) => p.kind === 'orchestrator');
  const phaseByToolUseId = new Map();
  for (const p of phases) {
    if (p.kind !== 'agent' || p.taskType === 'in_process_teammate') continue;
    if (p._toolUseId) phaseByToolUseId.set(p._toolUseId, p);
  }

  // Reset what we're about to recompute so retries are idempotent and a
  // possibly stale orchestrator total (from buildOrchestratorPhase) is
  // replaced by the more granular per-message sum.
  const targets = [orch, ...phaseByToolUseId.values()].filter(Boolean);
  for (const p of targets) {
    p.tokensBreakdown = emptyBreakdown();
    p._tokensByModelMap = new Map();
  }

  // Dedup per phase by message.id — each tool_use generates two assistant
  // events (decide + stream) sharing the same id; both can carry partial
  // usage and would double-count if summed.
  const seenByPhase = new Map();

  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    const ev = rec.event;
    const u = ev.message?.usage;
    if (!u) continue;
    let owner;
    if (ev.parent_tool_use_id != null) {
      owner = phaseByToolUseId.get(ev.parent_tool_use_id);
      if (!owner) continue;
    } else {
      owner = orch;
    }
    if (!owner) continue;
    const msgId = ev.message?.id;
    let seen = seenByPhase.get(owner.phaseId);
    if (!seen) { seen = new Set(); seenByPhase.set(owner.phaseId, seen); }
    if (msgId && seen.has(msgId)) continue;
    if (msgId) seen.add(msgId);
    const b = breakdownFromUsage(u);
    owner.tokensBreakdown = addBreakdown(owner.tokensBreakdown, b);
    const model = ev.message?.model;
    if (model) {
      const prev = owner._tokensByModelMap.get(model) || emptyBreakdown();
      owner._tokensByModelMap.set(model, addBreakdown(prev, b));
    }
  }

  // Materialise per-phase costUsd and tokensByModel from the per-model maps.
  for (const p of targets) {
    let cost = 0;
    const byModel = [];
    for (const [model, bd] of p._tokensByModelMap) {
      const c = costFromBreakdown(model, bd);
      cost += c;
      byModel.push({ model, breakdown: bd, costUsd: c });
    }
    byModel.sort((a, b) => b.costUsd - a.costUsd);
    p.costUsd = cost;
    p.tokensByModel = byModel;
    // Refresh the legacy headline.
    const bk = p.tokensBreakdown;
    p.tokensTotal = bk.input + bk.cacheCreate + bk.output;
    delete p._tokensByModelMap;
  }
}

// Reconcile per-phase costs with the SDK's authoritative per-model total.
//
// Per-phase costs are derived locally from a rate table (see MODEL_RATES in
// io.js) applied to each phase's token breakdown. The SDK's
// `modelUsage[model].costUSD` is the source of truth at the SPAWN/MODEL
// level. Our rate table tends to over- or under-shoot Claude Code's actual
// billed prices because the published Anthropic rates don't always match
// what the CLI is billed (subscription / batch tiers).
//
// This pass keeps the RELATIVE split between phases intact (it's based on
// real per-message usage) but SCALES each phase's per-model cost so the sum
// over all phases of model M equals the SDK total for model M. After this
// pass, sum(phase.costUsd for phase) === summary.costUsd (modulo phases for
// models that don't appear in summary.tokensByModel, which we leave alone).
export function calibratePhaseCostsToSdk(phases, sdkTokensByModel) {
  if (!Array.isArray(sdkTokensByModel) || sdkTokensByModel.length === 0) return;
  const sdkCostByModel = new Map(sdkTokensByModel.map((r) => [r.model, r.costUsd || 0]));

  // Estimated cost per model across all phases (rate table).
  const estByModel = new Map();
  for (const p of phases) {
    for (const r of p.tokensByModel || []) {
      estByModel.set(r.model, (estByModel.get(r.model) || 0) + (r.costUsd || 0));
    }
  }

  // Correction factor per model. Skip when the rate-table sum is zero
  // (nothing to scale) or the SDK reports no cost for that model.
  const factorByModel = new Map();
  for (const [model, est] of estByModel) {
    const sdk = sdkCostByModel.get(model);
    if (sdk != null && est > 0) factorByModel.set(model, sdk / est);
  }

  for (const p of phases) {
    if (!p.tokensByModel || p.tokensByModel.length === 0) continue;
    let newTotal = 0;
    for (const r of p.tokensByModel) {
      const f = factorByModel.get(r.model);
      if (f != null) r.costUsd = (r.costUsd || 0) * f;
      newTotal += r.costUsd || 0;
    }
    p.costUsd = newTotal;
  }
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
