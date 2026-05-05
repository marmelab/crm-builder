import { readFile } from 'node:fs/promises';
import { msBetween } from './io.js';
import { extractToolUsesFromAssistant, extractWorktreeFromAgentPrompt } from './events.js';

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
        tail: null,
      });
    } else if (line.kind === 'exit') {
      const start = openByName.get(line.shortName);
      const startTs = start?.ts ?? line.ts;
      openByName.delete(line.shortName);
      if (!start?.sawPerWorktree) {
        execsByName.get(fullName).push({
          ts: startTs, worktree: line.worktree ?? null,
          durationMs: msBetween(startTs, line.ts),
          exitCode: line.exitCode, tail: null,
        });
      }
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

export function assignHookExecsToPhases(events, phases, hookAggregates) {
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
  const phaseIdByWorktree = new Map();
  for (const [phaseId, wt] of worktreeByPhaseId) phaseIdByWorktree.set(wt, phaseId);
  for (const agg of hookAggregates) {
    for (const exec of agg.executions) {
      if (!exec.worktree) continue;
      const phaseId = phaseIdByWorktree.get(exec.worktree);
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
