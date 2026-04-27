import { el, formatDuration } from '../dom.js';
import { toolIcon } from './chronology.js';

export function renderTopOpsSection(data) {
  const grid = el('div', { className: 'stats-top-grid' },
    buildTopList('Longest agents', data.topAgents, (a) => ({
      main: a.label,
      meta: a.teamName ? `👥 ${a.teamName.replace(/^ticket-/,'')}` : '',
      value: formatDuration(a.durationMs),
    })),
    buildTopList('Longest tool calls', data.topToolCalls, (c) => ({
      main: `${toolIcon(c.tool)} ${c.tool}`,
      meta: c.detail ?? '',
      value: `${c.isApprox ? '~' : ''}${formatDuration(c.durationMs)}`,
      slow: !!c.flaggedSlow,
    })),
    buildTopList('Most-used tools', data.toolCounts.slice(0, 5), (t) => ({
      main: `${toolIcon(t.tool)} ${t.tool}`,
      meta: `${formatDuration(t.totalDurationMs)} total`,
      value: `${t.count} calls`,
    })),
  );
  return el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Top operations'),
    grid,
  );
}

function buildTopList(title, items, fmt) {
  const col = el('div', { className: 'stats-top-col' },
    el('h4', null, title),
  );
  if (!items.length) {
    col.appendChild(el('ol', { className: 'stats-top-list' }, el('li', { className: 'top-empty' }, '—')));
    return col;
  }
  const list = el('ol', { className: 'stats-top-list' });
  for (const it of items) {
    const f = fmt(it);
    const li = el('li', f.slow ? { className: 'slow' } : null,
      el('div', { className: 'top-main' }, f.main),
      el('div', { className: 'top-meta' }, f.meta),
      el('div', { className: 'top-value' }, f.value),
    );
    list.appendChild(li);
  }
  col.appendChild(list);
  return col;
}
