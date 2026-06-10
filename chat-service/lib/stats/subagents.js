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
  // 1. Read each .meta.json + the first JSONL event → firstUuid + firstType + size.
  // 2. Group files by (agentName, firstUuid). Keep only the LARGEST file per
  //    group (the latest snapshot contains every prior event).
  // 3. A group whose first event is `type:"system"` is NOT a fresh activation
  //    but a context-compaction continuation (new firstUuid). Treat it as a
  //    continuation, not a separate activation — otherwise an agent that
  //    compacts has more groups than phases, and the 1:1 mtime alignment can
  //    bind its phase to the tiny stub and drop the real transcript.
  // 4. Align real activations 1:1 with phases (both sorted ascending). Merge
  //    each compaction continuation into the last aligned phase of that agent.
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
    const { firstUuid, firstType } = await readFirstEvent(jsonlPath);
    if (!firstUuid) continue;
    fileMeta.push({
      path: jsonlPath, agentName: meta.agentType,
      firstUuid, firstType, size: st.size, mtimeMs: st.mtimeMs,
    });
  }

  // Group by (agentName, firstUuid), pick largest per group.
  const groups = new Map(); // key=name|firstUuid → best
  for (const f of fileMeta) {
    const k = f.agentName + '|' + f.firstUuid;
    const cur = groups.get(k);
    if (!cur || cur.size < f.size) groups.set(k, f);
  }

  // Split each agent's groups into real activations vs compaction continuations.
  const byName = new Map(); // agentName → { activations:[], continuations:[] }
  for (const f of groups.values()) {
    const slot = byName.get(f.agentName) || { activations: [], continuations: [] };
    (f.firstType === 'system' ? slot.continuations : slot.activations).push(f);
    byName.set(f.agentName, slot);
  }

  const phasesByName = new Map();
  for (const p of targets) {
    const list = phasesByName.get(p.agentName) || [];
    list.push(p);
    phasesByName.set(p.agentName, list);
  }

  for (const [name, phasesForName] of phasesByName) {
    const slot = byName.get(name) || { activations: [], continuations: [] };
    const activations = [...slot.activations].sort((a, b) => a.mtimeMs - b.mtimeMs);
    const continuations = [...slot.continuations].sort((a, b) => a.mtimeMs - b.mtimeMs);
    const phasesSorted = [...phasesForName].sort((a, b) => a.startTs.localeCompare(b.startTs));
    if (phasesSorted.length === 0) continue;

    // Build the file list each phase should aggregate: its aligned activation,
    // plus (on the last phase) every compaction continuation for this agent.
    const phaseFiles = phasesSorted.map(() => []);
    const n = Math.min(activations.length, phasesSorted.length);
    for (let i = 0; i < n; i++) phaseFiles[i].push(activations[i]);
    for (const c of continuations) phaseFiles[phaseFiles.length - 1].push(c);

    for (let i = 0; i < phasesSorted.length; i++) {
      if (!phaseFiles[i].length) continue;
      const paths = phaseFiles[i].sort((a, b) => a.mtimeMs - b.mtimeMs).map((f) => f.path);
      await appendSubagentToolUses(paths, phasesSorted[i], toolCounts, allToolCalls);
    }
  }
}

async function readFirstEvent(jsonlPath) {
  // Read just the first line to extract its uuid (stable identity for "this
  // activation" across cumulative resume snapshots) and its type (`system` ⇒ a
  // context-compaction continuation rather than a fresh dispatch).
  try {
    for await (const ev of readJsonl(jsonlPath)) {
      return { firstUuid: ev?.uuid ?? null, firstType: ev?.type ?? null };
    }
  } catch { /* empty or unreadable */ }
  return { firstUuid: null, firstType: null };
}

async function appendSubagentToolUses(files, phase, toolCounts, allToolCalls) {
  // `files` is the ordered list of transcripts that make up ONE phase: the
  // activation's largest snapshot, plus any context-compaction continuations.
  // Reset the phase once, then accumulate across all of them (message ids are
  // unique per conversation, so cross-file token dedup is automatic).
  phase.tokensTotal = 0;
  phase.opsCount = 0;
  phase.tokensBreakdown = emptyBreakdown();
  phase.costUsd = 0;
  const tokensByModelMap = new Map(); // model → breakdown
  // Per-message dedup for tokens: each tool_use generates two assistant events
  // sharing the same `message.id` — once we decide to use a tool, then again
  // after streaming. Sum tokens only from the FIRST occurrence per message id.
  const tokensByMessageId = new Set();
  let lastEventTs = null;

  for (const file of files) {
    const events = [];
    try {
      for await (const ev of readJsonl(file)) events.push(ev);
    } catch { continue; }
    if (events.length) lastEventTs = events[events.length - 1].timestamp || lastEventTs;

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
        // Surface the agent's own narration ("text" blocks) as discrete children
        // so the chronology can show the full prose, not just tool calls. Same
        // data the live subagent-tail emits to debug mode — this is the on-disk
        // equivalent for an after-the-fact stats view.
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          phase.children.push({
            kind: 'agent_text',
            ts: e.timestamp,
            text: b.text,
          });
          continue;
        }
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
          const child = {
            kind: 'tool_use',
            tool: b.name, detail: toolDetail(b.name, b.input),
            ts: e.timestamp, durationMs, isApprox,
            agentType: phase.agentType,
            verdict: b.name === 'SendMessage' ? sendMessageVerdictFromInput(b.input) : null,
          };
          // SendMessage carries the full inter-agent payload — stash it on the
          // child so the renderer can expand it (the `detail` field is truncated
          // to a one-line preview).
          if (b.name === 'SendMessage') {
            const raw = b.input?.message ?? b.input?.content ?? null;
            if (typeof raw === 'string' && raw.trim()) child.fullContent = raw;
          }
          phase.children.push(child);
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
  } // end for (const file of files)

  // Materialise the per-model rows used by the cost-badge tooltip.
  phase.tokensByModel = [...tokensByModelMap].map(([model, breakdown]) => ({
    model, breakdown, costUsd: costFromBreakdown(model, breakdown),
  })).sort((a, b) => b.costUsd - a.costUsd);

  // If the phase never received a task_notification (endTs still null), derive
  // timing from the last event across all its transcripts (activation +
  // compaction continuations). More accurate than the session-end fallback.
  if (!phase.endTs && lastEventTs) {
    phase.endTs = lastEventTs;
    phase.durationMs = msBetween(phase.startTs, lastEventTs);
    phase.durationApprox = true;
  }
}

export { SKIP_CHILD };
