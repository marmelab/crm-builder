// Session stats aggregator. Builds the panel data shown by /api/stats by
// folding `log.jsonl` + `hooks.log` + the per-session TASK-*.json tickets
// into a structured shape (summary, phases, teams, tickets/waves, hooks,
// skills, rules, errors, retries).
//
// The pipeline is sequenced top-down in `aggregateSession` below; each step
// lives in its own module under ./stats/ to keep concerns isolated.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { claudeSubagentsDir } from './server/config.js';

import { readJsonl, msBetween, computeSummary, summarizeFromPhases } from './stats/io.js';
import { extractTeams } from './stats/teams.js';
import {
  extractPhases, buildOrchestratorPhase, buildTimeBreakdown, computePhaseWorkMs,
  computeUserWaitMs, accumulatePerPhaseTokens,
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

  // Locate per-subagent transcripts. Prefer the local snapshot copied at turn
  // end (sessions/<id>/claude/subagents/); fall back to the live Claude CLI
  // path (~/.claude/projects/<slug>/<claudeSessionId>/subagents/) for sessions
  // that predate the snapshot feature or where the copy hasn't landed yet.
  let subagentsDir = null;
  try {
    const meta = JSON.parse(await readFile(join(dirname(sessionLogPath), 'meta.json'), 'utf8'));
    const claudeSessionId = meta.claudeSessionId ?? null;
    if (claudeSessionId) {
      const localDir = join(dirname(sessionLogPath), 'claude', 'subagents');
      const remoteDir = claudeSubagentsDir(claudeSessionId);
      // Prefer local snapshot; fall back to live ~/.claude path.
      subagentsDir = await readdir(localDir).then(() => localDir).catch(() => remoteDir);
    }
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

  // Fill in token breakdown + cost for orchestrator and local_agent phases by
  // walking each assistant message's `usage` in the main stream. Without this,
  // planner/simple-developer phases only have `total_tokens` from
  // task_notification (no per-component split) and no cost at all.
  // `in_process_teammate` phases are left alone — their data comes from
  // enrichSubagentChildren which reads the per-subagent JSONL files.
  accumulatePerPhaseTokens(events, phases);

  // Build phase children, tool counts, and leaderboards.
  // Must run before workMs/timeBreakdown so children are populated.
  // Side effect: `enrichSubagentChildren` (called inside) populates
  // `tokensByModel` + `costUsd` for in_process_teammate phases.
  const { toolCounts, allToolCalls } = await populateChildrenAndCounts(events, phases, orchestrator, subagentsDir);

  // Build the authoritative summary from the per-phase deduped breakdowns
  // (orchestrator + local_agent via accumulatePerPhaseTokens, in_process_teammate
  // via enrichSubagentChildren above). This is the single source of truth: a
  // per-message-id-deduped transcript sum, priced with MODEL_RATES. summary and
  // phases are now consistent BY CONSTRUCTION — sum(phase) === summary — so the
  // old calibratePhaseCostsToSdk rescaling is gone. The log-derived
  // computeSummary(events) is kept only for opsCount + as a fallback for
  // sessions with no phase data (e.g. trivial single-turn fixtures).
  const phaseSummary = summarizeFromPhases(phases);
  const havePhaseTokens = phaseSummary.tokensByModel.length > 0;
  if (havePhaseTokens) {
    s.tokensTotal = phaseSummary.tokensTotal;
    s.tokensBreakdown = phaseSummary.tokensBreakdown;
    s.tokensByModel = phaseSummary.tokensByModel;
    s.costUsd = phaseSummary.costUsd;
  }

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

  // summary tokens/cost already include sub-agent consumption: summarizeFromPhases
  // sums every phase's deduped breakdown (orchestrator + local_agent +
  // in_process_teammate), so the in_process_teammate tokens are already in the
  // total — do NOT re-add them.
  //
  // opsCount is different: it comes from computeSummary, which walks only the
  // orchestrator's main stream and so misses in_process_teammate tool_uses
  // (those live in their own subagent JSONL files). Add the COMPLEX-team ops
  // back in here.
  let extraOps = 0;
  for (const p of agentPhases) {
    if (p.taskType === 'in_process_teammate') extraOps += p.opsCount || 0;
  }
  s.opsCount += extraOps;

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
      tokensBreakdown: s.tokensBreakdown,
      tokensByModel: s.tokensByModel,
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
