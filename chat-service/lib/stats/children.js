import { msBetween } from './io.js';
import {
  buildEventTsIndex, countEventsStrictlyBetween, buildToolResultMap, isDebugRawAssistant,
} from './events.js';
import { toolDetail, sendMessageVerdictFromInput } from './tools.js';
import { buildPhaseOwnerMap, resolvePhase } from './phases.js';
import { enrichSubagentChildren, SKIP_CHILD } from './subagents.js';

const STREAM_GAP_THRESHOLD_MS = 1000;
const THINKING_PREVIEW_MAX_CHARS = 300;

function previewFromBuffer(buf) {
  if (!buf || buf.length === 0) return null;
  const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return null;
  return joined.length > THINKING_PREVIEW_MAX_CHARS
    ? joined.slice(0, THINKING_PREVIEW_MAX_CHARS - 1) + '…'
    : joined;
}

export async function populateChildrenAndCounts(events, phases, orchestrator, subagentsDir) {
  const agentPhases = phases.filter((p) => p.kind === 'agent');
  const phaseByToolUseId = buildPhaseOwnerMap(agentPhases);
  const toolResultTsByToolUseId = buildToolResultMap(events);
  const eventTsIndex = buildEventTsIndex(events);
  const toolCounts = new Map();
  const allToolCalls = [];
  const lastToolResultTsByPhase = new Map();
  const thinkingBufferByPhase = new Map();

  for (const rec of events) {
    if (!isDebugRawAssistant(rec)) continue;
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
            verdict: b.name === 'SendMessage' ? sendMessageVerdictFromInput(b.input) : null,
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

  if (subagentsDir) {
    await enrichSubagentChildren(phases, subagentsDir, toolCounts, allToolCalls);
  }

  for (const c of allToolCalls) delete c._toolUseId;

  return {
    toolCounts: [...toolCounts.values()].sort((a, b) => b.count - a.count),
    allToolCalls,
  };
}
