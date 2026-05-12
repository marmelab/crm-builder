import {
  el, formatDuration, formatTokens, withBreakdownTooltip, withCostTooltip,
  tokenBreakdownText, tokensByModelText,
} from '../dom.js';

// Aggregate per-agentType figures across all phases of that agent. Used by
// the time-breakdown bar tooltip so each colored segment shows not just the
// duration but also the tokens consumed and cost incurred by that agent
// across the whole session.
function aggregatePerAgent(phases) {
  const byAgent = new Map();
  for (const p of phases || []) {
    const a = p.agentType;
    if (!a) continue;
    const slot = byAgent.get(a) || {
      ms: 0, costUsd: 0,
      tokensBreakdown: { input: 0, cacheCreate: 0, output: 0, cacheRead: 0 },
      tokensByModel: new Map(),
    };
    slot.ms += p.workMs || p.durationMs || 0;
    slot.costUsd += p.costUsd || 0;
    const bk = p.tokensBreakdown;
    if (bk) {
      slot.tokensBreakdown.input       += bk.input       || 0;
      slot.tokensBreakdown.cacheCreate += bk.cacheCreate || 0;
      slot.tokensBreakdown.output      += bk.output      || 0;
      slot.tokensBreakdown.cacheRead   += bk.cacheRead   || 0;
    }
    for (const row of p.tokensByModel || []) {
      const prev = slot.tokensByModel.get(row.model) || {
        breakdown: { input: 0, cacheCreate: 0, output: 0, cacheRead: 0 },
        costUsd: 0,
      };
      prev.breakdown.input       += row.breakdown.input       || 0;
      prev.breakdown.cacheCreate += row.breakdown.cacheCreate || 0;
      prev.breakdown.output      += row.breakdown.output      || 0;
      prev.breakdown.cacheRead   += row.breakdown.cacheRead   || 0;
      prev.costUsd += row.costUsd || 0;
      slot.tokensByModel.set(row.model, prev);
    }
    byAgent.set(a, slot);
  }
  return byAgent;
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

  const tokensLabel = `🪙 ${formatTokens(grandTotal)} tokens`;
  const tokensSpan = bk
    ? withBreakdownTooltip(tokensLabel, bk, { totalLabel: 'total' })
    : el('span', null, tokensLabel);

  // Cost tooltip: per-model 4-way breakdown + approximate per-model cost.
  // Falls through to a plain span when the aggregator didn't produce
  // per-model data (e.g. legacy fixtures).
  const costLabel = `💵 $${data.summary.costUsd.toFixed(3)}`;
  const byModel = data.summary.tokensByModel;
  const costSpan = (byModel && byModel.length > 0)
    ? withCostTooltip(costLabel, byModel, data.summary.costUsd)
    : el('span', null, costLabel);

  const kpi = el('div', { className: 'stats-kpi-line' },
    el('span', null, `⏱️ ${formatDuration(data.summary.totalMs)} total`),
    el('span', null, `🤖 ${data.summary.agentsCount} agents`),
    tokensSpan,
    costSpan,
    el('span', { className: `kpi-spacer${data.summary.errorsCount ? ' kpi-warn' : ''}` }, `⚠️ ${data.summary.errorsCount} errors`),
    el('span', data.summary.retriesCount ? { className: 'kpi-warn' } : null, `🔁 ${data.summary.retriesCount} retries`),
  );

  const totalMs = data.summary.totalMs || 1;
  const perAgent = aggregatePerAgent(data.phases);
  const breakdown = el('div', { className: 'stats-breakdown' },
    ...data.summary.timeBreakdown.map((row) => {
      const pct = Math.max(2, Math.round((row.ms / totalMs) * 100));
      const seg = el('span', {
        className: 'stats-breakdown-seg tk-host',
        style: { flex: String(pct) },
      });
      // Text in an inner span so the segment itself can have overflow:visible
      // (required for the tooltip to escape) while still clipping the label.
      const label = el('span', { className: 'breakdown-label' });
      label.textContent = pct > 8 ? `${row.agent} ${formatDuration(row.ms)}` : '';
      seg.appendChild(label);
      // CSS tooltip: time + token breakdown + per-model cost table for this
      // specific agent across the whole session. Falls back gracefully when
      // a particular aggregate (breakdown, tokensByModel) is empty.
      const agg = perAgent.get(row.agent);
      const tip = el('span', { className: 'tk-tip' });
      const lines = [
        `${row.agent}  ·  ${formatDuration(row.ms)} (${pct}%)`,
        '',
      ];
      if (agg) {
        const bkSum =
          agg.tokensBreakdown.input + agg.tokensBreakdown.cacheCreate +
          agg.tokensBreakdown.output + agg.tokensBreakdown.cacheRead;
        if (bkSum > 0) {
          lines.push(tokenBreakdownText(agg.tokensBreakdown, { totalLabel: 'tokens' }));
          lines.push('');
        }
        if (agg.tokensByModel.size > 0) {
          const byModelRows = [...agg.tokensByModel].map(([model, v]) => ({
            model, breakdown: v.breakdown, costUsd: v.costUsd,
          })).sort((a, b) => b.costUsd - a.costUsd);
          lines.push(tokensByModelText(byModelRows, agg.costUsd));
        } else if (agg.costUsd > 0) {
          lines.push(`cost  $${agg.costUsd.toFixed(4)}`);
        }
      }
      tip.textContent = lines.join('\n').trimEnd();
      seg.appendChild(tip);
      return seg;
    }));

  return el('section', { className: 'stats-section stats-summary' }, kpi, breakdown);
}
