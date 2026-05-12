import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readJsonl, msBetween, emptyBreakdown, addBreakdown, breakdownFromUsage,
  costFromBreakdown,
} from './io.js';
import { toolDetail, sendMessageVerdictFromInput } from './tools.js';

// Tool calls excluded from per-phase children. Keep dispatch-control verbs
// (Agent/Task/TeamCreate/TeamDelete) visible in the orchestrator timeline —
// previously they were skipped, leaving an unexplained 1-2min gap between
// the planner's reply and the first dev's GO.
const SKIP_CHILD = new Set();

// Enrich COMPLEX team members (task_type='in_process_teammate') with their
// tool calls — those live in `~/.claude/projects/-app/<claudeSessionId>/subagents/agent-<task_id>.jsonl`,
// never streamed into the orchestrator's main log. Without this, every
// COMPLEX agent phase shows up empty in the stats UI.
export async function enrichSubagentChildren(phases, subagentsDir, toolCounts, allToolCalls) {
  const baseDir = subagentsDir;

  // Only target COMPLEX team members. Local agents (planner, simple-developer)
  // already have their tool_uses in the main stream via parent_tool_use_id —
  // loading their subagent files would double-count.
  const targets = phases.filter((p) =>
    p.kind === 'agent' && p.taskType === 'in_process_teammate' && p.agentName
  );
  if (targets.length === 0) return;

  let dirEntries;
  try {
    dirEntries = await readdir(baseDir);
  } catch {
    return; // dir absent (no team ran yet, or different layout)
  }

  // Each agent activation (initial dispatch + every SendMessage wake-up) writes
  // a NEW agent-<taskId>.jsonl, but each one is a CUMULATIVE transcript of the
  // entire team session up to that point — sharing the same first-message uuid.
  // Loading every file would replay every tool_use N times. Strategy:
  //
  // 1. Read each .meta.json + the first JSONL line to get firstUuid + size.
  // 2. Group files by (agentName, firstUuid) — that identifies one team session
  //    activation. Keep only the LARGEST file per group (the latest snapshot
  //    contains every prior event).
  // 3. Sort the surviving files by mtime ASC, then align them with the phases
  //    sorted by startTs ASC (same agentName can appear in multiple waves —
  //    e.g. shared "merger" across two TeamCreate cycles).
  const fileMeta = [];
  for (const entry of dirEntries) {
    if (!entry.endsWith('.meta.json')) continue;
    const baseName = entry.slice(0, -'.meta.json'.length);
    const metaPath = join(baseDir, entry);
    const jsonlPath = join(baseDir, baseName + '.jsonl');
    let meta;
    try { meta = JSON.parse(await readFile(metaPath, 'utf8')); } catch { continue; }
    if (!meta.agentType) continue;
    let st;
    try { st = await stat(jsonlPath); } catch { continue; }
    const firstUuid = await readFirstUuid(jsonlPath);
    if (!firstUuid) continue;
    fileMeta.push({
      path: jsonlPath, agentName: meta.agentType,
      firstUuid, size: st.size, mtimeMs: st.mtimeMs,
    });
  }

  // Group by (agentName, firstUuid), pick largest per group.
  const winnersByName = new Map(); // agentName → [{path, mtimeMs}, …]
  const groups = new Map(); // key=name|firstUuid → best
  for (const f of fileMeta) {
    const k = f.agentName + '|' + f.firstUuid;
    const cur = groups.get(k);
    if (!cur || cur.size < f.size) groups.set(k, f);
  }
  for (const f of groups.values()) {
    const list = winnersByName.get(f.agentName) || [];
    list.push(f);
    winnersByName.set(f.agentName, list);
  }

  const phasesByName = new Map();
  for (const p of targets) {
    const list = phasesByName.get(p.agentName) || [];
    list.push(p);
    phasesByName.set(p.agentName, list);
  }

  for (const [name, phasesForName] of phasesByName) {
    const winners = (winnersByName.get(name) || []).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const phasesSorted = [...phasesForName].sort((a, b) => a.startTs.localeCompare(b.startTs));
    const n = Math.min(winners.length, phasesSorted.length);
    for (let i = 0; i < n; i++) {
      await appendSubagentToolUses(winners[i].path, phasesSorted[i], toolCounts, allToolCalls);
    }
  }
}

async function readFirstUuid(jsonlPath) {
  // Read just the first line to extract its uuid — used as a stable identity
  // for "this team-session activation" across cumulative resume snapshots.
  try {
    for await (const ev of readJsonl(jsonlPath)) {
      return ev?.uuid ?? null;
    }
  } catch { /* empty or unreadable */ }
  return null;
}

async function appendSubagentToolUses(file, phase, toolCounts, allToolCalls) {
  const events = [];
  try {
    for await (const ev of readJsonl(file)) events.push(ev);
  } catch { return; }

  // tool_result timestamps for duration computation
  const toolResultTsById = new Map();
  for (const e of events) {
    if (e.type !== 'user' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c.type === 'tool_result' && c.tool_use_id) {
        toolResultTsById.set(c.tool_use_id, e.timestamp);
      }
    }
  }

  // Defensive reset before refilling from the subagent JSONL (the authoritative
  // source for in_process_teammate phases). task_notification.usage is
  // currently null for in_process_teammate so phase.tokensTotal / opsCount
  // arrive at 0 from extractPhases — but if the SDK ever populates those
  // fields, summing here would double-count. Same for the breakdown.
  phase.tokensTotal = 0;
  phase.opsCount = 0;
  phase.tokensBreakdown = emptyBreakdown();
  phase.costUsd = 0;
  const tokensByModelMap = new Map(); // model → breakdown

  // Per-message dedup for tokens: each tool_use generates two assistant events
  // sharing the same `message.id` — once we decide to use a tool, then again
  // after streaming. Only the second carries the final usage; both can have
  // partial usage. Sum tokens only from the FIRST occurrence per message id
  // to avoid double-count.
  const tokensByMessageId = new Set();

  for (const e of events) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    const u = e.message?.usage;
    const msgId = e.message?.id;
    if (u && msgId && !tokensByMessageId.has(msgId)) {
      tokensByMessageId.add(msgId);
      // Track the full breakdown (input + cache_creation + output + cache_read)
      // so the per-phase tooltip can show the same 4-way split as the global
      // summary. tokensTotal is the legacy sum (cache_read excluded) kept for
      // back-compat with any code still reading that field.
      const b = breakdownFromUsage(u);
      phase.tokensBreakdown = addBreakdown(phase.tokensBreakdown, b);
      phase.tokensTotal += b.input + b.cacheCreate + b.output;
      if (e.message.model) {
        phase.costUsd = (phase.costUsd || 0) + costFromBreakdown(e.message.model, b);
        const prev = tokensByModelMap.get(e.message.model) || emptyBreakdown();
        tokensByModelMap.set(e.message.model, addBreakdown(prev, b));
      }
    }

    for (const b of e.message.content) {
      if (b.type !== 'tool_use' || SKIP_CHILD.has(b.name)) continue;
      phase.opsCount = (phase.opsCount || 0) + 1;

      const trTs = toolResultTsById.get(b.id) ?? null;
      const durationMs = trTs ? Math.max(0, msBetween(e.timestamp, trTs)) : 0;
      const isApprox = !trTs;
      if (b.name === 'Skill') {
        phase.children.push({
          kind: 'skill', skill: b.input?.skill || 'unknown',
          ts: e.timestamp, durationMs, isApprox,
        });
      } else {
        phase.children.push({
          kind: 'tool_use',
          tool: b.name, detail: toolDetail(b.name, b.input),
          ts: e.timestamp, durationMs, isApprox,
          agentType: phase.agentType,
          verdict: b.name === 'SendMessage' ? sendMessageVerdictFromInput(b.input) : null,
        });
        const tc = toolCounts.get(b.name) || { tool: b.name, count: 0, totalDurationMs: 0 };
        tc.count++; tc.totalDurationMs += durationMs;
        toolCounts.set(b.name, tc);
        allToolCalls.push({
          phaseId: phase.phaseId, tool: b.name, detail: toolDetail(b.name, b.input),
          durationMs, isApprox,
          teamName: phase.teamName ?? null,
          flaggedSlow: durationMs > 30000,
          ts: e.timestamp,
        });
      }
    }
  }

  // Materialise the per-model rows used by the cost-badge tooltip.
  phase.tokensByModel = [...tokensByModelMap].map(([model, breakdown]) => ({
    model, breakdown, costUsd: costFromBreakdown(model, breakdown),
  })).sort((a, b) => b.costUsd - a.costUsd);

  // If the phase never received a task_notification (endTs still null), derive
  // timing from the subagent transcript's first/last event timestamps. This is
  // more accurate than using session-end as a fallback.
  if (!phase.endTs && events.length > 0) {
    const lastTs = events[events.length - 1].timestamp;
    if (lastTs) {
      phase.endTs = lastTs;
      phase.durationMs = msBetween(phase.startTs, lastTs);
      phase.durationApprox = true;
    }
  }
}

export { SKIP_CHILD };
