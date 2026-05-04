import { el, formatDuration, formatTokens } from '../dom.js';

export function relLabelFactory(baseTs) {
  const base = baseTs ? new Date(baseTs).getTime() : 0;
  return (ts) => {
    const d = new Date(ts).getTime() - base;
    const m = Math.floor(d / 60000);
    const s = Math.floor((d % 60000) / 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
}

export const TOOL_ICON = { Read: '📖', Write: '✏️', Edit: '✏️', Bash: '⚡', Grep: '🔍', Glob: '🔍' };
export function toolIcon(name) { return TOOL_ICON[name] || '🔧'; }

const TASK_ID_RE = /(TASK-\d{3,})/;
function taskIdOf(phase) {
  const m = (phase.agentName || phase.description || '').match(TASK_ID_RE);
  return m ? m[1] : null;
}

export function renderChronologySection(data) {
  const relLabel = relLabelFactory(data.startTs);

  const rows = data.phases.map((phase) => renderPhaseRow(phase, relLabel));
  return el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Timeline'),
    ...rows,
  );
}

function renderPhaseRow(phase, relLabel) {
  const det = el('details', { className: 'phase-row' });
  const dot = phase.kind === 'orchestrator' ? '🎭' : '🤖';

  // Task badge replaces the previous team badge — every COMPLEX phase
  // belongs to exactly one ticket; the team_name "tickets" no longer
  // adds information once we know the ticket.
  const taskId = taskIdOf(phase);
  const taskBadge = taskId
    ? el('span', { className: 'phase-team' }, `🎫 ${taskId}`)
    : (phase.kind === 'agent' ? el('span', { className: 'phase-team muted' }, '— no task') : null);

  const warn  = phase.errorsCount  ? el('span', { className: 'phase-warn' }, `⚠️ ${phase.errorsCount}`)  : null;
  const retry = phase.retriesCount ? el('span', { className: 'phase-warn' }, `🔁 ${phase.retriesCount}`) : null;
  const activations = Array.isArray(phase.activations) ? phase.activations : [];
  const bands = activations.length > 1
    ? el('span', { className: 'phase-activations', title: `${activations.length} activations` },
        ...activations.map((a) => el('span', {
          className: 'stats-activation-band',
          title: `${relLabel(a.startTs)}${a.endTs ? '–' + relLabel(a.endTs) : ''} · ${formatDuration(a.durationMs)}`,
        })))
    : null;

  // Active time (workMs) is the time the agent was busy: tool execution +
  // bounded thinking gaps. Wallclock is dispatch→shutdown including idle
  // waits on peers — useful but misleading on its own. We show active first
  // (it's the figure that matches the timeBreakdown bar chart) and the
  // wallclock is in the hover title so the row stays compact.
  // Orchestrator: most of its tool_uses are SendMessage (excluded from
  // workMs) so workMs collapses to ~0. Use durationMs for it (which is
  // already computed as session-total minus sub-agent coverage) — this
  // matches what timeBreakdown does on the bar chart.
  const activeMs = phase.kind === 'orchestrator'
    ? (phase.durationMs ?? 0)
    : (phase.workMs ?? phase.durationMs ?? 0);
  const stats = el('span', {
    className: 'phase-stats',
    title: `active ${formatDuration(activeMs)} · wall ${formatDuration(phase.durationMs ?? 0)} · ${phase.opsCount} ops · ${formatTokens(phase.tokensTotal || 0)} tokens`,
  }, `${formatDuration(activeMs)} active · ${phase.opsCount} ops · ${formatTokens(phase.tokensTotal || 0)} tok`);

  det.appendChild(el('summary', null,
    el('span', { className: 'phase-time' }, relLabel(phase.startTs)),
    el('span', { className: 'phase-icon' }, dot),
    el('span', { className: 'phase-name' }, phase.agentType || phase.kind),
    el('span', { className: 'phase-desc' }, phase.description),
    stats,
    bands, warn, retry, taskBadge,
  ));

  // Skipped hooks (no actual run — e.g. SHA cache hit, or no changes in the
  // worktree) carry no information for the user; only show ok/fail rows.
  const visibleChildren = phase.children.filter((c) => !(c.kind === 'hook' && c.result === 'skip'));
  if (visibleChildren.length === 0) {
    det.appendChild(el('div', { className: 'phase-empty' }, '(no sub-events)'));
  } else {
    const list = el('div', { className: 'phase-children' });
    for (const c of visibleChildren) list.appendChild(renderChildRow(c, relLabel));
    det.appendChild(list);
  }
  return det;
}

function renderChildRow(child, relLabel) {
  let icon = '🔧', label = child.kind, detail = '';
  if (child.kind === 'tool_use') { icon = toolIcon(child.tool); label = child.tool; detail = child.detail ?? ''; }
  else if (child.kind === 'skill') { icon = '🧠'; label = 'Skill'; detail = child.skill; }
  else if (child.kind === 'hook') {
    const failed = child.result === 'fail';
    icon = failed ? '❌' : '🪝';
    label = child.hookName;
    detail = `${child.worktree || ''} ${child.result || ''}${failed && child.exitCode != null ? ` exit=${child.exitCode}` : ''}`.trim();
  }
  else if (child.kind === 'stream_gap') {
    const silent = !child.eventsDuringGap;
    icon = silent ? '⏸️' : '💭';
    label = silent ? 'silent gap' : 'gap';
    detail = child.preview ?? (silent ? 'no stream activity' : `${child.eventsDuringGap} event${child.eventsDuringGap > 1 ? 's' : ''}`);
  }

  const dur = child.isApprox
    ? `~${formatDuration(child.durationMs)}`
    : formatDuration(child.durationMs);

  const detailSpan = el('span', { className: 'child-detail', title: String(detail) });
  detailSpan.textContent = String(detail);

  const failedHook = child.kind === 'hook' && child.result === 'fail';
  const cls = `child-row child-${child.kind}${failedHook ? ' child-hook-fail' : ''}`;
  return el('div', { className: cls },
    el('span', { className: 'child-time' }, relLabel(child.ts || child.startTs)),
    el('span', { className: 'child-icon' }, icon),
    el('span', { className: 'child-label' }, label),
    detailSpan,
    el('span', { className: 'child-dur' }, dur),
  );
}
