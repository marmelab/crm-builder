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

function extractToolResultsFromUser(ev) {
  if (ev.type !== 'user') return [];
  return (ev.message?.content || []).filter((b) => b.type === 'tool_result');
}

function msBetween(a, b) { return new Date(b).getTime() - new Date(a).getTime(); }

function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [[...sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const STREAM_GAP_THRESHOLD_MS = 1000;

function buildEventTsIndex(events) {
  // Only substantive stream content — assistant/user messages. task_progress fires at every
  // tool_use boundary as metadata and would falsely inflate activity counts for silent waits.
  const arr = [];
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.ts) continue;
    const t = rec.event?.type;
    if (t === 'assistant' || t === 'user') arr.push(new Date(rec.ts).getTime());
  }
  arr.sort((a, b) => a - b);
  return arr;
}

function countEventsStrictlyBetween(tsIndex, startTs, endTs) {
  const s = new Date(startTs).getTime();
  const e = new Date(endTs).getTime();
  let lo = 0, hi = tsIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tsIndex[mid] <= s) lo = mid + 1; else hi = mid;
  }
  const left = lo;
  lo = 0; hi = tsIndex.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tsIndex[mid] < e) lo = mid + 1; else hi = mid;
  }
  return lo - left;
}

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

function subagentTypeFromAgentToolUse(toolUseId, agentTypeByToolId) {
  return agentTypeByToolId.get(toolUseId);
}

function extractPhases(events, agentToolIdToTeam) {
  const byTaskId = new Map();
  const agentTypeByToolId = new Map();
  const agentTypeByTaskId = new Map();
  // First pass: index Agent/Task tool_uses by their tool_use_id.
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if ((b.name === 'Agent' || b.name === 'Task') && b.input?.subagent_type) {
        agentTypeByToolId.set(b.id, b.input.subagent_type);
      }
    }
  }
  // Second pass: bind task_id → subagent_type via the FIRST task_started's tool_use_id.
  // Subsequent task_started for the same task_id (SendMessage-resume) get a different
  // tool_use_id but must inherit the original subagent_type.
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_started' && ev.task_type === 'local_agent') {
      if (!agentTypeByTaskId.has(ev.task_id)) {
        const t = subagentTypeFromAgentToolUse(ev.tool_use_id, agentTypeByToolId);
        if (t) agentTypeByTaskId.set(ev.task_id, t);
      }
    }
  }
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_started' && ev.task_type === 'local_agent') {
      const existing = byTaskId.get(ev.task_id);
      if (existing) {
        // Resume case — append an activation, keep the phase.
        existing.activations.push({
          startTs: rec.ts, endTs: null, durationMs: 0,
          toolUseId: ev.tool_use_id, opsCount: 0, tokensTotal: 0,
        });
      } else {
        byTaskId.set(ev.task_id, {
          phaseId: ev.task_id,
          kind: 'agent',
          agentType:
            agentTypeByTaskId.get(ev.task_id) ??
            subagentTypeFromAgentToolUse(ev.tool_use_id, agentTypeByToolId) ??
            'unknown',
          description: ev.description || '',
          teamName: agentToolIdToTeam.get(ev.tool_use_id) ?? null,
          startTs: rec.ts,
          endTs: null, durationMs: 0, opsCount: 0, tokensTotal: 0,
          errorsCount: 0, retriesCount: 0, children: [],
          activations: [{
            startTs: rec.ts, endTs: null, durationMs: 0,
            toolUseId: ev.tool_use_id, opsCount: 0, tokensTotal: 0,
          }],
          _toolUseId: ev.tool_use_id,
        });
      }
    } else if (ev.type === 'system' && ev.subtype === 'task_notification' && byTaskId.has(ev.task_id)) {
      const p = byTaskId.get(ev.task_id);
      const u = ev.usage || {};
      // Match the activation by tool_use_id (most reliable).
      const act =
        p.activations.find((a) => a.toolUseId === ev.tool_use_id && a.endTs === null) ??
        p.activations.find((a) => a.endTs === null) ??
        p.activations[p.activations.length - 1];
      if (act) {
        act.endTs = rec.ts;
        act.durationMs = u.duration_ms || msBetween(act.startTs, act.endTs);
        act.opsCount = u.tool_uses || 0;
        act.tokensTotal = u.total_tokens || 0;
      }
      // Phase aggregates: end at the latest notification, sum across activations.
      p.endTs = rec.ts;
      p.durationMs = p.activations.reduce((s, a) => s + (a.durationMs || 0), 0)
        || msBetween(p.startTs, p.endTs);
      p.opsCount = p.activations.reduce((s, a) => s + (a.opsCount || 0), 0);
      p.tokensTotal = p.activations.reduce((s, a) => s + (a.tokensTotal || 0), 0);
    }
  }
  return [...byTaskId.values()].sort((a, b) => a.startTs.localeCompare(b.startTs));
}

function buildOrchestratorPhase(events, agentPhases, startTs, endTs) {
  const totalMs = startTs && endTs ? msBetween(startTs, endTs) : 0;
  const intervals = agentPhases
    .filter((p) => p.startTs && p.endTs)
    .map((p) => [new Date(p.startTs).getTime(), new Date(p.endTs).getTime()]);
  const merged = mergeIntervals(intervals);
  const agentCoverageMs = merged.reduce((a, [s, e]) => a + (e - s), 0);
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
    startTs, endTs, durationMs: Math.max(0, totalMs - agentCoverageMs),
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

function buildToolResultMap(events) {
  const m = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'user') continue;
    for (const b of extractToolResultsFromUser(rec.event)) {
      if (b.tool_use_id && !m.has(b.tool_use_id)) m.set(b.tool_use_id, rec.ts);
    }
  }
  return m;
}

const THINKING_PREVIEW_MAX_CHARS = 300;

function previewFromBuffer(buf) {
  if (!buf || buf.length === 0) return null;
  const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return null;
  return joined.length > THINKING_PREVIEW_MAX_CHARS
    ? joined.slice(0, THINKING_PREVIEW_MAX_CHARS - 1) + '…'
    : joined;
}

function populateChildrenAndCounts(events, phases, orchestrator) {
  const agentPhases = phases.filter((p) => p.kind === 'agent');
  const phaseByToolUseId = buildPhaseOwnerMap(events, agentPhases);
  const toolResultTsByToolUseId = buildToolResultMap(events);
  const eventTsIndex = buildEventTsIndex(events);
  const toolCounts = new Map();
  const allToolCalls = [];
  const lastToolResultTsByPhase = new Map();
  const thinkingBufferByPhase = new Map();

  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    const owner = resolvePhase(rec.event, phaseByToolUseId) ?? orchestrator;
    if (!owner) continue;
    const blocks = rec.event.message?.content || [];
    for (const b of blocks) {
      if (b.type === 'thinking' && b.thinking) {
        const buf = thinkingBufferByPhase.get(owner.phaseId) || [];
        buf.push(b.thinking);
        thinkingBufferByPhase.set(owner.phaseId, buf);
      } else if (b.type === 'text' && b.text) {
        const buf = thinkingBufferByPhase.get(owner.phaseId) || [];
        buf.push(b.text);
        thinkingBufferByPhase.set(owner.phaseId, buf);
      }
    }
    const allUses = blocks.filter((b) => b.type === 'tool_use');
    if (allUses.length === 0) continue;

    // Every tool_use (including dispatches like Agent/Team*) advances the phase's
    // wall-clock cursor — a subagent running is not orchestrator thinking time.
    // Track the max tool_result ts across all of them so the next "thinking" gap
    // measures from when the prior work actually finished.
    let maxToolResultTsThisMsg = null;
    for (const b of allUses) {
      const toolResultTs = toolResultTsByToolUseId.get(b.id) ?? null;
      if (toolResultTs && (!maxToolResultTsThisMsg || toolResultTs > maxToolResultTsThisMsg)) {
        maxToolResultTsThisMsg = toolResultTs;
      }
    }

    const visibleUses = allUses.filter((b) => !SKIP_CHILD.has(b.name));
    if (visibleUses.length > 0) {
      const lastTR = lastToolResultTsByPhase.get(owner.phaseId);
      if (lastTR) {
        const gapMs = msBetween(lastTR, rec.ts);
        if (gapMs >= STREAM_GAP_THRESHOLD_MS) {
          const preview = previewFromBuffer(thinkingBufferByPhase.get(owner.phaseId));
          const eventsDuringGap = countEventsStrictlyBetween(eventTsIndex, lastTR, rec.ts);
          owner.children.push({
            kind: 'stream_gap', ts: lastTR, durationMs: gapMs,
            eventsDuringGap, preview,
          });
        }
      }
      thinkingBufferByPhase.set(owner.phaseId, []);
      for (const b of visibleUses) {
        const toolResultTs = toolResultTsByToolUseId.get(b.id) ?? null;
        const durationMs = toolResultTs ? Math.max(0, msBetween(rec.ts, toolResultTs)) : 0;
        const isApprox = !toolResultTs;
        if (b.name === 'Skill') {
          owner.children.push({
            kind: 'skill',
            skill: b.input?.skill || 'unknown',
            ts: rec.ts, durationMs, isApprox,
          });
        } else {
          owner.children.push({
            kind: 'tool_use',
            tool: b.name, detail: toolDetail(b.name, b.input),
            ts: rec.ts, durationMs, isApprox,
            agentType: owner.agentType,
          });
          const tc = toolCounts.get(b.name) || { tool: b.name, count: 0, totalDurationMs: 0 };
          tc.count++; tc.totalDurationMs += durationMs;
          toolCounts.set(b.name, tc);
          allToolCalls.push({
            phaseId: owner.phaseId, tool: b.name, detail: toolDetail(b.name, b.input),
            durationMs, isApprox,
            teamName: owner.teamName ?? null,
            flaggedSlow: durationMs > 30000,
            ts: rec.ts, _toolUseId: b.id,
          });
        }
      }
    }
    lastToolResultTsByPhase.set(owner.phaseId, maxToolResultTsThisMsg ?? rec.ts);
  }

  for (const c of allToolCalls) delete c._toolUseId;

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

const HOOK_NAME_MAP = {
  'typecheck': 'typecheck-on-commit.sh',
  'unit-app':  'run-unit-tests-app.sh',
  'unit-fn':   'run-unit-tests-functions.sh',
  'e2e':       'run-e2e-tests.sh',
  'prettier':  'prettier-on-stop.sh',
  'block-bash-file-write': 'block-bash-file-write.sh',
  'block-bash-validation': 'block-bash-validation.sh',
  'circuit-breaker':       'circuit-breaker.sh',
  'silent-mode-check':     'silent-mode-check.sh',
};
const BLOCKING_HOOKS = new Set([
  'block-bash-file-write.sh','block-bash-validation.sh','circuit-breaker.sh','silent-mode-check.sh',
]);

function parseHookLine(line) {
  const m = line.match(/^\[([^\]]+)\]\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  const [, ts, shortName, state, rest = ''] = m;
  const wtMatch = rest.match(/wt=(\S+)/);
  const worktree = wtMatch ? wtMatch[1] : null;
  let kind = null, exitCode = null;
  if (state === 'START') kind = 'start';
  else if (state === 'SKIP') kind = 'skip';
  else if (state === 'OK') kind = 'ok';
  else if (state.startsWith('EXIT=')) { kind = 'exit'; exitCode = Number(state.slice(5)); }
  return { ts, shortName, kind, exitCode, worktree, rest };
}

async function readHooksLog(path, winStart, winEnd) {
  if (!path) return [];
  const raw = await readFile(path, 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  const ws = winStart ? new Date(winStart).getTime() : 0;
  const we = winEnd ? new Date(winEnd).getTime() : Infinity;
  for (const l of lines) {
    const p = parseHookLine(l);
    if (!p) continue;
    const t = new Date(p.ts).getTime();
    if (Number.isNaN(t) || t < ws || t > we) continue;
    out.push(p);
  }
  return out;
}

function aggregateHooks(hookLines) {
  const openByKey = new Map();
  const execsByName = new Map();
  for (const line of hookLines) {
    const fullName = HOOK_NAME_MAP[line.shortName] || `${line.shortName}.sh`;
    if (!execsByName.has(fullName)) execsByName.set(fullName, []);
    const key = `${line.shortName}|${line.worktree ?? '-'}`;
    if (line.kind === 'start') {
      openByKey.set(key, line);
    } else if (line.kind === 'exit') {
      const start = openByKey.get(key) ?? openByKey.get(`${line.shortName}|-`);
      const startTs = start?.ts ?? line.ts;
      openByKey.delete(key);
      execsByName.get(fullName).push({
        ts: startTs, worktree: line.worktree ?? start?.worktree ?? null,
        durationMs: msBetween(startTs, line.ts), exitCode: line.exitCode, tail: null,
      });
    } else if (line.kind === 'skip') {
      execsByName.get(fullName).push({
        ts: line.ts, worktree: line.worktree, durationMs: 0, exitCode: null, skip: true, tail: null,
      });
    }
  }
  const out = [];
  for (const [fullName, execs] of execsByName) {
    const runs = execs.filter((e) => !e.skip).length;
    out.push({
      hookName: fullName,
      hookType: BLOCKING_HOOKS.has(fullName) ? 'PreToolUse' : 'SubagentStop',
      runs,
      totalDurationMs: execs.reduce((a, e) => a + (e.durationMs || 0), 0),
      okCount: execs.filter((e) => !e.skip && e.exitCode === 0).length,
      failCount: execs.filter((e) => !e.skip && e.exitCode !== 0 && e.exitCode !== null).length,
      skipCount: execs.filter((e) => e.skip).length,
      blocking: BLOCKING_HOOKS.has(fullName),
      executions: execs,
    });
  }
  return out.sort((a, b) => b.runs - a.runs);
}

function extractWorktreeFromAgentPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/WORKTREE_PATH=(\S+)/);
  return m ? m[1] : null;
}

function assignHookExecsToPhases(events, phases, hookAggregates) {
  const worktreeByPhaseId = new Map();
  const toolUseIdToWorktree = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if ((b.name === 'Agent' || b.name === 'Task') && b.input?.prompt) {
        const wt = extractWorktreeFromAgentPrompt(b.input.prompt);
        if (wt) toolUseIdToWorktree.set(b.id, wt);
      }
    }
  }
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_started' && ev.tool_use_id && toolUseIdToWorktree.has(ev.tool_use_id)) {
      worktreeByPhaseId.set(ev.task_id, toolUseIdToWorktree.get(ev.tool_use_id));
    }
  }
  for (const agg of hookAggregates) {
    for (const exec of agg.executions) {
      if (!exec.worktree) continue;
      const phaseId = [...worktreeByPhaseId.entries()].find(([, wt]) => wt === exec.worktree)?.[0];
      if (!phaseId) continue;
      const phase = phases.find((p) => p.phaseId === phaseId);
      if (!phase) continue;
      phase.children.push({
        kind: 'hook',
        hookName: agg.hookName, hookType: agg.hookType,
        worktree: exec.worktree,
        startTs: exec.ts,
        endTs: exec.ts && exec.durationMs ? new Date(new Date(exec.ts).getTime() + exec.durationMs).toISOString() : exec.ts,
        durationMs: exec.durationMs,
        exitCode: exec.exitCode,
        result: exec.skip ? 'skip' : (exec.exitCode === 0 ? 'ok' : 'fail'),
      });
    }
  }
}

function aggregateSkills(phases) {
  const byName = new Map();
  for (const phase of phases) {
    for (const child of phase.children) {
      if (child.kind !== 'skill') continue;
      const row = byName.get(child.skill) ?? { skill: child.skill, count: 0, totalDurationMs: 0, invocations: [] };
      row.count++;
      row.totalDurationMs += child.durationMs || 0;
      row.invocations.push({ ts: child.ts, agentType: phase.agentType, phaseId: phase.phaseId });
      byName.set(child.skill, row);
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count);
}

const RULE_PATH_RE = /\.claude\/rules\/([^/]+\.md)$/;

function aggregateRules(events, phases) {
  const agentPhases = phases.filter((p) => p.kind === 'agent');
  const phaseByToolUseId = buildPhaseOwnerMap(events, agentPhases);
  const byFile = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (b.name !== 'Read') continue;
      const m = typeof b.input?.file_path === 'string' && b.input.file_path.match(RULE_PATH_RE);
      if (!m) continue;
      const ruleFile = m[1];
      const owner = resolvePhase(rec.event, phaseByToolUseId);
      const agentType = owner?.agentType ?? 'orchestrator';
      const row = byFile.get(ruleFile) ?? { ruleFile, reads: 0, readers: new Map() };
      row.reads++;
      row.readers.set(agentType, (row.readers.get(agentType) || 0) + 1);
      byFile.set(ruleFile, row);
    }
  }
  return [...byFile.values()]
    .map((r) => ({
      ruleFile: r.ruleFile, reads: r.reads,
      readers: [...r.readers].map(([agentType, count]) => ({ agentType, count })).sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.reads - a.reads);
}

function tailPayload(obj, maxLen = 800) {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
  } catch { return null; }
}

function detectErrors(events, phases, hooks) {
  const errs = [];
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'notification' && ev.priority === 'immediate') {
      errs.push({ kind: 'notification', ts: rec.ts, phaseId: null, teamName: null,
        summary: ev.text || ev.key || 'notification', payload: tailPayload(ev) });
    } else if (ev.type === 'result' && ev.is_error) {
      errs.push({ kind: 'turn_error', ts: rec.ts, phaseId: null, teamName: null,
        summary: `Turn failed: ${ev.api_error_status || ev.result || 'error'}`, payload: tailPayload(ev) });
    } else if (ev.type === 'system' && ev.subtype === 'task_notification' && ev.status === 'failed') {
      const phase = phases.find((p) => p.phaseId === ev.task_id);
      errs.push({ kind: 'task_failed', ts: rec.ts, phaseId: ev.task_id, teamName: phase?.teamName ?? null,
        summary: `${phase?.description ?? ev.task_id} failed`, payload: tailPayload(ev) });
    }
  }
  for (const h of hooks) {
    if (h.blocking) continue;
    for (const e of h.executions) {
      if (e.exitCode != null && e.exitCode !== 0) {
        errs.push({ kind: 'hook_failed', ts: e.ts, phaseId: null, teamName: null,
          summary: `${h.hookName} EXIT=${e.exitCode}`,
          payload: { hookName: h.hookName, worktree: e.worktree, exitCode: e.exitCode } });
      }
    }
  }
  return errs.sort((a, b) => a.ts.localeCompare(b.ts));
}

function commonPrefixRatio(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return Math.max(a.length, b.length) === 0 ? 1 : i / Math.max(a.length, b.length);
}

function detectRetries(phases, errors) {
  const retries = [];
  const sortedAgents = phases.filter((p) => p.kind === 'agent').sort((a, b) => a.startTs.localeCompare(b.startTs));
  const retrySet = new Set();

  const SUFFIX = /\((retry|after [^)]+)\)\s*$/i;
  for (const p of sortedAgents) {
    if (SUFFIX.test(p.description)) {
      retries.push({ ts: p.startTs, triggeredByErrorTs: null, phaseId: p.phaseId,
        description: p.description, matchMethod: 'suffix-parens-retry' });
      retrySet.add(p.phaseId);
    }
  }

  for (const err of errors.filter((e) => e.kind === 'task_failed')) {
    const errPhase = sortedAgents.find((p) => p.phaseId === err.phaseId);
    if (!errPhase) continue;
    const windowEnd = new Date(err.ts).getTime() + 5 * 60 * 1000;
    const cand = sortedAgents.find((p) =>
      !retrySet.has(p.phaseId) &&
      p.startTs > err.ts &&
      new Date(p.startTs).getTime() <= windowEnd &&
      commonPrefixRatio(errPhase.description, p.description) > 0.8
    );
    if (cand) {
      retries.push({ ts: cand.startTs, triggeredByErrorTs: err.ts, phaseId: cand.phaseId,
        description: cand.description, matchMethod: 'failure-followed-by-similar' });
      retrySet.add(cand.phaseId);
    }
  }

  for (let i = 0; i < sortedAgents.length; i++) {
    for (let j = i + 1; j < sortedAgents.length; j++) {
      const a = sortedAgents[i], b = sortedAgents[j];
      if (retrySet.has(b.phaseId) || a.description !== b.description) continue;
      if (new Date(b.startTs).getTime() - new Date(a.startTs).getTime() > 5 * 60 * 1000) continue;
      retries.push({ ts: b.startTs, triggeredByErrorTs: null, phaseId: b.phaseId,
        description: b.description, matchMethod: 'duplicate-description-5min' });
      retrySet.add(b.phaseId);
    }
  }

  return retries.sort((a, b) => a.ts.localeCompare(b.ts));
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
  const phases = [orchestrator, ...agentPhases].sort((a, b) => a.startTs.localeCompare(b.startTs));
  const timeBreakdown = agentPhases.length > 0 ? buildTimeBreakdown(orchestrator, agentPhases) : [];

  // Build phase children, tool counts, and leaderboards
  const { toolCounts, allToolCalls } = populateChildrenAndCounts(events, phases, orchestrator);

  // Only keep phases if orchestrator has children or if there are agent phases
  const hasOrchestratorWork = orchestrator.children.length > 0;
  const finalPhases = (hasOrchestratorWork || agentPhases.length > 0) ? phases : [];

  const topAgents = buildTopAgents(agentPhases);
  const topToolCalls = buildTopToolCalls(allToolCalls);

  // Read and correlate hooks.log
  const hookLines = await readHooksLog(hooksLogPath, startTs, endTs);
  const hooks = aggregateHooks(hookLines);
  assignHookExecsToPhases(events, phases, hooks);

  // Aggregate skills and rules
  const skills = aggregateSkills(finalPhases);
  const rules = aggregateRules(events, finalPhases);

  // Detect errors and retries
  const errors = detectErrors(events, phases, hooks);
  const retries = detectRetries(phases, errors);

  // Propagate error and retry counts to phases and teams
  for (const p of phases) {
    p.errorsCount = errors.filter((e) => e.phaseId === p.phaseId).length;
    p.retriesCount = retries.filter((r) => r.phaseId === p.phaseId).length;
  }
  for (const t of teams.values()) {
    t.errorsCount = errors.filter((e) => e.teamName === t.team_name).length;
  }

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
      errorsCount: errors.length,
      retriesCount: retries.length,
      timeBreakdown,
    },
    teams: [...teams.values()],
    phases: finalPhases,
    topAgents,
    topToolCalls,
    toolCounts,
    skills, hooks, rules, errors, retries,
  };
}
