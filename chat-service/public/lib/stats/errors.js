import { el } from '../dom.js';

export function renderErrorsRetriesSection(data) {
  const merged = [
    ...data.errors.map((e) => ({ ...e, _kind: 'error' })),
    ...data.retries.map((r) => ({ ...r, _kind: 'retry', summary: `Retry: ${r.description}` })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  const section = el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Errors & retries'));

  if (!merged.length) {
    section.appendChild(el('div', { className: 'sub-empty' }, 'No errors or retries in this session 🎉'));
    return section;
  }

  for (const it of merged) {
    const det = el('details', { className: `err-row err-${it._kind}` });
    const icon = it._kind === 'retry' ? '🔁' : (it.kind === 'hook_failed' ? '🪝' : '❌');
    const t = new Date(it.ts).toISOString().slice(11, 19);

    const summary = el('summary', null,
      el('span', { className: 'err-time' }, t),
      el('span', { className: 'err-icon' }, icon),
      el('span', { className: 'err-summary' }, it.summary),
      it.teamName ? el('span', { className: 'err-meta' }, `👥 ${it.teamName.replace(/^ticket-/,'')}`) : null,
      it._kind === 'retry' ? el('span', { className: 'err-meta muted' }, `via ${it.matchMethod}`) : null,
    );
    det.appendChild(summary);

    const body = el('pre', { className: 'err-payload' });
    body.textContent = typeof it.payload === 'string' ? it.payload : JSON.stringify(it.payload, null, 2);
    det.appendChild(body);

    section.appendChild(det);
  }
  return section;
}
