import {
  el, formatDuration, formatTokens, tokenBreakdownText, tokensByModelTokensText, costByModelText, setupCostTip,
} from '../dom.js';

export function relLabelFactory(baseTs) {
  const base = baseTs ? new Date(baseTs).getTime() : 0;
  return (ts) => {
    const d = new Date(ts).getTime() - base;
    const m = Math.floor(d / 60000);
    const s = Math.floor((d % 60000) / 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
}

export const TOOL_ICON = {
  Read: '📖', Write: '✏️', Edit: '✏️', Bash: '⚡', Grep: '🔍', Glob: '🔍',
  Agent: '🚀', Task: '🚀', TeamCreate: '👥', TeamDelete: '🗑️', SendMessage: '💬',
};
export function toolIcon(name) { return TOOL_ICON[name] || '🔧'; }

const VERDICT_ICON = {
  shutdown: '🛑', awr: '🟡', approved: '✅', blocked: '❌',
  ready: '📨', 'merger-report': '🔀',
};

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
  // already computed as session-total minus sub-agent coverage minus user
  // wait time) — this matches what timeBreakdown does on the bar chart.
  // Non-orchestrator phases: fall back to durationMs when workMs is 0
  // (e.g. subagent enrichment provided no tool children) rather than showing
  // "—". A ~ prefix signals that the value is a wallclock estimate.
  const activeMs = phase.kind === 'orchestrator'
    ? (phase.durationMs ?? 0)
    : (phase.workMs || phase.durationMs || 0);
  const isApproxActive = phase.kind !== 'orchestrator' && !phase.workMs && !!phase.durationMs;
  const activeFmt = isApproxActive || phase.durationApprox
    ? `~${formatDuration(activeMs)}`
    : formatDuration(activeMs);

  // Per-phase numeric columns (cost / active / ops / tokens) are individual
  // grid cells with fixed min-widths (see chat.css). That gives vertical
  // alignment across rows: every phase row's cost lines up at the same X,
  // active values right-align in their column, etc. Phases with no available
  // figure render an em-dash so the slot stays reserved.
  //
  // Each cell hosts its OWN tooltip showing the drill-down for that metric.
  // No cross-talk: cost tooltip = per-model table, tokens tooltip = 4-way
  // breakdown, active tooltip = wall + user-wait. Avoids the redundancy of
  // duplicating timing/cost headers across multiple tooltips.
  const bk = phase.tokensBreakdown;
  const bkSum = bk
    ? (bk.input || 0) + (bk.cacheCreate || 0) + (bk.output || 0) + (bk.cacheRead || 0)
    : 0;
  const hasBreakdown = bkSum > 0;
  const grandTokens = hasBreakdown ? bkSum : (phase.tokensTotal || 0);

  // Cost cell: shows $X.XXX. When per-model data is available, the cell hosts
  // a tooltip with the same compact per-model table the global KPI uses.
  let costBadge;
  if (phase.costUsd != null && phase.tokensByModel && phase.tokensByModel.length > 0) {
    costBadge = el('span', { className: 'phase-cost tk-host tk-cost-host' }, `$${phase.costUsd.toFixed(2)}`);
    const ctip = el('span', { className: 'tk-tip tk-tip-anchor-right' });
    setupCostTip(ctip, phase.tokensByModel, phase.costUsd);
    costBadge.appendChild(ctip);
  } else {
    costBadge = el('span', { className: 'phase-cost' },
      phase.costUsd != null ? `$${phase.costUsd.toFixed(2)}` : '—');
  }

  // Active cell: shows active time. Tooltip drills down to wall-clock + any
  // user-wait carve-out (orchestrator only). Skipped if there's nothing
  // extra to show (active == wall and no user wait).
  const wallMs = phase.wallDurationMs ?? phase.durationMs ?? 0;
  const userWaitMs = phase.userWaitMs || 0;
  const activeMsNum = phase.kind === 'orchestrator'
    ? (phase.durationMs ?? 0)
    : (phase.workMs || phase.durationMs || 0);
  const showActiveTip = wallMs !== activeMsNum || userWaitMs > 0;
  let activeSpan;
  if (showActiveTip) {
    activeSpan = el('span', { className: 'phase-active tk-host' }, activeFmt);
    const atip = el('span', { className: 'tk-tip tk-tip-anchor-right' });
    const lines = [
      `active  ${activeFmt}`,
      `wall    ${formatDuration(wallMs)}`,
    ];
    if (userWaitMs > 0) lines.push(`user-wait  ${formatDuration(userWaitMs)}`);
    atip.textContent = lines.join('\n');
    activeSpan.appendChild(atip);
  } else {
    activeSpan = el('span', { className: 'phase-active' }, activeFmt);
  }

  const opsSpan = el('span', { className: 'phase-ops' }, `${phase.opsCount} ops`);

  // Tokens cell: 4-way breakdown only. No timing, no cost — those have their
  // own dedicated cells. Skipped when there's no per-component split (e.g.
  // sessions without the per-message accumulator) — the cell just shows the
  // total without a tooltip.
  let tokensSpan;
  if (hasBreakdown) {
    tokensSpan = el('span', { className: 'phase-tokens tk-host' },
      grandTokens > 0 ? `${formatTokens(grandTokens)} tok` : '—',
    );
    const tip = el('span', { className: 'tk-tip tk-tip-anchor-right' });
    tip.textContent = (phase.tokensByModel && phase.tokensByModel.length > 0)
      ? tokensByModelTokensText(phase.tokensByModel)
      : tokenBreakdownText(bk, { totalLabel: 'total' });
    tokensSpan.appendChild(tip);
  } else {
    tokensSpan = el('span', { className: 'phase-tokens' },
      grandTokens > 0 ? `${formatTokens(grandTokens)} tok` : '—',
    );
  }

  // Optional badges grouped into a single trailing grid cell so the numeric
  // columns to the left stay aligned regardless of which badges exist.
  const badges = el('span', { className: 'phase-badges' },
    bands, warn, retry, taskBadge,
  );

  // DOM order matters: badges sit between name and the cost block. Cost has
  // `margin-left: auto` (CSS), so everything from cost onward is flushed
  // right; everything before it (time/icon/name/badges) stays at the left.
  det.appendChild(el('summary', null,
    el('span', { className: 'phase-time' }, relLabel(phase.startTs)),
    el('span', { className: 'phase-icon' }, dot),
    el('span', { className: 'phase-name' }, phase.agentType || phase.kind),
    badges,
    costBadge,
    activeSpan,
    opsSpan,
    tokensSpan,
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
  let fullBody = null;
  if (child.kind === 'tool_use') {
    icon = (child.verdict && VERDICT_ICON[child.verdict]) ? VERDICT_ICON[child.verdict] : toolIcon(child.tool);
    label = child.tool; detail = child.detail ?? '';
    if (child.tool === 'SendMessage' && child.fullContent) fullBody = child.fullContent;
  }
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
  else if (child.kind === 'agent_text') {
    icon = '💬';
    label = 'text';
    detail = String(child.text).replace(/\s+/g, ' ').trim();
    fullBody = child.text;
  }

  const dur = child.kind === 'agent_text'
    ? ''
    : (child.isApprox
        ? `~${formatDuration(child.durationMs)}`
        : formatDuration(child.durationMs));

  const detailSpan = el('span', { className: 'child-detail', title: String(detail) });
  detailSpan.textContent = String(detail);

  const failedHook = child.kind === 'hook' && child.result === 'fail';
  const verdictCls = child.verdict ? ` child-verdict-${child.verdict}` : '';
  const cls = `child-row child-${child.kind}${failedHook ? ' child-hook-fail' : ''}${verdictCls}`;

  const cells = [
    el('span', { className: 'child-time' }, relLabel(child.ts || child.startTs)),
    el('span', { className: 'child-icon' }, icon),
    el('span', { className: 'child-label' }, label),
    detailSpan,
    el('span', { className: 'child-dur' }, dur),
  ];

  // Expandable rows: agent text + SendMessage with a full body. <details> is
  // collapsed by default so the timeline stays scannable; expanding swaps in a
  // <pre> with the full content.
  if (fullBody) {
    const det = el('details', { className: cls + ' child-expandable' });
    const summary = el('summary', { className: 'child-row-summary' }, ...cells);
    const body = el('pre', { className: 'child-full' });
    body.textContent = fullBody;
    det.append(summary, body);
    return det;
  }

  return el('div', { className: cls }, ...cells);
}
