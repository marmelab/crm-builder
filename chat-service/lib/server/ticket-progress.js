import { broadcast } from './ws-bus.js';

// Progress is agent-based: 1 step = 1 agent's work. The chat-orchestrator
// itself is always the +1 first step, flipping to "done" as soon as it has
// dispatched its first subagent. `flowExpected` predicts the total from the
// FIRST dispatch (SIMPLE → 2 = simple-dev + merger; MEMORY → 1 = documentator;
// DEVOPS → 1 = devops; COMPLEX → 5 = planner + min wave of 1 ticket) so the
// bar shows a stable total upfront instead of growing 1/2 → 2/3 → … For
// COMPLEX with N>1 tickets the bar still grows naturally past the floor.
export function sendProgress(runtime) {
  if (!runtime) return;
  const { stats } = runtime;
  const dispatched = stats.dispatchedSubagentTypes.length;
  const subagents = Math.max(dispatched, stats.flowExpected);
  const total = 1 + subagents;
  const done = (dispatched > 0 ? 1 : 0) + stats.agentsCompleted;
  const remainingTimeMs = estimateRemainingMs(runtime);
  // Skip the broadcast when nothing observable changed — back-to-back
  // dispatches in a single event would otherwise emit duplicate frames.
  const last = stats.lastProgressSent;
  if (last && last.total === total && last.done === done && last.remainingTimeMs === remainingTimeMs) return;
  stats.lastProgressSent = { total, done, remainingTimeMs };
  broadcast(runtime, { type: 'progress', total, done, remainingTimeMs });
}

// Ordered role plan for SIMPLE/MEMORY flows. Length doubles as the expected-
// subagent prediction; per-position role drives the remaining time for
// "expected but not yet dispatched" subagents.
const FLOW_PLANS = {
  'simple-developer': ['simple-developer', 'merger'],
  'documentator':     ['documentator'],
  'devops':           ['devops'],
  // COMPLEX minimum (N=1 ticket): planner + dev + 2 reviewers + shared merger.
  // The floor must be the minimum, not an average — `Math.max(dispatched,
  // expected)` would otherwise stall the bar below 100% when N=1 actual.
  'planner':          ['planner', 'developer', 'quality-reviewer', 'test-validator', 'merger'],
};

export function predictedFlowExpected(subagentType) {
  return FLOW_PLANS[subagentType]?.length || 0;
}

// Fixed per-role average step durations driving the remaining time. Hand-
// tuned wall-clock estimates for one dispatch of that role, including model
// latency.
const AGENT_DURATIONS_MS = {
  orchestrator:      30_000,
  'simple-developer': 30_000,
  merger:            15_000,
  'quality-reviewer': 15_000,
  'test-validator':  20_000,
  planner:           30_000,
  architect:         60_000,
  developer:        120_000,
  
  documentator:      30_000,
  devops:            60_000,
};

const DEFAULT_DURATION_MS = 30_000;

function durationFor(role) {
  return AGENT_DURATIONS_MS[role] ?? DEFAULT_DURATION_MS;
}

// Step-level elapsed time is *not* subtracted — the client decrements the
// returned value with wall-clock ticks so the visible countdown stays smooth
// between progress events.
export function estimateRemainingMs(runtime) {
  const { dispatchedSubagentTypes: dispatchedTypes, agentsCompleted: completed, flowExpected: expected } = runtime.stats;
  const dispatched = dispatchedTypes.length;

  let ms = 0;

  if (dispatched === 0) ms += durationFor('orchestrator');

  const inFlightCount = Math.max(0, dispatched - completed);
  if (inFlightCount > 0) {
    // Completion order isn't tracked, so we treat the *last* N dispatched
    // entries as the still-running set. Exact for sequential flows
    // (SIMPLE/MEMORY) and a reasonable approximation for parallel waves.
    const inFlight = dispatchedTypes.slice(-inFlightCount);
    for (const role of inFlight) ms += durationFor(role);
  }

  const predictedNotDispatched = Math.max(0, expected - dispatched);
  if (predictedNotDispatched > 0) {
    const plan = FLOW_PLANS[dispatchedTypes[0]];
    if (plan) {
      const upcoming = plan.slice(dispatched, dispatched + predictedNotDispatched);
      for (const role of upcoming) ms += durationFor(role);
    } else {
      ms += predictedNotDispatched * DEFAULT_DURATION_MS;
    }
  }

  return ms;
}
