import { broadcast, sendToWs } from './ws-bus.js';

type RoleType = typeof Roles[keyof typeof Roles];

type StatusType = typeof Statuses[keyof typeof Statuses];

type Step = {
    role: RoleType;
    status: StatusType;
    durationMs: number;
    elapsedMs?: number; // how long the in_progress block has been running — used by reconnecting clients to restore animation position
};

type RuntimeStats = {
    dispatchedSubagentTypes: RoleType[];
    agentsCompleted: number;
    completedByRole?: Partial<Record<RoleType, number>>;
    flowExpected: number;
    waveSizes?: number[] | null;
    durationScale?: number; // 1/speed in fake/test mode
    inProgressSince?: number; // wall-clock ms when the current in_progress block started
    lastInProgressRole?: RoleType | null; // role of the in_progress block from the last call, to detect frontier advances
};

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

// Render order for parallel roles — collapses interleaved dispatch [dev,qr,tv,dev,qr,tv] → [dev×N, qr×N, tv×N].
const WAVE_PATTERN: RoleType[] = [Roles.DEVELOPER, Roles.QUALITY_REVIEWER, Roles.TEST_VALIDATOR];

const FLOW_PLANS: Partial<Record<RoleType, RoleType[]>> = {
    [Roles.DOCUMENTATOR]: [Roles.DOCUMENTATOR],
    // SIMPLE
    [Roles.SIMPLE_DEVELOPER]: [Roles.SIMPLE_DEVELOPER, Roles.MERGER],
    // COMPLEX
    [Roles.PLANNER]: [Roles.PLANNER, Roles.DEVELOPER, Roles.QUALITY_REVIEWER, Roles.TEST_VALIDATOR, Roles.MERGER],
};

export const updateProgressBar = (runtime: { stats: RuntimeStats }, targetWs: unknown = null): void => {
    if (isIndeterminate(runtime.stats)) {
        renderIndeterminate(runtime, targetWs);
        return;
    }
    const steps = buildSteps(runtime);

    // Track when the in_progress block changes so reconnecting clients can restore
    // the animation position (animation-delay: -elapsedMs) instead of restarting from 0.
    const inProgressStep = steps.find(s => s.status === Statuses.IN_PROGRESS);
    const currentRole = inProgressStep?.role ?? null;
    if (currentRole !== (runtime.stats.lastInProgressRole ?? null)) {
        runtime.stats.lastInProgressRole = currentRole;
        runtime.stats.inProgressSince = Date.now();
    }
    if (inProgressStep && runtime.stats.inProgressSince) {
        inProgressStep.elapsedMs = Math.max(0, Date.now() - runtime.stats.inProgressSince);
    }

    renderProgressBar(runtime, steps, targetWs);
}

// True while the flow total is unknown — nothing dispatched yet, or COMPLEX planner running before waveSizes arrive.
// We check agentsCompleted to avoid shimmering forever if the planner produces no tickets.
function isIndeterminate(stats: RuntimeStats): boolean {
    const dispatched = stats.dispatchedSubagentTypes;
    if (dispatched.length === 0) return true;
    if (dispatched[0] === Roles.PLANNER && !(stats.waveSizes && stats.waveSizes.length > 0) && stats.agentsCompleted < 1) return true;
    return false;
}

// Collapse a flat role list into wave blocks: non-parallel roles are wave boundaries,
// parallel roles (dev/qr/tv) between boundaries are merged by role in canonical order.
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

// Build the exact final topology from waveSizes so the segment layout is stable for the whole run.
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

function buildSteps(runtime: { stats: RuntimeStats }): Step[] {
    const { dispatchedSubagentTypes: dispatchedTypes, agentsCompleted: completed, flowExpected: expected, waveSizes, durationScale = 1 } = runtime.stats;
    const dispatched = dispatchedTypes.length;
    const completedCount = Math.min(dispatched, completed);
    const plan = FLOW_PLANS[dispatchedTypes[0]];
    const dur = (role: RoleType, count = 1) => Math.round(durationFor(role, count) * durationScale);

    let flatAgents: RoleType[];
    if (waveSizes && waveSizes.length > 0) {
        flatAgents = waveTopologyAgents(waveSizes);
    } else {
        const predictedNotDispatched = Math.max(0, expected - dispatched);
        const upcomingAgents = predictedNotDispatched > 0 && plan
            ? plan.slice(dispatched, dispatched + predictedNotDispatched)
            : [];
        flatAgents = [...dispatchedTypes, ...upcomingAgents];
    }

    const groups = groupRoles([Roles.ORCHESTRATOR, ...flatAgents]);

    // Single advancing frontier (done*·in_progress·pending*) keeps the bar gap-free.
    // Per-role attribution prevents a fast reviewer from marking the slower developer block done.
    // Falls back to flat count when no attribution is available (resumed turn without task_started mapping).
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

const durationFor = (agent: RoleType, nbParallel?: number): number => {
    const baseDuration = AGENT_DURATIONS_MS[agent];

    if (nbParallel && PARALLEL_ROLES.has(agent)) {
        return baseDuration + (nbParallel - 1) * baseDuration * 0.5; // each extra parallel agent adds 50%
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

// No fill — client renders a shimmer and shows "Estimating…".
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

// planner(1) + ticketCount×3(dev+qr+tv) + waveCount(merger)
export const flowExpectedForTickets = (ticketCount: number, waveCount = 1): number =>
  1 + ticketCount * 3 + waveCount;
