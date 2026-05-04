import { el, formatDuration, formatTokens } from '../dom.js';

// Extract a TASK identifier (e.g. "TASK-003") from an agent name like
// "developer-TASK-003" or from a phase description. Returns null if none.
const TASK_ID_RE = /(TASK-\d{3,})/;
function extractTaskId(s) {
  if (!s) return null;
  const m = String(s).match(TASK_ID_RE);
  return m ? m[1] : null;
}

// Group COMPLEX phases by ticket (task id). Singletons like "merger" appear
// once per wave; we pair them with their ticket via startTs proximity to the
// developer of that ticket. For the recap row we just show one pill per
// distinct task id with its agents count and total wallclock.
function buildTaskPills(phases) {
  const byTask = new Map();
  for (const p of phases) {
    if (p.kind !== 'agent') continue;
    const id = extractTaskId(p.agentName) ?? extractTaskId(p.description);
    if (!id) continue;
    const slot = byTask.get(id) || { taskId: id, agents: 0, durationMs: 0, errorsCount: 0 };
    slot.agents++;
    slot.durationMs = Math.max(slot.durationMs, p.durationMs || 0);
    slot.errorsCount += p.errorsCount || 0;
    byTask.set(id, slot);
  }
  // Account for the shared merger: count it once per task by looking at
  // mergers whose interval overlaps with the task's developer. Cheaper proxy:
  // bump every task by +1 if at least one merger phase exists in `phases`.
  const mergers = phases.filter((p) => p.agentName === 'merger' && p.kind === 'agent').length;
  if (mergers > 0) {
    for (const slot of byTask.values()) slot.agents++;
  }
  return [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export function renderSummarySection(data) {
  const kpi = el('div', { className: 'stats-kpi-line' },
    el('span', null, `⏱️ ${formatDuration(data.summary.totalMs)} total`),
    el('span', null, `🤖 ${data.summary.agentsCount} agents`),
    el('span', null, `🔧 ${data.summary.opsCount} ops`),
    el('span', null, `🪙 ${formatTokens(data.summary.tokensTotal)} tokens`),
    el('span', null, `💵 $${data.summary.costUsd.toFixed(3)}`),
    el('span', { className: 'kpi-warn' }, `⚠️ ${data.summary.errorsCount} errors`),
    el('span', { className: 'kpi-warn' }, `🔁 ${data.summary.retriesCount} retries`),
  );

  const tasks = buildTaskPills(data.phases || []);
  const taskRow = tasks.length
    ? el('div', { className: 'stats-team-row' },
        ...tasks.map((t) => {
          const pill = el('span', { className: 'stats-team-pill' });
          pill.textContent = `🎫 ${t.taskId} · ${formatDuration(t.durationMs)} · ${t.agents} agents${t.errorsCount ? ' · ⚠️ ' + t.errorsCount : ''}`;
          return pill;
        }))
    : null;

  const totalMs = data.summary.totalMs || 1;
  const breakdown = el('div', { className: 'stats-breakdown' },
    ...data.summary.timeBreakdown.map((row) => {
      const pct = Math.max(2, Math.round((row.ms / totalMs) * 100));
      const seg = el('span', {
        className: 'stats-breakdown-seg',
        style: { flex: String(pct) },
        title: `${row.agent} · ${formatDuration(row.ms)} (${pct}%)`,
      });
      seg.textContent = pct > 8 ? `${row.agent} ${formatDuration(row.ms)}` : '';
      return seg;
    }));

  return el('section', { className: 'stats-section stats-summary' }, kpi, taskRow, breakdown);
}
