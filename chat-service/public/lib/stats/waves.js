import { el } from '../dom.js';

// Visualize the planner's dependency graph as a left-to-right wave layout.
// Each wave is a column of tickets that can run in parallel; arrows between
// columns mean the right depends on the left. Lets the user spot at a glance
// whether the planner serialized too aggressively or not.
export function renderWavesSection(data) {
  const tickets = data.tickets || [];
  const waves = data.waves || [];
  if (tickets.length === 0) return null;

  const byId = new Map(tickets.map((t) => [t.id, t]));
  const totalParallel = waves.reduce((max, w) => Math.max(max, w.length), 0);
  const isFullySerial = waves.every((w) => w.length === 1);
  const isFullyParallel = waves.length === 1 && tickets.length > 1;

  const verdict = isFullyParallel
    ? `✅ All ${tickets.length} tickets run in parallel (1 wave)`
    : isFullySerial
      ? `⚠️ Tickets serialized — ${waves.length} wave${waves.length > 1 ? 's' : ''}, max parallelism: 1`
      : `${waves.length} waves, max parallelism: ${totalParallel}`;

  const waveCols = waves.map((wave, idx) => {
    const cards = wave.map((id) => {
      const t = byId.get(id);
      const depList = t.dependencies?.length
        ? `← ${t.dependencies.join(', ')}`
        : '(no deps)';
      return el('div', {
        className: `wave-ticket wave-status-${t.status || 'pending'}`,
        title: `${t.title}\nDeps: ${depList}\nStatus: ${t.status || 'pending'}`,
      },
        el('span', { className: 'wave-ticket-id' }, t.id),
        el('span', { className: 'wave-ticket-title' }, (t.title || '').slice(0, 60)),
      );
    });
    return el('div', { className: 'wave-col' },
      el('div', { className: 'wave-col-label' }, `Wave ${idx + 1}`),
      el('div', { className: 'wave-col-tickets' }, ...cards),
    );
  });

  // Insert arrow separators between waves to make the dependency direction
  // visually obvious. Pure CSS would also work but elements are simpler.
  const flow = [];
  for (let i = 0; i < waveCols.length; i++) {
    if (i > 0) flow.push(el('div', { className: 'wave-arrow' }, '→'));
    flow.push(waveCols[i]);
  }

  return el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Dependency waves'),
    el('div', { className: 'wave-verdict' }, verdict),
    el('div', { className: 'wave-flow' }, ...flow),
  );
}
