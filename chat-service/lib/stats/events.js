// Event-shape helpers — pure functions over the JSONL records.
// Centralised here so phases/children/hooks all share a consistent extraction
// strategy and any change to the event shape lands in one place.

export function extractToolUsesFromAssistant(ev) {
  if (ev.type !== 'assistant') return [];
  return (ev.message?.content || []).filter((b) => b.type === 'tool_use');
}

export function extractToolResultsFromUser(ev) {
  if (ev.type !== 'user') return [];
  return (ev.message?.content || []).filter((b) => b.type === 'tool_result');
}

// Both kinds of task_started events represent a real subagent we want to track:
// - 'local_agent': dispatched without team_name (planner, simple-developer, ...).
// - 'in_process_teammate': dispatched into a team (developer-TASK-XXX, reviewers,
//   merger). Without this second case, COMPLEX runs only show orchestrator+planner.
export function isAgentTaskStart(ev) {
  return ev.type === 'system'
    && ev.subtype === 'task_started'
    && (ev.task_type === 'local_agent' || ev.task_type === 'in_process_teammate');
}

export function buildEventTsIndex(events) {
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

export function countEventsStrictlyBetween(tsIndex, startTs, endTs) {
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

export function buildToolResultMap(events) {
  const m = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'user') continue;
    for (const b of extractToolResultsFromUser(rec.event)) {
      if (b.tool_use_id && !m.has(b.tool_use_id)) m.set(b.tool_use_id, rec.ts);
    }
  }
  return m;
}

export function extractWorktreeFromAgentPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  // SIMPLE flow uses `WORKTREE_PATH=…`; COMPLEX team prompts use `WORKTREE: …`.
  // Match both so hook executions can be attached to the right phase regardless
  // of which dispatch path produced the agent.
  const m = prompt.match(/WORKTREE(?:_PATH)?[=:]\s*(\S+)/);
  return m ? m[1] : null;
}
