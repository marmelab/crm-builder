import { el, formatDuration, formatTokens } from '../dom.js';

function breakdownTooltip(b, totalLabel) {
  if (!b) return '';
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const grand = (b.input || 0) + (b.cacheCreate || 0) + (b.output || 0) + (b.cacheRead || 0);
  return `${totalLabel}: ${fmt(grand)}\n` +
    `  input          ${fmt(b.input)}\n` +
    `  cache-creation ${fmt(b.cacheCreate)}\n` +
    `  output         ${fmt(b.output)}\n` +
    `  cache-read     ${fmt(b.cacheRead)}`;
}

// Per-task figures (agents / duration / errors) used to live here as a flat
// pill row. They now live alongside each ticket card in the dependency-waves
// section, so this file is back to KPI line + time breakdown only.
export function renderSummarySection(data) {
  // Token headline: grand total INCLUDING cache_read so the panel matches the
  // real consumption. Falls back to the legacy `tokensTotal` (cache_read
  // excluded) if the breakdown isn't present in this aggregator output.
  const bk = data.summary.tokensBreakdown;
  const grandTotal = bk
    ? (bk.input || 0) + (bk.cacheCreate || 0) + (bk.output || 0) + (bk.cacheRead || 0)
    : data.summary.tokensTotal;
  const tokensTitle = breakdownTooltip(bk, 'Tokens');

  const kpi = el('div', { className: 'stats-kpi-line' },
    el('span', null, `⏱️ ${formatDuration(data.summary.totalMs)} total`),
    el('span', null, `🤖 ${data.summary.agentsCount} agents`),
    el('span', { title: tokensTitle }, `🪙 ${formatTokens(grandTotal)} tokens`),
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
