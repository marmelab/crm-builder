import { el, formatDuration, formatTokens } from '../dom.js';

export function renderSummarySection(data) {
  const kpi = el('div', { className: 'stats-kpi-line' },
    el('div', { className: 'kpi-group kpi-group-left' },
      el('span', null, `⏱️ ${formatDuration(data.summary.totalMs)} total`),
      el('span', null, `🤖 ${data.summary.agentsCount} agents`),
      el('span', null, `🪙 ${formatTokens(data.summary.tokensTotal)} tokens`),
      el('span', null, `💵 $${data.summary.costUsd.toFixed(3)}`),
    ),
    el('div', { className: 'kpi-group kpi-group-right' },
      el('span', data.summary.errorsCount ? { className: 'kpi-warn' } : null, `⚠️ ${data.summary.errorsCount} errors`),
      el('span', data.summary.retriesCount ? { className: 'kpi-warn' } : null, `🔁 ${data.summary.retriesCount} retries`),
    ),
  );

  const teamRow = data.teams.length
    ? el('div', { className: 'stats-team-row' },
        ...data.teams.map((t) => {
          const pill = el('span', { className: 'stats-team-pill', style: { borderColor: t.color, color: t.color } });
          pill.textContent = `👥 ${t.team_name.replace(/^ticket-/, '')} · ${formatDuration(t.durationMs)} · ${t.agentsCount} agents${t.errorsCount ? ' · ⚠️ ' + t.errorsCount : ''}`;
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

  return el('section', { className: 'stats-section stats-summary' }, kpi, teamRow, breakdown);
}
