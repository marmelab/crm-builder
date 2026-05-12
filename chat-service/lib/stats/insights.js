import { extractToolUsesFromAssistant, isDebugRaw, isDebugRawAssistant } from './events.js';
import { tailPayload, toUnixMs } from './io.js';
import { buildPhaseOwnerMap, resolvePhase } from './phases.js';

export function aggregateSkills(phases) {
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

export function aggregateRules(events, phases) {
  const agentPhases = phases.filter((p) => p.kind === 'agent');
  const phaseByToolUseId = buildPhaseOwnerMap(agentPhases);
  const byFile = new Map();
  for (const rec of events) {
    if (!isDebugRawAssistant(rec)) continue;
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

export function detectErrors(events, phases, hooks) {
  const errs = [];
  for (const rec of events) {
    if (!isDebugRaw(rec)) continue;
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

export function detectRetries(phases, errors) {
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
    const windowEnd = toUnixMs(err.ts) + 5 * 60 * 1000;
    const cand = sortedAgents.find((p) =>
      !retrySet.has(p.phaseId) &&
      p.startTs > err.ts &&
      toUnixMs(p.startTs) <= windowEnd &&
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
      if (toUnixMs(b.startTs) - toUnixMs(a.startTs) > 5 * 60 * 1000) continue;
      retries.push({ ts: b.startTs, triggeredByErrorTs: null, phaseId: b.phaseId,
        description: b.description, matchMethod: 'duplicate-description-5min' });
      retrySet.add(b.phaseId);
    }
  }

  return retries.sort((a, b) => a.ts.localeCompare(b.ts));
}
