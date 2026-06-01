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
    const { dispatchedSubagentTypes: dispatchedTypes, agentsCompleted: completed, flowExpected: expected } = runtime.stats;
    const dispatched = dispatchedTypes.length;
    const completedCount = Math.min(dispatched, completed);
    const predictedNotDispatched = Math.max(0, expected - dispatched);
    const plan = FLOW_PLANS[dispatchedTypes[0]];
    const upcomingAgents: RoleType[] = plan
        ? plan.slice(dispatched, dispatched + predictedNotDispatched)
        : new Array(predictedNotDispatched).fill(Roles.UNKNOWN);

    return [
        {
            role: Roles.ORCHESTRATOR,
            status: dispatched > 0 ? Statuses.DONE : Statuses.IN_PROGRESS,
            durationMs: durationFor(Roles.ORCHESTRATOR),
        },
        ...dispatchedTypes.map((role, i) => {
            const inProgress = i >= completedCount;
            return {
                role,
                status: inProgress ? Statuses.IN_PROGRESS : Statuses.DONE,
                durationMs: durationFor(role),
            };
        }),
        ...upcomingAgents.map((role) => ({
            role,
            status: Statuses.PENDING,
            durationMs: durationFor(role),
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

