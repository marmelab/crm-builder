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

// Extract the steps with their status and estimated durations from the runtime stats
function buildSteps(runtime: { stats: RuntimeStats }): Step[] {
    const { dispatchedSubagentTypes: dispatchedTypes, agentsCompleted: completed, flowExpected: expected, durationScale = 1 } = runtime.stats;
    const dispatched = dispatchedTypes.length;
    const completedCount = Math.min(dispatched, completed);
    const predictedNotDispatched = Math.max(0, expected - dispatched);
    const plan = FLOW_PLANS[dispatchedTypes[0]];
    // For multi-ticket COMPLEX the plan template only covers 1 ticket (5 steps).
    // When predictedNotDispatched exceeds what remains in the template, extend
    // with the repeating per-ticket wave pattern (dev+qr+tv) so the bar shows
    // the correct total without capping at 6 or back-tracking between waves.
    const planSlice = plan ? plan.slice(dispatched, dispatched + predictedNotDispatched) : [];
    const overflow = predictedNotDispatched - planSlice.length;
    let upcomingAgents: RoleType[];
    if (overflow <= 0) {
        upcomingAgents = planSlice;
    } else {
        // Multi-ticket COMPLEX: extend beyond the plan template with the repeating
        // dev+qr+tv wave pattern. The plan may contain a 'merger' step in the middle
        // (FLOW_PLANS['planner'] ends with merger) — pull it out and put it last so
        // the bar never shows a lone merger segment floating between wave agents.
        const planWithoutMerger = planSlice.filter((r) => r !== Roles.MERGER);
        const hasMerger = planSlice.includes(Roles.MERGER);
        const slots = predictedNotDispatched - planWithoutMerger.length - (hasMerger ? 1 : 0);
        upcomingAgents = [
            ...planWithoutMerger,
            ...Array.from({ length: Math.max(0, slots) }, (_, i) => WAVE_PATTERN[i % WAVE_PATTERN.length]),
            ...(hasMerger ? [Roles.MERGER] : []),
        ];
    }

    const dur = (role: RoleType) => Math.round(durationFor(role) * durationScale);
    return [
        {
            role: Roles.ORCHESTRATOR,
            status: dispatched > 0 ? Statuses.DONE : Statuses.IN_PROGRESS,
            durationMs: dur(Roles.ORCHESTRATOR),
        },
        ...dispatchedTypes.map((role, i) => {
            const inProgress = i >= completedCount;
            return {
                role,
                status: inProgress ? Statuses.IN_PROGRESS : Statuses.DONE,
                durationMs: dur(role),
            };
        }),
        ...upcomingAgents.map((role) => ({
            role,
            status: Statuses.PENDING,
            durationMs: dur(role),
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

