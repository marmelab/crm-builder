import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

async function* readJsonl(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip malformed */ }
  }
}

function extractToolUsesFromAssistant(ev) {
  if (ev.type !== 'assistant') return [];
  return (ev.message?.content || []).filter((b) => b.type === 'tool_use');
}

function msBetween(a, b) { return new Date(b).getTime() - new Date(a).getTime(); }

function computeSummary(events) {
  let opsCount = 0, tokensTotal = 0, costUsd = 0;
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    for (const _ of extractToolUsesFromAssistant(ev)) opsCount++;
    if (ev.type === 'result') {
      const u = ev.usage || {};
      tokensTotal += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      costUsd += ev.total_cost_usd || 0;
    }
  }
  return { opsCount, tokensTotal, costUsd };
}

function colorFromName(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 65% 55%)`;
}

function extractTeams(events) {
  const agentToolIdToTeam = new Map();
  const teams = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (b.name === 'TeamCreate' && b.input?.team_name) {
        const n = b.input.team_name;
        if (!teams.has(n)) {
          teams.set(n, {
            team_name: n,
            description: b.input.description ?? '',
            color: colorFromName(n),
            durationMs: 0, agentsCount: 0, errorsCount: 0,
          });
        }
      } else if ((b.name === 'Agent' || b.name === 'Task') && b.input?.team_name) {
        agentToolIdToTeam.set(b.id, b.input.team_name);
      }
    }
  }
  return { teams, agentToolIdToTeam };
}

function extractPhases(events, agentToolIdToTeam) {
  const byTaskId = new Map();
  const agentTypeByToolId = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if ((b.name === 'Agent' || b.name === 'Task') && b.input?.subagent_type) {
        agentTypeByToolId.set(b.id, b.input.subagent_type);
      }
    }
  }
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_started' && ev.task_type === 'local_agent') {
      byTaskId.set(ev.task_id, {
        phaseId: ev.task_id,
        kind: 'agent',
        agentType: agentTypeByToolId.get(ev.tool_use_id) ?? 'unknown',
        description: ev.description || '',
        teamName: agentToolIdToTeam.get(ev.tool_use_id) ?? null,
        startTs: rec.ts,
        endTs: null, durationMs: 0, opsCount: 0, tokensTotal: 0,
        errorsCount: 0, retriesCount: 0, children: [],
        _toolUseId: ev.tool_use_id,
      });
    } else if (ev.type === 'system' && ev.subtype === 'task_notification' && byTaskId.has(ev.task_id)) {
      const p = byTaskId.get(ev.task_id);
      p.endTs = rec.ts;
      const u = ev.usage || {};
      p.durationMs = u.duration_ms || msBetween(p.startTs, p.endTs);
      p.opsCount = u.tool_uses || 0;
      p.tokensTotal = u.total_tokens || 0;
    }
  }
  return [...byTaskId.values()].sort((a, b) => a.startTs.localeCompare(b.startTs));
}

function buildOrchestratorPhase(events, agentPhases, startTs, endTs) {
  const agentTotalMs = agentPhases.reduce((a, p) => a + p.durationMs, 0);
  const totalMs = startTs && endTs ? msBetween(startTs, endTs) : 0;
  let opsCount = 0;
  const skip = new Set(['Agent', 'Task', 'TeamCreate', 'TeamDelete']);
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (skip.has(b.name)) continue;
      opsCount++;
    }
  }
  return {
    phaseId: 'orchestrator', kind: 'orchestrator', agentType: 'orchestrator',
    description: 'Orchestrator', teamName: null,
    startTs, endTs, durationMs: Math.max(0, totalMs - agentTotalMs),
    opsCount, tokensTotal: 0, errorsCount: 0, retriesCount: 0, children: [],
  };
}

function buildTimeBreakdown(orchestrator, agentPhases) {
  const byAgent = new Map([['orchestrator', orchestrator.durationMs]]);
  for (const p of agentPhases) byAgent.set(p.agentType, (byAgent.get(p.agentType) || 0) + p.durationMs);
  return [...byAgent].map(([agent, ms]) => ({ agent, ms })).sort((a, b) => b.ms - a.ms);
}

function buildPhaseOwnerMap(events, agentPhases) {
  const phaseByToolUseId = new Map();
  for (const p of agentPhases) if (p._toolUseId) phaseByToolUseId.set(p._toolUseId, p);
  return phaseByToolUseId;
}

function resolvePhase(ev, phaseByToolUseId) {
  const cursor = ev.parent_tool_use_id;
  if (cursor && phaseByToolUseId.has(cursor)) return phaseByToolUseId.get(cursor);
  return null;
}

function toolDetail(toolName, input) {
  if (!input) return null;
  const short = (s, n = 80) => (typeof s === 'string' && s.length > n) ? '…' + s.slice(-n) : s;
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit': return short(input.file_path);
    case 'Bash': return short(input.command, 80);
    case 'Grep': return `"${input.pattern ?? ''}"${input.path ? ' in ' + input.path : ''}`;
    case 'Glob': return input.pattern ?? null;
    case 'Skill': return input.skill ?? null;
    default: return null;
  }
}

const SKIP_CHILD = new Set(['Agent', 'Task', 'TeamCreate', 'TeamDelete']);

function populateChildrenAndCounts(events, phases, orchestrator) {
  const agentPhases = phases.filter((p) => p.kind === 'agent');
  const phaseByToolUseId = buildPhaseOwnerMap(events, agentPhases);
  const toolCounts = new Map();
  const allToolCalls = [];
  const prevTsByPhase = new Map();

  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    const owner = resolvePhase(rec.event, phaseByToolUseId) ?? orchestrator;
    if (!owner) continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (SKIP_CHILD.has(b.name)) continue;
      const prev = prevTsByPhase.get(owner.phaseId);
      const approxDurationMs = prev ? msBetween(prev, rec.ts) : 0;
      prevTsByPhase.set(owner.phaseId, rec.ts);
      if (b.name === 'Skill') {
        owner.children.push({
          kind: 'skill',
          skill: b.input?.skill || 'unknown',
          ts: rec.ts,
          approxDurationMs, isApprox: true,
        });
      } else {
        owner.children.push({
          kind: 'tool_use',
          tool: b.name, detail: toolDetail(b.name, b.input),
          ts: rec.ts,
          approxDurationMs, isApprox: true,
          agentType: owner.agentType,
        });
        const tc = toolCounts.get(b.name) || { tool: b.name, count: 0, totalDurationMs: 0, isApprox: true };
        tc.count++; tc.totalDurationMs += approxDurationMs;
        toolCounts.set(b.name, tc);
        allToolCalls.push({
          phaseId: owner.phaseId, tool: b.name, detail: toolDetail(b.name, b.input),
          durationMs: approxDurationMs, isApprox: true,
          teamName: owner.teamName ?? null,
          flaggedSlow: approxDurationMs > 30000,
          ts: rec.ts, _toolUseId: b.id,
        });
      }
    }
  }

  // Refine Bash durations from local_bash task_notifications (they share tool_use_id)
  const bashDurByToolUseId = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_notification' && ev.task_type === 'local_bash' && ev.tool_use_id) {
      bashDurByToolUseId.set(ev.tool_use_id, ev.usage?.duration_ms || 0);
    }
  }
  for (const c of allToolCalls) {
    if (c.tool === 'Bash' && c._toolUseId && bashDurByToolUseId.has(c._toolUseId)) {
      const dur = bashDurByToolUseId.get(c._toolUseId);
      if (dur > 0) {
        c.durationMs = dur; c.isApprox = false; c.flaggedSlow = dur > 30000;
      }
    }
    delete c._toolUseId;
  }

  return {
    toolCounts: [...toolCounts.values()].sort((a, b) => b.count - a.count),
    allToolCalls,
  };
}

function buildTopAgents(agentPhases) {
  return [...agentPhases].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
    .map((p) => ({ phaseId: p.phaseId, label: `${p.agentType} ${p.description}`.trim(), durationMs: p.durationMs, teamName: p.teamName }));
}

function buildTopToolCalls(allToolCalls) {
  return [...allToolCalls].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
    .map(({ ts, ...rest }) => rest);
}

export async function aggregateSession({ sessionLogPath, hooksLogPath, sessionId }) {
  const events = [];
  for await (const ev of readJsonl(sessionLogPath)) events.push(ev);

  const startTs = events[0]?.ts ?? null;
  const endTs = events[events.length - 1]?.ts ?? null;
  const durationMs = startTs && endTs ? msBetween(startTs, endTs) : 0;

  const s = computeSummary(events);

  const { teams, agentToolIdToTeam } = extractTeams(events);
  const agentPhases = extractPhases(events, agentToolIdToTeam);

  for (const p of agentPhases) {
    if (p.teamName && teams.has(p.teamName)) {
      const t = teams.get(p.teamName);
      t.agentsCount++;
      t.durationMs += p.durationMs;
    }
  }

  const orchestrator = buildOrchestratorPhase(events, agentPhases, startTs, endTs);
  const phases = agentPhases.length > 0
    ? [orchestrator, ...agentPhases].sort((a, b) => a.startTs.localeCompare(b.startTs))
    : [];
  const timeBreakdown = agentPhases.length > 0 ? buildTimeBreakdown(orchestrator, agentPhases) : [];

  // Build phase children, tool counts, and leaderboards
  const { toolCounts, allToolCalls } = populateChildrenAndCounts(events, phases, orchestrator);
  const topAgents = buildTopAgents(agentPhases);
  const topToolCalls = buildTopToolCalls(allToolCalls);

  return {
    sessionId: sessionId ?? null,
    logPath: sessionLogPath,
    startTs,
    endTs,
    durationMs,
    summary: {
      totalMs: durationMs,
      agentsCount: agentPhases.length,
      opsCount: s.opsCount,
      tokensTotal: s.tokensTotal,
      costUsd: s.costUsd,
      errorsCount: 0,
      retriesCount: 0,
      timeBreakdown,
    },
    teams: [...teams.values()],
    phases,
    topAgents,
    topToolCalls,
    toolCounts,
    skills: [], hooks: [], rules: [], errors: [], retries: [],
  };
}
