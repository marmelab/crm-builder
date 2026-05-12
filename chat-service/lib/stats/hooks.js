import { readFile } from 'node:fs/promises';
import { msBetween, toUnixMs } from './io.js';
import { extractToolUsesFromAssistant, extractWorktreeFromAgentPrompt, isDebugRaw, isDebugRawAssistant } from './events.js';

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
  'validate-before-review': 'validate-before-review.sh',
};
const BLOCKING_HOOKS = new Set([
  'block-bash-file-write.sh','block-bash-validation.sh','circuit-breaker.sh','silent-mode-check.sh',
  'validate-before-review.sh',
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
  else if (state === 'FAIL') {
    kind = 'fail';
    const em = rest.match(/EXIT=(\d+)/);
    exitCode = em ? Number(em[1]) : 2;
  }
  else if (state.startsWith('EXIT=')) { kind = 'exit'; exitCode = Number(state.slice(5)); }
  return { ts, shortName, kind, exitCode, worktree, rest };
}

export async function readHooksLog(path, winStart, winEnd) {
  if (!path) return [];
  const raw = await readFile(path, 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  const ws = winStart ? toUnixMs(winStart) : 0;
  const we = winEnd ? toUnixMs(winEnd) : Infinity;
  for (const l of lines) {
    const p = parseHookLine(l);
    if (!p) continue;
    const t = toUnixMs(p.ts);
    if (Number.isNaN(t) || t < ws || t > we) continue;
    out.push(p);
  }
  return out;
}

export function aggregateHooks(hookLines) {
  // A "run" is bracketed by START / EXIT in the log. Inside, the script logs
  // per-worktree OK or FAIL lines (each with wt=…). We prefer those as
  // executions because they carry the worktree info needed to attach hooks
  // to the right phase in the timeline. The wrap-up EXIT line carries no
  // worktree, so we only emit it as an execution when the run produced no
  // per-worktree result (e.g. e2e, which doesn't loop on worktrees).
  const openByName = new Map(); // shortName → { ts, sawPerWorktree }
  const execsByName = new Map();
  for (const line of hookLines) {
    const fullName = HOOK_NAME_MAP[line.shortName] || `${line.shortName}.sh`;
    if (!execsByName.has(fullName)) execsByName.set(fullName, []);
    if (line.kind === 'start') {
      openByName.set(line.shortName, { ts: line.ts, sawPerWorktree: false });
    } else if (line.kind === 'ok' || line.kind === 'fail') {
      const start = openByName.get(line.shortName);
      if (start) start.sawPerWorktree = true;
      const startTs = start?.ts ?? line.ts;
      execsByName.get(fullName).push({
        ts: startTs,
        worktree: line.worktree ?? null,
        durationMs: msBetween(startTs, line.ts),
        exitCode: line.kind === 'ok' ? 0 : (line.exitCode ?? 2),
      });
    } else if (line.kind === 'exit') {
      const start = openByName.get(line.shortName);
      const startTs = start?.ts ?? line.ts;
      openByName.delete(line.shortName);
      if (!start?.sawPerWorktree) {
        execsByName.get(fullName).push({
          ts: startTs, worktree: line.worktree ?? null,
          durationMs: msBetween(startTs, line.ts),
          exitCode: line.exitCode,
        });
      }
    } else if (line.kind === 'skip') {
      execsByName.get(fullName).push({
        ts: line.ts, worktree: line.worktree, durationMs: 0, exitCode: null, skip: true,
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

export function assignHookExecsToPhases(events, phases, hookAggregates) {
  const worktreeByPhaseId = new Map();
  const toolUseIdToWorktree = new Map();
  for (const rec of events) {
    if (!isDebugRawAssistant(rec)) continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if ((b.name === 'Agent' || b.name === 'Task') && b.input?.prompt) {
        const wt = extractWorktreeFromAgentPrompt(b.input.prompt);
        if (wt) toolUseIdToWorktree.set(b.id, wt);
      }
    }
  }
  for (const rec of events) {
    if (!isDebugRaw(rec)) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_started' && ev.tool_use_id && toolUseIdToWorktree.has(ev.tool_use_id)) {
      worktreeByPhaseId.set(ev.task_id, toolUseIdToWorktree.get(ev.tool_use_id));
    }
  }
  // Build per-worktree lookup structures.
  // developer phases: collected into a sorted list so hook executions can be
  //   matched to the right resume iteration by timestamp rather than first-wins.
  // fallback phases: first non-developer phase for worktrees with no developer.
  const devPhasesByWorktree = new Map();  // wt → [{phaseId, startTs, endTs}]
  const fallbackPhaseByWorktree = new Map(); // wt → phaseId
  for (const [phaseId, wt] of worktreeByPhaseId) {
    const phase = phases.find((p) => p.phaseId === phaseId);
    if (!phase) continue;
    if (phase.agentType === 'developer') {
      if (!devPhasesByWorktree.has(wt)) devPhasesByWorktree.set(wt, []);
      devPhasesByWorktree.get(wt).push({ phaseId, startTs: phase.startTs, endTs: phase.endTs });
    } else if (!fallbackPhaseByWorktree.has(wt)) {
      fallbackPhaseByWorktree.set(wt, phaseId);
    }
  }
  for (const list of devPhasesByWorktree.values()) {
    list.sort((a, b) => (a.startTs || '').localeCompare(b.startTs || ''));
    // Interrupted phases (endTs=null) would match [startTs, Infinity] and swallow
    // all hooks from later resume iterations. Cap them at the next phase's startTs.
    for (let i = 0; i < list.length - 1; i++) {
      if (!list[i].endTs) list[i].effectiveEnd = list[i + 1].startTs;
    }
  }

  // Find the developer phase whose time window contains hookTs. When the
  // developer was resumed (same worktree, multiple phases), each hook execution
  // is attributed to the phase that was active at that point in time rather
  // than all hooks being piled onto the first dispatch.
  const resolvePhaseId = (worktree, hookTs) => {
    const devPhases = devPhasesByWorktree.get(worktree);
    if (devPhases?.length) {
      if (devPhases.length === 1) return devPhases[0].phaseId;
      const t = hookTs ? toUnixMs(hookTs) : NaN;
      if (!Number.isNaN(t)) {
        for (const dp of devPhases) {
          const s = dp.startTs ? toUnixMs(dp.startTs) : -Infinity;
          const e = (dp.endTs ?? dp.effectiveEnd) ? toUnixMs(dp.endTs ?? dp.effectiveEnd) : Infinity;
          if (t >= s && t <= e) return dp.phaseId;
        }
        // Hook timestamp falls in a gap between runs — pick the nearest phase.
        let best = devPhases[0];
        let bestDist = Math.abs(t - toUnixMs(best.startTs || 0));
        for (const dp of devPhases.slice(1)) {
          const dist = Math.abs(t - toUnixMs(dp.startTs || 0));
          if (dist < bestDist) { best = dp; bestDist = dist; }
        }
        return best.phaseId;
      }
      return devPhases[devPhases.length - 1].phaseId;
    }
    return fallbackPhaseByWorktree.get(worktree) ?? null;
  };

  for (const agg of hookAggregates) {
    for (const exec of agg.executions) {
      if (!exec.worktree) continue;
      const phaseId = resolvePhaseId(exec.worktree, exec.ts);
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
