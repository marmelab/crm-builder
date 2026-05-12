// Session stats aggregator. Builds the panel data shown by /api/stats by
// folding `log.jsonl` + `hooks.log` + the per-session TASK-*.json tickets
// into a structured shape (summary, phases, teams, tickets/waves, hooks,
// skills, rules, errors, retries).
//
// The pipeline is sequenced top-down in `aggregateSession` below; each step
// lives in its own module under ./stats/ to keep concerns isolated.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readJsonl, msBetween, computeSummary } from './stats/io.js';
import { extractTeams } from './stats/teams.js';
import {
  extractPhases, buildOrchestratorPhase, buildTimeBreakdown, computePhaseWorkMs,
  computeUserWaitMs,
} from './stats/phases.js';
import { populateChildrenAndCounts } from './stats/children.js';
import { readHooksLog, aggregateHooks, assignHookExecsToPhases } from './stats/hooks.js';
import { aggregateSkills, aggregateRules, detectErrors, detectRetries } from './stats/insights.js';
import { loadTicketsAndWaves } from './stats/tickets.js';

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

  // Session bounds: ignore client-noise events that fire on tab open / WebSocket
  // reconnect (`init`, `progress`, `status`, `state`, `stats`, `choices`,
  // `title`). They can land long after the actual conversation finishes —
  // observed: a reconnect 32 minutes after the last reply pushed totalMs from
  // 17 min to 50 min. Real session boundaries come from substantive events:
  // user_message, message, debug_raw (Claude SDK stream), error.
  const SUBSTANTIVE = new Set(['user_message', 'message', 'debug_raw', 'error']);
  const substantive = events.filter((ev) => ev.ts && SUBSTANTIVE.has(ev.type));
  const startTs = substantive[0]?.ts ?? events[0]?.ts ?? null;
  const endTs = substantive[substantive.length - 1]?.ts ?? events[events.length - 1]?.ts ?? null;
  const durationMs = startTs && endTs ? msBetween(startTs, endTs) : 0;

  // Read claudeSessionId from meta.json (sibling of log.jsonl) — needed to
  // locate per-subagent transcripts under ~/.claude/projects/-app/<id>/subagents/.
  let claudeSessionId = null;
  try {
    const meta = JSON.parse(await readFile(join(dirname(sessionLogPath), 'meta.json'), 'utf8'));
    claudeSessionId = meta.claudeSessionId ?? null;
  } catch { /* meta missing or unreadable — subagent enrichment will be skipped */ }

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

  const userWaitMs = computeUserWaitMs(events);
  const orchestrator = buildOrchestratorPhase(events, agentPhases, startTs, endTs, userWaitMs);
  const phases = [orchestrator, ...agentPhases].sort((a, b) => a.startTs.localeCompare(b.startTs));

  // Build phase children, tool counts, and leaderboards.
  // Must run before workMs/timeBreakdown so children are populated.
  const { toolCounts, allToolCalls } = await populateChildrenAndCounts(events, phases, orchestrator, claudeSessionId);

  // Derive workMs (active-work time) per phase from the tool_use children.
  // For COMPLEX team members, durationMs includes long idle waits — workMs
  // is the actual hands-on-keyboard time.
  for (const p of phases) p.workMs = computePhaseWorkMs(p);

  // Last-resort fallback: phases that still have no endTs after enrichment
  // (transcript files absent or unmatched) get session-end as an upper-bound
  // estimate so the UI shows something instead of "—".
  for (const p of agentPhases) {
    if (!p.endTs && p.startTs && endTs) {
      p.endTs = endTs;
      p.durationMs = msBetween(p.startTs, endTs);
      p.durationApprox = true;
    }
  }

  const timeBreakdown = agentPhases.length > 0 ? buildTimeBreakdown(orchestrator, agentPhases) : [];

  // Add the COMPLEX subagents' tokens/ops to the session-level summary.
  // computeSummary only sees the orchestrator's main log; subagent transcripts
  // (loaded by enrichSubagentChildren) carry the bulk of the work for COMPLEX
  // runs and must be added so the dashboard totals match reality.
  let extraOps = 0, extraTokens = 0;
  for (const p of agentPhases) {
    if (p.taskType === 'in_process_teammate') {
      extraOps += p.opsCount || 0;
      extraTokens += p.tokensTotal || 0;
    }
  }
  s.opsCount += extraOps;
  s.tokensTotal += extraTokens;

  // Only keep phases if orchestrator has children or if there are agent phases
  const hasOrchestratorWork = orchestrator.children.length > 0;
  const finalPhases = (hasOrchestratorWork || agentPhases.length > 0) ? phases : [];

  const topAgents = buildTopAgents(agentPhases);
  const topToolCalls = buildTopToolCalls(allToolCalls);

  // Read and correlate hooks.log
  const hookLines = await readHooksLog(hooksLogPath, startTs, endTs);
  const hooks = aggregateHooks(hookLines);
  assignHookExecsToPhases(events, phases, hooks);

  // Sort each phase's children chronologically so tools and hooks interleave
  // in the timeline rather than tools-then-hooks (hooks are pushed last so
  // their MM:SS would otherwise sit at the bottom of the row but with earlier
  // timestamps than the trailing tools).
  const childTs = (c) => c.ts || c.startTs || '';
  for (const p of phases) {
    p.children.sort((a, b) => childTs(a).localeCompare(childTs(b)));
  }

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
    ...(await loadTicketsAndWaves(dirname(sessionLogPath))) ?? {},
  };
}
