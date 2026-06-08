import { el, formatDuration } from '../dom.js';

const TASK_ID_RE = /(TASK-\d{3,})/;
function extractTaskId(s) {
  if (!s) return null;
  const m = String(s).match(TASK_ID_RE);
  return m ? m[1] : null;
}

// Aggregate per-task figures from the agent phases so each wave card can
// show "N agents · 0:42 · ⚠ 2" alongside the ticket id and title. The
// merger is a singleton shared across the wave; we count it once per task
// when at least one merger phase ran.
function buildTaskStats(phases) {
  const byTask = new Map();
  for (const p of phases) {
    if (p.kind !== 'agent') continue;
    const id = extractTaskId(p.agentName) ?? extractTaskId(p.description);
    if (!id) continue;
    const slot = byTask.get(id) || { agents: 0, durationMs: 0, errorsCount: 0 };
    slot.agents++;
    slot.durationMs = Math.max(slot.durationMs, p.durationMs || 0);
    slot.errorsCount += p.errorsCount || 0;
    byTask.set(id, slot);
  }
  const mergers = phases.filter((p) => p.agentName === 'merger' && p.kind === 'agent').length;
  if (mergers > 0) {
    for (const slot of byTask.values()) slot.agents++;
  }
  return byTask;
}

// Visualize the planner's dependency graph as a left-to-right wave layout.
// Each wave is a column of tickets that can run in parallel; arrows between
// columns mean the right depends on the left. Lets the user spot at a glance
// whether the planner serialized too aggressively or not. Each card also
// carries the ticket's run-time aggregates (agents · duration · errors) so
// this section subsumes the previous flat task-pill row in the summary.
export function renderWavesSection(data) {
  const tickets = data.tickets || [];
  const waves = data.waves || [];
  if (tickets.length === 0) return null;

  const byId = new Map(tickets.map((t) => [t.id, t]));
  const taskStats = buildTaskStats(data.phases || []);
  const totalParallel = waves.reduce((max, w) => Math.max(max, w.length), 0);
  const isFullySerial = waves.every((w) => w.length === 1);
  const isFullyParallel = waves.length === 1 && tickets.length > 1;

  const verdict = isFullyParallel
    ? `✅ All ${tickets.length} tickets run in parallel (1 wave)`
    : isFullySerial
      ? `⚠️ Tickets serialized — ${waves.length} wave${waves.length > 1 ? 's' : ''}, max parallelism: 1`
      : `${waves.length} waves, max parallelism: ${totalParallel}`;

  const waveCols = waves.map((wave, idx) => {
    const cards = wave.map((id) => renderTicketCard(byId.get(id), taskStats.get(id)));
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
    el('h3', { className: 'stats-section-title' }, 'Development waves'),
    el('div', { className: 'wave-verdict' }, verdict),
    el('div', { className: 'wave-flow' }, ...flow),
  );
}

function renderTicketCard(ticket, stats) {
  const depList = ticket.dependencies?.length
    ? `← ${ticket.dependencies.join(', ')}`
    : '(no deps)';
  const children = [
    el('span', { className: 'wave-ticket-id' }, ticket.id),
    el('span', { className: 'wave-ticket-title' }, (ticket.title || '').slice(0, 60)),
  ];
  if (stats) {
    const parts = [`${stats.agents} agents`, formatDuration(stats.durationMs)];
    if (stats.errorsCount) parts.push(`⚠ ${stats.errorsCount}`);
    children.push(el('span', { className: 'wave-ticket-stats' }, parts.join(' · ')));
  }
  return el('div', {
    className: `wave-ticket wave-status-${ticket.status || 'pending'}`,
    title: `${ticket.title}\nDeps: ${depList}\nStatus: ${ticket.status || 'pending'}`,
  }, ...children);
}
