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
    flowExpected: number;
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
    UNKNOWN: 'unknown',
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
    [Roles.UNKNOWN]: 60_000, // default for unknown agents
};

const PARALLEL_ROLES: Set<RoleType> = new Set([Roles.DEVELOPER, Roles.QUALITY_REVIEWER, Roles.TEST_VALIDATOR]);

// Per-ticket wave agent sequence used both for step prediction and synthetic sessions.
export const WAVE_PATTERN: RoleType[] = [Roles.DEVELOPER, Roles.QUALITY_REVIEWER, Roles.TEST_VALIDATOR];

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
    const steps = buildSteps(runtime);
    renderProgressBar(runtime, steps, targetWs);
}

// Collapse consecutive same-role agents in PARALLEL_ROLES into one group.
// Example: ['developer','developer','developer','quality-reviewer'] →
//          [{role:'developer',count:3}, {role:'quality-reviewer',count:1}]
// Non-parallel roles (planner, merger, …) always form groups of 1.
function groupRoles(roles: RoleType[]): Array<{ role: RoleType; count: number }> {
    const groups: Array<{ role: RoleType; count: number }> = [];
    for (const role of roles) {
        const last = groups[groups.length - 1];
        if (last && last.role === role && PARALLEL_ROLES.has(role)) {
            last.count++;
        } else {
            groups.push({ role, count: 1 });
        }
    }
    return groups;
}

// Extract the steps with their status and estimated durations from the runtime stats
function buildSteps(runtime: { stats: RuntimeStats }): Step[] {
    const { dispatchedSubagentTypes: dispatchedTypes, agentsCompleted: completed, flowExpected: expected, durationScale = 1 } = runtime.stats;
    const dispatched = dispatchedTypes.length;
    const completedCount = Math.min(dispatched, completed);
    const predictedNotDispatched = Math.max(0, expected - dispatched);
    const plan = FLOW_PLANS[dispatchedTypes[0]];
    const dur = (role: RoleType, count = 1) => Math.round(durationFor(role, count) * durationScale);

    // Build upcoming predicted agents as contiguous role blocks so groupRoles
    // collapses them into clean segments with no gaps.
    let upcomingAgents: RoleType[];
    if (predictedNotDispatched === 0) {
        upcomingAgents = [];
    } else if (expected > (plan?.length ?? 0)) {
        // Multi-ticket COMPLEX: compute remaining per role from dispatch state.
        // floor((expected-2)/3) gives the per-role ticket count for ≤3 waves.
        const ticketCount = Math.floor((expected - 2) / 3);
        const waveCount   = Math.max(1, expected - 1 - ticketCount * 3);
        const devDone     = dispatchedTypes.filter(r => r === Roles.DEVELOPER).length;
        const qrDone      = dispatchedTypes.filter(r => r === Roles.QUALITY_REVIEWER).length;
        const tvDone      = dispatchedTypes.filter(r => r === Roles.TEST_VALIDATOR).length;
        const mergerDone  = dispatchedTypes.filter(r => r === Roles.MERGER).length;
        upcomingAgents = [
            ...Array<RoleType>(Math.max(0, ticketCount - devDone)).fill(Roles.DEVELOPER),
            ...Array<RoleType>(Math.max(0, ticketCount - qrDone)).fill(Roles.QUALITY_REVIEWER),
            ...Array<RoleType>(Math.max(0, ticketCount - tvDone)).fill(Roles.TEST_VALIDATOR),
            ...Array<RoleType>(Math.max(0, waveCount   - mergerDone)).fill(Roles.MERGER),
        ].slice(0, predictedNotDispatched);
    } else {
        // Single-ticket flow: follow the plan template directly.
        upcomingAgents = plan ? plan.slice(dispatched, dispatched + predictedNotDispatched) : [];
    }

    // Collapse consecutive same-role groups for display. A group is done when
    // all its individual agents have completed (tracked by agentCursor).
    const dispatchedGroups = groupRoles(dispatchedTypes);
    let agentCursor = 0;
    const dispatchedSteps = dispatchedGroups.map(({ role, count }) => {
        agentCursor += count;
        return {
            role,
            status: agentCursor <= completedCount ? Statuses.DONE : Statuses.IN_PROGRESS,
            durationMs: dur(role, count),
        };
    });

    const upcomingSteps = groupRoles(upcomingAgents).map(({ role, count }) => ({
        role,
        status: Statuses.PENDING,
        durationMs: dur(role, count),
    }));

    // Merge adjacent same-role PARALLEL_ROLES steps — eliminates the case where
    // e.g. 2-of-3 developers are dispatched (in_progress) and 1 remains predicted
    // (pending), which would otherwise appear as two separate developer segments.
    const merged: Step[] = [];
    for (const step of [...dispatchedSteps, ...upcomingSteps]) {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === step.role && PARALLEL_ROLES.has(step.role)) {
            prev.durationMs += step.durationMs;
            // Keep the more-advanced status: done > in_progress > pending
            if (step.status === Statuses.DONE) prev.status = Statuses.DONE;
            else if (step.status === Statuses.IN_PROGRESS && prev.status === Statuses.PENDING) prev.status = Statuses.IN_PROGRESS;
        } else {
            merged.push({ ...step });
        }
    }

    return [
        {
            role: Roles.ORCHESTRATOR,
            status: dispatched > 0 ? Statuses.DONE : Statuses.IN_PROGRESS,
            durationMs: dur(Roles.ORCHESTRATOR),
        },
        ...merged,
    ];
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

export const predictedFlowExpected = (subagentType: RoleType): number => {
  return FLOW_PLANS[subagentType]?.length || 0;
}

// flowExpected after planner completes: dispatched subagents only (NOT orchestrator).
// Formula: planner(1) + ticketCount×3(dev+qr+tv) + waveCount×1(merger).
export const flowExpectedForTickets = (ticketCount: number, waveCount = 1): number =>
  1 + ticketCount * 3 + waveCount;

