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
    // For multi-ticket COMPLEX the plan template only covers 1 ticket (5 steps).
    // Extend beyond the template with same-role blocks (all devs, then all qr's,
    // then all tv's) so groupRoles can collapse them into single segments.
    const planSlice = plan ? plan.slice(dispatched, dispatched + predictedNotDispatched) : [];
    const overflow = predictedNotDispatched - planSlice.length;
    let upcomingAgents: RoleType[];
    if (overflow <= 0) {
        upcomingAgents = planSlice;
    } else {
        // Pull merger to the end, fill remaining slots as grouped blocks per role
        // so consecutive-same-role grouping produces clean pending segments.
        const planWithoutMerger = planSlice.filter((r) => r !== Roles.MERGER);
        const hasMerger = planSlice.includes(Roles.MERGER);
        const slots = predictedNotDispatched - planWithoutMerger.length - (hasMerger ? 1 : 0);
        const fullCycles = Math.floor(slots / WAVE_PATTERN.length);
        const remainder = slots % WAVE_PATTERN.length;
        // Group by role (all devs, then all qr's, then all tv's) so groupRoles
        // collapses them — avoids isolated "lone developer" pending segments.
        const overflowByRole = WAVE_PATTERN.flatMap((r) =>
            Array<RoleType>(fullCycles + (WAVE_PATTERN.indexOf(r) < remainder ? 1 : 0)).fill(r)
        );
        upcomingAgents = [
            ...planWithoutMerger,
            ...overflowByRole,
            ...(hasMerger ? [Roles.MERGER] : []),
        ];
    }

    const dur = (role: RoleType, count = 1) => Math.round(durationFor(role, count) * durationScale);

    // Build dispatched steps — group parallel agents into single segments.
    // A group is done when all its individual agents have completed
    // (agentCursor tracks how many individual agents we've accounted for).
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

    return [
        {
            role: Roles.ORCHESTRATOR,
            status: dispatched > 0 ? Statuses.DONE : Statuses.IN_PROGRESS,
            durationMs: dur(Roles.ORCHESTRATOR),
        },
        ...dispatchedSteps,
        ...groupRoles(upcomingAgents).map(({ role, count }) => ({
            role,
            status: Statuses.PENDING,
            durationMs: dur(role, count),
        })),
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

