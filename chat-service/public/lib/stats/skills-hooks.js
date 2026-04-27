import { el, formatDuration } from '../dom.js';

export function renderSkillsHooksRulesSection(data) {
  const skillsList = buildSubList('Skills invoked', data.skills, (s) => ({
    main: `🧠 ${s.skill}`, count: `${s.count} calls`, meta: `~${formatDuration(s.totalDurationMs)}`,
  }));

  const hooksList = buildSubList('Hooks triggered', data.hooks, (h) => {
    const metaEl = el('span', null,
      el('span', { className: 'sub-ok' }, `✓ ${h.okCount}`), ' ',
      el('span', { className: 'sub-fail' }, `✗ ${h.failCount}`),
    );
    if (h.skipCount) { metaEl.appendChild(document.createTextNode(' ')); metaEl.appendChild(el('span', { className: 'sub-skip' }, `SKIP ${h.skipCount}`)); }
    if (h.blocking)  { metaEl.appendChild(document.createTextNode(' ')); metaEl.appendChild(el('span', { className: 'sub-blocking' }, 'blocking')); }
    return { main: `🪝 ${h.hookName}`, count: `${h.runs} runs`, metaEl: el('span', null, `${formatDuration(h.totalDurationMs)} · `, metaEl) };
  });

  const rulesList = buildSubList('Rules referenced', data.rules, (r) => ({
    main: `📜 ${r.ruleFile}`, count: `${r.reads} reads`, meta: r.readers.map((x) => `${x.agentType}×${x.count}`).join(', '),
  }));

  const note = el('div', { className: 'stats-note' },
    'Rules detection is based on reads of .claude/rules/*.md; an agent may apply a rule without re-reading it.');

  return el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Skills · Hooks · Rules'),
    skillsList, hooksList, rulesList, note,
  );
}

function buildSubList(title, items, rowFn) {
  const col = el('div', { className: 'stats-sub' }, el('h4', null, title));
  if (!items.length) { col.appendChild(el('div', { className: 'sub-empty' }, '—')); return col; }
  for (const it of items) {
    const r = rowFn(it);
    const main = el('span', { className: 'sub-main' }, r.main);
    const count = el('span', { className: 'sub-count' }, r.count);
    const meta = r.metaEl ? r.metaEl : el('span', { className: 'sub-meta' }, r.meta ?? '');
    meta.classList.add('sub-meta');
    col.appendChild(el('div', { className: 'sub-row' }, main, count, meta));
  }
  return col;
}
