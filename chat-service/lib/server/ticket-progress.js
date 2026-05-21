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
  const steps = buildSteps(runtime);
  const stepsKey = steps.map((s) => `${s.role}:${s.durationMs}:${s.status}`).join('|');
  // Skip the broadcast when nothing observable changed — back-to-back
  // dispatches in a single event would otherwise emit duplicate frames.
  const last = stats.lastProgressSent;
  if (last && last.total === total && last.done === done && last.remainingTimeMs === remainingTimeMs && last.stepsKey === stepsKey) return;
  stats.lastProgressSent = { total, done, remainingTimeMs, stepsKey };
  broadcast(runtime, { type: 'progress', total, done, remainingTimeMs, steps });
}

// Per-step snapshot driving proportional widths on the client. The orchestrator
// is always step 0 (matches the +1 in sendProgress's total). Dispatched roles
// follow in order; the last (dispatched - completed) are marked in_progress
// since completion order isn't tracked — the same heuristic estimateRemainingMs
// uses. Predicted-not-yet-dispatched roles from FLOW_PLANS fill the tail as
// pending so the bar shows the full estimated shape upfront.
function buildSteps(runtime) {
  const { dispatchedSubagentTypes: dispatchedTypes, agentsCompleted: completed, flowExpected: expected } = runtime.stats;
  const dispatched = dispatchedTypes.length;
  const steps = [];

  steps.push({
    role: 'orchestrator',
    durationMs: durationFor('orchestrator'),
    status: dispatched > 0 ? 'done' : 'in_progress',
  });

  const inFlightCount = Math.max(0, dispatched - completed);
  const completedCount = dispatched - inFlightCount;
  for (let i = 0; i < dispatched; i++) {
    const role = dispatchedTypes[i];
    steps.push({
      role,
      durationMs: durationFor(role),
      status: i < completedCount ? 'done' : 'in_progress',
    });
  }

  const predictedNotDispatched = Math.max(0, expected - dispatched);
  if (predictedNotDispatched > 0) {
    const plan = FLOW_PLANS[dispatchedTypes[0]];
    const upcoming = plan
      ? plan.slice(dispatched, dispatched + predictedNotDispatched)
      : new Array(predictedNotDispatched).fill('unknown');
    for (const role of upcoming) {
      steps.push({ role, durationMs: durationFor(role), status: 'pending' });
    }
  }

  return steps;
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
  orchestrator:      90_000, // 1m30s
  'simple-developer': 120_000, // 2m
  merger:            30_000,
  'quality-reviewer': 30_000,
  'test-validator':  45_000,
  planner:           60_000,
  architect:         60_000,
  developer:        500_000, // 8m20s
  documentator:      60_000,
  devops:            60_000,
};

const DEFAULT_DURATION_MS = 30_000;

// Roles dispatched once per ticket but running concurrently within a wave.
// merger is excluded — it's shared and serial.
const PARALLEL_ROLES = new Set(['developer', 'quality-reviewer', 'test-validator']);

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
    // entries as the still-running set. Parallel roles (one per ticket in a
    // wave) count once — they run concurrently, so the wall-clock is set by
    // the role, not the ticket count. Wave-size inflation is applied below.
    const inFlight = dispatchedTypes.slice(-inFlightCount);
    const seen = new Set();
    for (const role of inFlight) {
      if (PARALLEL_ROLES.has(role) && seen.has(role)) continue;
      seen.add(role);
      ms += durationFor(role);
    }
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

  // Wave inflation: parallel tickets share API/CPU/merger contention, so the
  // wall-clock grows roughly +30% per extra ticket beyond the first. Only
  // count in-flight developers — completed waves shouldn't penalise later ones.
  const waveSize = inFlightCount > 0
    ? dispatchedTypes.slice(-inFlightCount).filter((r) => r === 'developer').length || 1
    : 1;
  ms *= 1 + 0.3 * (waveSize - 1);

  return ms;
}
