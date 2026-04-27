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

export function renderChronologySection(data) {
  const relLabel = relLabelFactory(data.startTs);
  const teamColor = (name) => data.teams.find((t) => t.team_name === name)?.color || '#64748b';

  const rows = data.phases.map((phase) => renderPhaseRow(phase, relLabel, teamColor));
  return el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Timeline'),
    ...rows,
  );
}

function renderPhaseRow(phase, relLabel, teamColor) {
  const det = el('details', { className: 'phase-row' });
  const dot = phase.kind === 'orchestrator' ? '🎭' : '🤖';

  const teamBadge = phase.teamName
    ? el('span', { className: 'phase-team', style: { color: teamColor(phase.teamName), borderColor: teamColor(phase.teamName) } },
        `👥 ${phase.teamName.replace(/^ticket-/, '')}`)
    : (phase.kind === 'agent' ? el('span', { className: 'phase-team muted' }, '🎭 no team') : null);

  const warn  = phase.errorsCount  ? el('span', { className: 'phase-warn' }, `⚠️ ${phase.errorsCount}`)  : null;
  const retry = phase.retriesCount ? el('span', { className: 'phase-warn' }, `🔁 ${phase.retriesCount}`) : null;

  det.appendChild(el('summary', null,
    el('span', { className: 'phase-time' }, relLabel(phase.startTs)),
    el('span', { className: 'phase-icon' }, dot),
    el('span', { className: 'phase-name' }, phase.agentType || phase.kind),
    el('span', { className: 'phase-desc' }, phase.description),
    el('span', { className: 'phase-stats' },
      `${formatDuration(phase.durationMs)} · ${phase.opsCount} ops · ${formatTokens(phase.tokensTotal || 0)} tok`),
    warn, retry, teamBadge,
  ));

  if (phase.children.length === 0) {
    det.appendChild(el('div', { className: 'phase-empty' }, '(no sub-events)'));
  } else {
    const list = el('div', { className: 'phase-children' });
    for (const c of phase.children) list.appendChild(renderChildRow(c, relLabel));
    det.appendChild(list);
  }
  return det;
}

function renderChildRow(child, relLabel) {
  let icon = '🔧', label = child.kind, detail = '';
  if (child.kind === 'tool_use') { icon = toolIcon(child.tool); label = child.tool; detail = child.detail ?? ''; }
  else if (child.kind === 'skill') { icon = '🧠'; label = 'Skill'; detail = child.skill; }
  else if (child.kind === 'hook') { icon = '🪝'; label = child.hookName; detail = `${child.worktree || ''} ${child.result || ''}`.trim(); }
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

  return el('div', { className: `child-row child-${child.kind}` },
    el('span', { className: 'child-time' }, relLabel(child.ts || child.startTs)),
    el('span', { className: 'child-icon' }, icon),
    el('span', { className: 'child-label' }, label),
    detailSpan,
    el('span', { className: 'child-dur' }, dur),
  );
}
