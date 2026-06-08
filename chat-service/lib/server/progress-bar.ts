import { broadcast, sendToWs } from './ws-bus.js';

// ---------------------------------------------
// ------------------- TYPES -------------------
// ---------------------------------------------

type RoleType = typeof Roles[keyof typeof Roles];

type StatusType = typeof Statuses[keyof typeof Statuses];

type Step = {
    role: RoleType;
    status: StatusType;
    durationMs: number;
};

type RuntimeStats = {
    dispatchedSubagentTypes: RoleType[];
    agentsCompleted: number;
    completedByRole?: Partial<Record<RoleType, number>>; // completions attributed per role
    flowExpected: number;
    waveSizes?: number[] | null; // per-wave ticket counts once the planner reveals them
    durationScale?: number; // 1/speed in fake/test mode so animations match actual elapsed time
};

// ------------------------------------------------- 
// ------------------- CONSTANTS ------------------- 
// ------------------------------------------------- 

const Roles = {
    ORCHESTRATOR: 'orchestrator',
    SIMPLE_DEVELOPER: 'simple-developer',
    MERGER: 'merger',
    QUALITY_REVIEWER: 'quality-reviewer',
    TEST_VALIDATOR: 'test-validator',
    PLANNER: 'planner',
    ARCHITECT: 'architect',
    DEVELOPER: 'developer',
    DOCUMENTATOR: 'documentator',
} as const;

const Statuses = {
    DONE: 'done',
    IN_PROGRESS: 'in_progress',
    PENDING: 'pending',
} as const;

const AGENT_DURATIONS_MS: Record<RoleType, number> = {
    [Roles.ORCHESTRATOR]: 90_000, // 1m30s
    [Roles.SIMPLE_DEVELOPER]: 120_000, // 2m
    [Roles.MERGER]: 30_000,
    [Roles.QUALITY_REVIEWER]: 30_000,
    [Roles.TEST_VALIDATOR]: 45_000,
    [Roles.PLANNER]: 60_000,
    [Roles.ARCHITECT]: 60_000,
    [Roles.DEVELOPER]: 500_000, // 8m20s
    [Roles.DOCUMENTATOR]: 60_000,
};

const PARALLEL_ROLES: Set<RoleType> = new Set([Roles.DEVELOPER, Roles.QUALITY_REVIEWER, Roles.TEST_VALIDATOR]);

// Canonical order the parallel roles are rendered in within a wave — also the
// per-ticket agent trio. Used by groupRoles to collapse an interleaved wave
// (dispatched dev,qr,tv,dev,qr,tv,…) into ordered dev/qr/tv blocks.
const WAVE_PATTERN: RoleType[] = [Roles.DEVELOPER, Roles.QUALITY_REVIEWER, Roles.TEST_VALIDATOR];

const FLOW_PLANS: Partial<Record<RoleType, RoleType[]>> = {
    [Roles.DOCUMENTATOR]: [Roles.DOCUMENTATOR],
    // SIMPLE
    [Roles.SIMPLE_DEVELOPER]: [Roles.SIMPLE_DEVELOPER, Roles.MERGER],
    // COMPLEX (with X ticket in each wave):
    //      Shared: 1 planner + 1 merger.
    //      For each wave: 1 developers + 1 quality-reviewer + 1 test-validator. -> time multiplied by X tickets in the wave.
    [Roles.PLANNER]: [Roles.PLANNER, Roles.DEVELOPER, Roles.QUALITY_REVIEWER, Roles.TEST_VALIDATOR, Roles.MERGER],
};

// ------------------------------------------------- 
// ------------------- FUNCTIONS ------------------- 
// ------------------------------------------------- 

export const updateProgressBar = (runtime: { stats: RuntimeStats }, targetWs: unknown = null): void => {
    if (isIndeterminate(runtime.stats)) {
        renderIndeterminate(runtime, targetWs);
        return;
    }
    const steps = buildSteps(runtime);
    renderProgressBar(runtime, steps, targetWs);
}

// True while the total amount of work is still unknown: nothing dispatched yet
// (flow type undecided), or a COMPLEX planner is running but hasn't revealed the
// wave structure. Rendering a determinate fill here is misleading — the total
// only grows as the real plan appears, so any early fill must shrink/recede
// (the "morceau isolé" the bar then has to catch back up to). Show an
// indeterminate shimmer instead until the topology is known.
function isIndeterminate(stats: RuntimeStats): boolean {
    const dispatched = stats.dispatchedSubagentTypes;
    if (dispatched.length === 0) return true;
    // COMPLEX planner is running but hasn't revealed the waves yet. Once the
    // planner has completed (agentsCompleted ≥ 1) we stop shimmering even if
    // waveSizes never materialised (planner produced no tickets / failed) —
    // otherwise the bar would shimmer forever; fall through to the determinate
    // fallback instead.
    if (dispatched[0] === Roles.PLANNER && !(stats.waveSizes && stats.waveSizes.length > 0) && stats.agentsCompleted < 1) return true;
    return false;
}

// Group a flat role sequence into display segments. Parallel roles (dev/qr/tv)
// that fall between two non-parallel boundaries (planner, merger, …) belong to
// the same wave and are aggregated by role into canonical-ordered blocks — so
// an interleaved wave [dev,qr,tv,dev,qr,tv] becomes [dev×2, qr×2, tv×2]. A real
// COMPLEX wave dispatches interleaved by ticket, so a consecutive-only merge
// would leave every agent in its own segment; collapsing by role fixes that.
// Non-parallel roles always form their own group of 1 and act as wave
// boundaries, keeping each wave's blocks separate across multi-wave flows.
function groupRoles(roles: RoleType[]): Array<{ role: RoleType; count: number }> {
    const groups: Array<{ role: RoleType; count: number }> = [];
    let buffer: RoleType[] = [];
    const flush = () => {
        for (const role of WAVE_PATTERN) {
            const count = buffer.filter((r) => r === role).length;
            if (count) groups.push({ role, count });
        }
        buffer = [];
    };
    for (const role of roles) {
        if (PARALLEL_ROLES.has(role)) {
            buffer.push(role);
        } else {
            flush();
            groups.push({ role, count: 1 });
        }
    }
    flush();
    return groups;
}

// Build the full ordered agent list for a COMPLEX flow once the wave structure
// is known: planner, then for each wave its dev/qr/tv trio (one per ticket) and
// a shared merger. This is the exact final topology — it does NOT depend on
// dispatch/completion progress, so the segment layout stays stable for the whole
// run (no restructuring, no oversized lumped blocks that over-fill then recede).
function waveTopologyAgents(waveSizes: number[]): RoleType[] {
    const agents: RoleType[] = [Roles.PLANNER];
    for (const size of waveSizes) {
        for (const role of WAVE_PATTERN) {
            for (let i = 0; i < size; i++) agents.push(role);
        }
        agents.push(Roles.MERGER);
    }
    return agents;
}

// Extract the steps with their status and estimated durations from the runtime stats
function buildSteps(runtime: { stats: RuntimeStats }): Step[] {
    const { dispatchedSubagentTypes: dispatchedTypes, agentsCompleted: completed, flowExpected: expected, waveSizes, durationScale = 1 } = runtime.stats;
    const dispatched = dispatchedTypes.length;
    const completedCount = Math.min(dispatched, completed);
    const plan = FLOW_PLANS[dispatchedTypes[0]];
    const dur = (role: RoleType, count = 1) => Math.round(durationFor(role, count) * durationScale);

    // Once the planner has revealed the wave structure, render the exact final
    // topology (stable for the rest of the run). Until then — and for SIMPLE /
    // documentator flows — fall back to "what's dispatched + a predicted tail".
    let flatAgents: RoleType[];
    if (waveSizes && waveSizes.length > 0) {
        flatAgents = waveTopologyAgents(waveSizes);
    } else {
        const predictedNotDispatched = Math.max(0, expected - dispatched);
        // Predicted tail: the plan template past what's already dispatched.
        const upcomingAgents = predictedNotDispatched > 0 && plan
            ? plan.slice(dispatched, dispatched + predictedNotDispatched)
            : [];
        flatAgents = [...dispatchedTypes, ...upcomingAgents];
    }

    // Flatten into one ordered role list — orchestrator first — and collapse it
    // into wave-aware role blocks (see groupRoles).
    const groups = groupRoles([Roles.ORCHESTRATOR, ...flatAgents]);

    // Render as a single advancing frontier so the bar is gap-free by
    // construction: every fully-completed block is `done`, the first
    // not-yet-complete block is the lone `in_progress` segment, and everything
    // after it is `pending`. This avoids the parallel-execution gaps that arise
    // when several blocks animate at once at their own (wildly different)
    // durations — e.g. a 30s quality-reviewer filling fully while the 500s
    // developer beside it stays near-empty.
    //
    // A block is "satisfied" (its work is done) when its role's completions
    // cover it. We attribute completions PER ROLE (completedByRole) so that, in
    // a multi-ticket wave, finishing ticket-1's quick reviewer can't mark the
    // whole — much longer — developer block done while ticket-2's developer is
    // still running. Rendering stays a single advancing frontier: the first
    // not-satisfied block is the lone `in_progress` segment, everything after it
    // is `pending` regardless of its own role's completions — so the bar can
    // never gap.
    //
    // Fallback: if no completion could be attributed to a role yet (e.g. a
    // resumed turn with no task_started→tool_use_id mapping) we revert to the
    // flat completed count, which keeps the bar advancing rather than freezing.
    const completedByRole = runtime.stats.completedByRole ?? {};
    const attributed = Object.values(completedByRole).reduce((a: number, n) => a + (n ?? 0), 0);
    const usePerRole = completedCount === 0 || attributed > 0;

    const consumed: Partial<Record<RoleType, number>> = {};
    let scalarCursor = 0;
    let frontierAssigned = false;
    return groups.map(({ role, count }) => {
        let satisfied: boolean;
        if (role === Roles.ORCHESTRATOR) {
            satisfied = dispatched > 0;
        } else if (usePerRole) {
            consumed[role] = (consumed[role] ?? 0) + count;
            satisfied = (completedByRole[role] ?? 0) >= consumed[role]!;
        } else {
            scalarCursor += count;
            satisfied = scalarCursor <= completedCount;
        }
        let status: StatusType;
        if (satisfied && !frontierAssigned) {
            status = Statuses.DONE;
        } else if (!frontierAssigned) {
            status = Statuses.IN_PROGRESS;
            frontierAssigned = true;
        } else {
            status = Statuses.PENDING;
        }
        return { role, status, durationMs: dur(role, count) };
    });
}

// Get the estimated duration for an agent, taking into account parallel execution if applicable
const durationFor = (agent: RoleType, nbParallel?: number): number => {
    const baseDuration = AGENT_DURATIONS_MS[agent];

    if (nbParallel && PARALLEL_ROLES.has(agent)) {
        return baseDuration + (nbParallel - 1) * baseDuration * 0.5; // Each additional parallel agent adds 50% of the base duration
    }

    return baseDuration;
}

const sum = (sum: number, step: Step) => sum + step.durationMs;

const renderProgressBar = (
    runtime: { stats: RuntimeStats },
    steps: Step[],
    targetWs: unknown = null
): void => {
    const payload = {
        type: 'progress',
        total: steps.length,
        done: steps.filter((step) => step.status === Statuses.DONE).length,
        remainingTimeMs: steps.filter((step) => step.status !== Statuses.DONE).reduce(sum, 0),
        steps,
    };

    if (targetWs) {
        sendToWs(targetWs, payload);
        return;
    }
    broadcast(runtime, payload);
}

// Indeterminate frame: no determinate fill, just a "working, estimating" signal.
// `indeterminate` tells the client to render a shimmer bar and show "Estimating…"
// rather than a percentage that would later recede.
const renderIndeterminate = (runtime: { stats: RuntimeStats }, targetWs: unknown = null): void => {
    const payload = { type: 'progress', indeterminate: true, total: 0, done: 0, remainingTimeMs: 0, steps: [] };
    if (targetWs) {
        sendToWs(targetWs, payload);
        return;
    }
    broadcast(runtime, payload);
}

export const predictedFlowExpected = (subagentType: RoleType): number => {
  return FLOW_PLANS[subagentType]?.length || 0;
}

// flowExpected after planner completes: dispatched subagents only (NOT orchestrator).
// Formula: planner(1) + ticketCount×3(dev+qr+tv) + waveCount×1(merger).
export const flowExpectedForTickets = (ticketCount: number, waveCount = 1): number =>
  1 + ticketCount * 3 + waveCount;

