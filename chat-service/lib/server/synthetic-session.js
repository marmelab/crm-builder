// Synthetic COMPLEX session generator.
// Creates a fully-formed session (meta.json + TASK-*.json + log.jsonl) with
// realistic events across all types: debug_raw, message, progress, stats, state.
// The session is immediately navigable in the UI — history shows everything —
// and events are also broadcast live via WS so the user can watch them arrive
// in real-time if they navigate to the URL right after creation.
//
// Usage: GET /api/debug/synthetic-session?scenario=simple3&speed=20
//   scenario: 'simple3' (3 tickets, 1 wave) | 'complex4' (4 tickets, 2 waves)
//   speed: playback multiplier — default 20 → ~20s demo

import { writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { LOG_DIR } from './config.js';
import { openSession } from './session-store.js';
import { createRuntime, runtimes } from './runtime.js';
import { broadcast } from './ws-bus.js';
import { updateProgressBar, flowExpectedForTickets } from './progress-bar.ts';

function uid() { return randomBytes(6).toString('hex'); }

// ─── Scenarios ────────────────────────────────────────────────────────────────

const SCENARIOS = {
  simple3: {
    userMessage: 'Add a notification badge on the bell, a status indicator on deals, and a sector filter on companies',
    tickets: [
      { id: 'TASK-001', title: 'Notification badge on the header bell icon', deps: [] },
      { id: 'TASK-002', title: 'Colored status indicator in the deals list', deps: [] },
      { id: 'TASK-003', title: 'Sector filter on the companies list', deps: [] },
    ],
  },
  complex4: {
    userMessage: 'Add a configurable sales pipeline with custom stages and an associated performance dashboard',
    tickets: [
      { id: 'TASK-001', title: 'Pipeline model with configurable stages', deps: [] },
      { id: 'TASK-002', title: 'REST API to manage pipeline stages', deps: ['TASK-001'] },
      { id: 'TASK-003', title: 'Pipeline list view with CRUD', deps: ['TASK-001'] },
      { id: 'TASK-004', title: 'Pipeline performance dashboard', deps: ['TASK-002', 'TASK-003'] },
    ],
  },
};

// ─── Event builders ───────────────────────────────────────────────────────────

function agentDispatchEvent(agents, teamName) {
  return {
    type: 'assistant',
    message: {
      content: [
        ...(teamName ? [{
          type: 'tool_use',
          id: 'toolu_' + uid(),
          name: 'TeamCreate',
          input: {
            team_name: teamName,
            description: `Wave: ${agents.map((a) => a.name).join(', ')}`,
          },
        }] : []),
        ...agents.map((a) => ({
          type: 'tool_use',
          id: a.toolUseId,
          name: 'Agent',
          input: {
            subagent_type: a.subagentType,
            ...(a.name !== a.subagentType ? { name: a.name } : {}),
            ...(teamName ? { team_name: teamName } : {}),
          },
        })),
      ],
    },
  };
}

function taskStartedEvent(agent) {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: agent.taskId,
    tool_use_id: agent.toolUseId,
    task_type: agent.teamName ? 'in_process_teammate' : 'local_agent',
    description: agent.name,
  };
}

function taskCompletedEvent(agent, usage) {
  return {
    type: 'system',
    subtype: 'task_notification',
    status: 'completed',
    task_id: agent.taskId,
    tool_use_id: agent.toolUseId,
    usage: usage ?? { inputTokens: 8000, outputTokens: 1500, cacheCreationInputTokens: 2000, cacheReadInputTokens: 40000 },
  };
}

function makeAgent(subagentType, ticketId, teamName) {
  const name = ticketId ? `${subagentType}-${ticketId}` : subagentType;
  return { toolUseId: 'toolu_' + uid(), taskId: uid(), subagentType, name, teamName: teamName ?? null };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTicketJson(t) {
  return {
    ticket_id: t.id,
    title: t.title,
    description: `Synthetic ticket: ${t.title}`,
    type: 'fix',
    risk_level: 'low',
    files_to_modify: [`src/${t.id.toLowerCase().replace('-', '_')}.tsx`],
    dependencies: t.deps,
    parallel_safe: t.deps.length === 0,
    status: 'pending',
  };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function scheduleEvents(runtime, tickets, speed, sessionDir, initialDelayMs = 3000) {
  // `speed` compresses real seconds: 1 real second → 1000/speed ms of wall clock.
  // initialDelayMs: head-start before first event (3s for /api endpoint so the
  // browser has time to navigate; 0 for /fake command where WS is already open).
  const ms = (seconds) => initialDelayMs + Math.round(seconds * 1000 / speed);

  // Scale animation durations so in_progress segments visually fill at fake speed.
  // Set here (not in each caller) so both createSyntheticSession and runFakeTurn
  // get scaled animations without duplicating the assignment.
  runtime.stats.durationScale = 1 / speed;

  function at(seconds, payload) {
    setTimeout(() => broadcast(runtime, payload), ms(seconds));
  }
  function atDebug(seconds, event) {
    at(seconds, { type: 'debug_raw', event });
  }
  function atStats(seconds, tokensTotal, activeAgents, costUsd) {
    at(seconds, {
      type: 'stats',
      tokensTotal,
      tokensBreakdown: { input: Math.round(tokensTotal * 0.4), cacheCreate: Math.round(tokensTotal * 0.1), output: Math.round(tokensTotal * 0.15), cacheRead: Math.round(tokensTotal * 0.35) },
      tokensByModel: [{ model: 'claude-sonnet-4-5', breakdown: { input: Math.round(tokensTotal * 0.4), cacheCreate: Math.round(tokensTotal * 0.1), output: Math.round(tokensTotal * 0.15), cacheRead: Math.round(tokensTotal * 0.35) }, costUsd }],
      tokensUsed: Math.round(tokensTotal * 0.65),
      costUsd,
      activeAgents,
    });
  }
  function atProgress(seconds, patch) {
    setTimeout(() => {
      Object.assign(runtime.stats, patch);
      updateProgressBar(runtime);
    }, ms(seconds));
  }

  const N = tickets.length;
  const plannerAgent = makeAgent('planner', null, null);

  // Compute waves from dependency graph (Kahn's)
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const remaining = new Set(tickets.map((t) => t.id));
  const waves = [];
  let safety = tickets.length + 1;
  while (remaining.size > 0 && safety-- > 0) {
    const ready = [...remaining].filter((id) => byId.get(id).deps.every((d) => !remaining.has(d)));
    if (!ready.length) { waves.push([...remaining]); break; }
    waves.push(ready);
    for (const id of ready) remaining.delete(id);
  }

  const flowExpectedValue = flowExpectedForTickets(N, waves.length);

  // ── Orchestrator phase (T=0–8s) ──────────────────────────────────────────
  // status:working MUST fire before the first progress event — it resets
  // progressSteps=[] on the client, so any progress broadcast before it
  // would be wiped. Use a 100ms head-start on the same base delay.
  setTimeout(() => broadcast(runtime, { type: 'queue_updated', queuedIds: [], cancelledId: null }), Math.max(0, initialDelayMs - 150));
  setTimeout(() => broadcast(runtime, { type: 'status', working: true }), Math.max(0, initialDelayMs - 100));
  atProgress(0, { dispatchedSubagentTypes: [], agentsCompleted: 0, completedByRole: {}, flowExpected: 0, activeAgentIds: new Set(), activeAgents: 0 });

  atDebug(2, { type: 'assistant', message: { content: [{ type: 'text', text: `Analyzing the request. I will create ${N} ticket${N > 1 ? 's' : ''} and dispatch a development team.` }] } });
  at(3, { type: 'message', role: 'assistant', content: `🎯 Analyzing — ${N} ticket${N > 1 ? 's' : ''} identified, ${waves.length} wave${waves.length > 1 ? 's' : ''}.` });

  // Planner dispatch
  atDebug(6, agentDispatchEvent([plannerAgent], null));
  atDebug(6.2, taskStartedEvent(plannerAgent));
  atProgress(6.3, { dispatchedSubagentTypes: ['planner'], flowExpected: 5 });
  atStats(7, 12000, 1, 0.08);

  // ── Planner phase (T=8–38s) ───────────────────────────────────────────────

  atDebug(12, { type: 'assistant', message: { content: [{ type: 'text', text: `Creating the ${N} TASK-0XX.json files in TICKETS_DIR...` }] } });
  atDebug(20, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_' + uid(), name: 'Write', input: { file_path: `/sessions/.../TASK-001.json`, content: '...' } }] } });
  atDebug(25, { type: 'assistant', message: { content: [{ type: 'text', text: `Tickets created. Checking dependencies...` }] } });

  // Planner done → lock flowExpected
  atDebug(35, taskCompletedEvent(plannerAgent, { inputTokens: 9000, outputTokens: 1800, cacheCreationInputTokens: 0, cacheReadInputTokens: 52000 }));
  atProgress(35.1, { agentsCompleted: 1, completedByRole: { planner: 1 }, flowExpected: flowExpectedValue, waveSizes: waves.map((w) => w.length) });
  atStats(35.2, 28000, 0, 0.22);
  at(36, { type: 'message', role: 'assistant', content: `📋 ${N} tickets planned across ${waves.length} wave${waves.length > 1 ? 's' : ''} — dispatching the team.` });
  at(37, { type: 'title', title: `Synthetic COMPLEX (${N} tickets, ${waves.length} wave${waves.length > 1 ? 's' : ''})` });

  // ── Waves ─────────────────────────────────────────────────────────────────

  let waveBaseT = 40; // T when first wave dispatch happens

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const waveIds = waves[waveIdx];
    const teamName = `wave-${waveIdx + 1}`;
    const waveTickets = waveIds.map((id) => byId.get(id));

    const devAgents = waveTickets.map((t) => makeAgent('developer', t.id, teamName));
    const qrAgents  = waveTickets.map((t) => makeAgent('quality-reviewer', t.id, teamName));
    const tvAgents  = waveTickets.map((t) => makeAgent('test-validator', t.id, teamName));
    const mergerAgent = makeAgent('merger', null, teamName);
    // Dispatch order mirrors the real orchestrator (agent-team SKILL.md): the
    // dev/qr/tv trio is emitted interleaved per ticket, NOT grouped by role,
    // then one shared merger. Faithful ordering keeps /fake a real reproduction
    // of the parallel-progress path (grouped-by-role hid the bar's gap bug).
    const allWaveAgents = [
      ...waveTickets.flatMap((_, i) => [devAgents[i], qrAgents[i], tvAgents[i]]),
      mergerAgent,
    ];

    // Dispatch: TeamCreate + Agent tool_uses in one assistant message
    atDebug(waveBaseT, agentDispatchEvent(allWaveAgents, teamName));

    // task_started burst
    allWaveAgents.forEach((a, i) => {
      const t = waveBaseT + 1 + i * 0.3;
      atDebug(t, taskStartedEvent(a));
      // Add to dispatchedSubagentTypes (except merger — it shows at the end)
      if (a.subagentType !== 'merger') {
        setTimeout(() => {
          runtime.stats.dispatchedSubagentTypes.push(a.subagentType);
          runtime.stats.activeAgentIds.add(a.taskId);
          runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
          updateProgressBar(runtime);
        }, ms(t + 0.1));
      } else {
        setTimeout(() => {
          runtime.stats.activeAgentIds.add(a.taskId);
          runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
        }, ms(t + 0.1));
      }
    });

    atStats(waveBaseT + 2, 45000 + waveIdx * 30000, allWaveAgents.length, 0.35 + waveIdx * 0.2);

    // Work time: developers take longest (~5 min real → 300s), qr 30s, tv 45s
    const workBase = waveBaseT + 3;
    const DEV_WORK = 295; // seconds (5 min)
    const QR_WORK  = 25;
    const TV_WORK  = 40;

    const completeAgents = (agents, baseT, spacing, usage) => {
      agents.forEach((a, i) => {
        const t = baseT + i * spacing;
        atDebug(t, taskCompletedEvent(a, usage));
        setTimeout(() => {
          runtime.stats.activeAgentIds.delete(a.taskId);
          runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
          runtime.stats.agentsCompleted++;
          runtime.stats.completedByRole[a.subagentType] = (runtime.stats.completedByRole[a.subagentType] || 0) + 1;
          updateProgressBar(runtime);
        }, ms(t));
      });
      return baseT + (agents.length - 1) * spacing;
    };

    const devEnd = completeAgents(devAgents, workBase + DEV_WORK, 8,
      { inputTokens: 18000, outputTokens: 4500, cacheCreationInputTokens: 6000, cacheReadInputTokens: 95000 });
    devAgents.forEach((_, i) =>
      atStats(workBase + DEV_WORK + i * 8 + 1, 80000 + waveIdx * 40000 + i * 15000, allWaveAgents.length - i - 1, 0.65 + waveIdx * 0.3 + i * 0.12));

    const qrBase = devEnd + QR_WORK;
    const qrEnd = completeAgents(qrAgents, qrBase, 6,
      { inputTokens: 6500, outputTokens: 1200, cacheCreationInputTokens: 0, cacheReadInputTokens: 55000 });

    const tvBase = qrEnd + TV_WORK;
    const tvEnd = completeAgents(tvAgents, tvBase, 6,
      { inputTokens: 4200, outputTokens: 900, cacheCreationInputTokens: 0, cacheReadInputTokens: 32000 });

    // Merger
    const mergerT = tvEnd + 15;
    atDebug(mergerT, taskCompletedEvent(mergerAgent, { inputTokens: 3200, outputTokens: 600, cacheCreationInputTokens: 0, cacheReadInputTokens: 22000 }));
    setTimeout(async () => {
      runtime.stats.activeAgentIds.delete(mergerAgent.taskId);
      runtime.stats.activeAgents = runtime.stats.activeAgentIds.size;
      runtime.stats.agentsCompleted++;
      runtime.stats.completedByRole['merger'] = (runtime.stats.completedByRole['merger'] || 0) + 1;
      runtime.stats.dispatchedSubagentTypes.push('merger');
      updateProgressBar(runtime);
      // Update wave tickets to 'merged' on disk so /api/stats shows them green
      if (sessionDir) {
        await Promise.all(waveTickets.map(async (t) => {
          try {
            const path = `${sessionDir}/${t.id}.json`;
            const data = JSON.parse(await readFile(path, 'utf8'));
            data.status = 'merged';
            await writeFile(path, JSON.stringify(data, null, 2));
          } catch {}
        }));
      }
    }, ms(mergerT));

    at(mergerT + 2, { type: 'message', role: 'assistant', content: `✅ Wave ${waveIdx + 1}/${waves.length} merged (${waveTickets.length} ticket${waveTickets.length > 1 ? 's' : ''}).` });

    // Next wave starts after merger + short gap
    waveBaseT = mergerT + 8;
  }

  // ── End of session ────────────────────────────────────────────────────────

  const endT = waveBaseT;
  at(endT, { type: 'message', role: 'assistant', content: `🎉 All changes merged into \`main\`. Session complete.` });
  at(endT + 2, { type: 'status', working: false });
  at(endT + 3, { type: 'state', state: 'completed' });
  setTimeout(() => {
    runtime.session.setState('completed').catch(() => {});
    runtime.stats.durationScale = 1; // restore real durations
    runtime.busy = false;
  }, ms(endT + 3));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createSyntheticSession({ scenario = 'simple3', speed = 20 } = {}) {
  const sc = SCENARIOS[scenario];
  if (!sc) throw new Error(`Unknown scenario: ${scenario}. Available: ${Object.keys(SCENARIOS).join(', ')}`);

  const { userMessage, tickets } = sc;

  // Create a real session (meta.json + log stream)
  const session = await openSession(null);
  const sessionId = session.id;
  const sessionDir = `${LOG_DIR}/${sessionId}`;

  // Pre-create the runtime so WS clients joining later reuse it
  const runtime = createRuntime(session);
  runtimes.set(sessionId, runtime);

  // Write TASK-*.json files (needed by /api/stats waves section)
  await Promise.all(tickets.map((t) =>
    writeFile(`${sessionDir}/${t.id}.json`, JSON.stringify(buildTicketJson(t), null, 2))));


  // Log user message (dir:'in') and update meta
  session.logWrite('in', { type: 'user_message', content: userMessage });
  await session.recordMessage('user', userMessage);
  await session.setTitle(`Synthetic COMPLEX (${tickets.length} tickets)`);

  // Schedule all events — they write to the log AND broadcast live.
  // 3s initial delay so the browser has time to navigate after getting the URL.
  scheduleEvents(runtime, tickets, speed, sessionDir, 3000);

  return { sessionId, scenario, speed, tickets: tickets.length };
}

// Run a fake COMPLEX turn on an EXISTING runtime (called from /fake slash command).
// No new session is created — events are injected into the current session.
// initialDelayMs=0 because the WS client is already connected.
export async function runFakeTurn(runtime, { scenario = 'simple3', speed = 20 } = {}) {
  const sc = SCENARIOS[scenario];
  if (!sc) throw new Error(`Unknown scenario: ${scenario}. Available: ${Object.keys(SCENARIOS).join(', ')}`);

  const { tickets } = sc;
  const session = runtime.session;
  const sessionDir = `${LOG_DIR}/${session.id}`;

  // Write / overwrite TASK-*.json for this scenario
  await Promise.all(tickets.map((t) =>
    writeFile(`${sessionDir}/${t.id}.json`, JSON.stringify(buildTicketJson(t), null, 2))));

  // Reset per-turn stats (mirrors the reset at the top of turn.js)
  runtime.stats.agentsCompleted = 0;
  runtime.stats.completedByRole = {};
  runtime.stats.flowExpected = 0;
  runtime.stats.dispatchedSubagentTypes = [];
  runtime.stats.waveSizes = null;
  runtime.stats.activeAgentIds = new Set();
  runtime.stats.activeAgents = 0;

  // Schedule all events — WS already connected so no initial delay needed
  scheduleEvents(runtime, tickets, speed, sessionDir, 0);

  return { scenario, speed, tickets: tickets.length };
}
