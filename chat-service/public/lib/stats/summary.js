import { el, formatDuration, formatTokens } from '../dom.js';

// Per-task figures (agents / duration / errors) used to live here as a flat
// pill row. They now live alongside each ticket card in the dependency-waves
// section, so this file is back to KPI line + time breakdown only.
export function renderSummarySection(data) {
  const kpi = el('div', { className: 'stats-kpi-line' },
    el('span', null, `⏱️ ${formatDuration(data.summary.totalMs)} total`),
    el('span', null, `🤖 ${data.summary.agentsCount} agents`),
    el('span', null, `🪙 ${formatTokens(data.summary.tokensTotal)} tokens`),
    el('span', null, `💵 $${data.summary.costUsd.toFixed(3)}`),
    el('span', { className: `kpi-spacer${data.summary.errorsCount ? ' kpi-warn' : ''}` }, `⚠️ ${data.summary.errorsCount} errors`),
    el('span', data.summary.retriesCount ? { className: 'kpi-warn' } : null, `🔁 ${data.summary.retriesCount} retries`),
  );

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

  return el('section', { className: 'stats-section stats-summary' }, kpi, breakdown);
}
