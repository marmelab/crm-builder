const widget   = document.getElementById('chat-widget');
const fab      = document.getElementById('chat-fab');
const toggle   = document.getElementById('chat-toggle');
const expandBtn = document.getElementById('chat-expand');
const debugBtn = document.getElementById('chat-debug');
const form     = document.getElementById('chat-form');
const input    = document.getElementById('chat-input');
const send     = document.getElementById('chat-send');
const statusDots = document.getElementById('chat-status-dots');
const messages = document.getElementById('chat-messages');
const stats = document.getElementById('chat-stats');
const statsBtn = document.getElementById('chat-stats-btn');
const statsPanel = document.getElementById('chat-stats-panel');

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'className') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'dataset' && typeof v === 'object') for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return e;
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

let working  = false;
let debugMode = false;
let hasUserMessage = false;
let currentSessionId = null;
let statsMode = false;

function updateStatsBtnVisibility() {
  if (!hasUserMessage) { statsBtn.hidden = true; return; }
  statsBtn.hidden = false;
  statsBtn.disabled = working;
}

// Monotonic sequence assigned to every persistent message (user/assistant
// text, choices, debug events). Used to interleave buffered debug events at
// their original chronological position when debug mode is toggled on
// mid-session — without it, replayed debug events would pile up at the end
// of the message list regardless of when they actually arrived.
let seqCounter = 0;

// Buffer of every debug / debug_raw event received since the page loaded,
// tagged with the seq assigned at arrival, so toggling debug on mid-session
// can splice them in at the right position.
const debugEventBuffer = [];

function placeIntoMessages(el, seq) {
  el.dataset.seq = seq;
  for (const child of messages.children) {
    const cs = Number(child.dataset.seq);
    if (!Number.isNaN(cs) && cs > seq) {
      messages.insertBefore(el, child);
      messages.scrollTop = messages.scrollHeight;
      return;
    }
  }
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

const TOOL_LABELS = {
  orchestrator: '🎭 Orchestrator',
  Task:         '🤖 Agent',
  Agent:        '🤖 Agent',
  agent_output: '💬 Agent reply',
  TeamCreate:   '👥 Team spawned',
  TeamDelete:   '✓  Team done',
  Read:         '📖 Reading',
  Write:        '✏️  Writing',
  Edit:         '✏️  Editing',
  Bash:         '⚡ Running command',
  Glob:         '🔍 Searching files',
  Grep:         '🔍 Searching code',
  system:       '🔌 Session started',
  result:       '✅ Turn complete',
};

const ws = new WebSocket(`ws://${location.host}`);

ws.onmessage = (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  if (msg.type === 'session_meta') {
    currentSessionId = msg.sessionId;
    return;
  }

  if (msg.type === 'status') {
    working = msg.working;
    send.disabled = working;
    statusDots.style.display = working ? 'inline-flex' : 'none';
    const existing = messages.querySelector('.msg-working');
    if (working && !existing) {
      const el = document.createElement('div');
      el.className = 'msg msg-working';
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      const label = document.createElement('span');
      label.textContent = 'Working on it...';
      el.appendChild(spinner);
      el.appendChild(label);
      messages.appendChild(el);
      messages.scrollTop = messages.scrollHeight;
    } else if (!working && existing) {
      existing.remove();
    }
    updateStatsBtnVisibility();
    return;
  }

  if (msg.type === 'choices') {
    appendChoices(msg.content, msg.options);
    return;
  }

  if (msg.type === 'stats') {
    const agents = msg.activeAgents || 0;
    const agentsPart = agents > 0 ? `🤖 ${agents} · ` : '';
    stats.textContent = `${agentsPart}${formatTokens(msg.tokensUsed)} tokens · $${msg.costUsd.toFixed(3)}`;
    return;
  }

  if (msg.type === 'debug') {
    const s = ++seqCounter;
    debugEventBuffer.push({ msg, seq: s });
    if (debugMode) appendDebug(msg.tool, msg.input, msg.agent, s);
    return;
  }

  if (msg.type === 'debug_raw') {
    const s = ++seqCounter;
    debugEventBuffer.push({ msg, seq: s });
    if (debugMode) renderDebugRaw(msg, s);
    return;
  }

  if (msg.type === 'message' && msg.role === 'assistant') {
    const existing = messages.querySelector('.msg-working');
    if (existing) existing.remove();
    appendMessage('assistant', msg.content);
  }
};

ws.onclose = () => {
  appendMessage('assistant', 'Connection lost. Please reload the page.');
};

function appendChoices(content, options, seq = ++seqCounter) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-choices';

  const text = document.createElement('p');
  text.className = 'choices-text';
  text.textContent = content;
  wrap.appendChild(text);

  options.forEach(({ id, label, sublabel }) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    const lbl = document.createElement('span');
    lbl.className = 'choice-label';
    lbl.textContent = label;
    btn.appendChild(lbl);
    if (sublabel) {
      const sub = document.createElement('span');
      sub.className = 'choice-sublabel';
      sub.textContent = sublabel;
      btn.appendChild(sub);
    }
    btn.addEventListener('click', () => {
      wrap.remove();
      appendMessage('user', label);
      ws.send(JSON.stringify({ content: id }));
      hasUserMessage = true;
      updateStatsBtnVisibility();
    });
    wrap.appendChild(btn);
  });

  placeIntoMessages(wrap, seq);
}

function appendMessage(role, content, seq = ++seqCounter) {
  const el = document.createElement('div');
  el.className = `msg msg-${role}`;
  el.textContent = content;
  placeIntoMessages(el, seq);
}

function toolDetail(toolName, input) {
  if (!input) return null;
  const short = (s, n = 60) => s && s.length > n ? '…' + s.slice(-n) : s;
  switch (toolName) {
    case 'Read':  return short(input.file_path);
    case 'Write': return short(input.file_path);
    case 'Edit':  return short(input.file_path);
    case 'Bash':  return short(input.command, 80);
    case 'Grep':  return `"${input.pattern}"${input.path ? ' in ' + input.path : ''}`;
    case 'Glob':  return input.pattern;
    default:      return null;
  }
}

const AGENT_COLORS = {
  planner:    '#34d399',
  developer:  '#f97316',
  'code-reviewer':    '#a78bfa',
  'security-reviewer':'#f43f5e',
  'test-validator':   '#38bdf8',
};

function agentColor(label) {
  if (!label) return null;
  const key = label.toLowerCase();
  for (const [name, color] of Object.entries(AGENT_COLORS)) {
    if (key.includes(name)) return color;
  }
  return '#8b5cf6';
}

function appendDebug(toolName, input, agentCtx, seq = ++seqCounter) {
  const label = TOOL_LABELS[toolName] || `🔧 ${toolName}`;
  const el = document.createElement('div');
  el.className = 'msg msg-debug';

  const name = document.createElement('span');
  name.className = 'debug-tool';
  name.dataset.tool = toolName;
  const color = toolName === 'orchestrator' ? '#fbbf24' : agentColor(agentCtx);
  if (color) name.style.color = color;
  name.textContent = label;
  el.appendChild(name);

  // Agent context badge (which agent is doing this)
  if (agentCtx && toolName !== 'Task' && toolName !== 'TeamCreate' && toolName !== 'orchestrator') {
    const ctx = document.createElement('span');
    ctx.className = 'debug-context';
    ctx.textContent = agentCtx;
    ctx.style.color = agentColor(agentCtx) || '#8b5cf6';
    el.appendChild(ctx);
  }

  // Tool input detail (file path, command, etc.)
  const detail = toolDetail(toolName, input);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'debug-detail';
    d.textContent = detail;
    el.appendChild(d);
  }

  // Orchestrator raw text
  if (toolName === 'orchestrator' && input?.text) {
    const body = document.createElement('span');
    body.className = 'debug-agent-text';
    body.textContent = input.text;
    el.appendChild(body);
  }

  // Single agent: show its description
  if (toolName === 'Task' && input?.description) {
    const detail = document.createElement('span');
    detail.className = 'debug-detail';
    detail.textContent = input.description;
    el.appendChild(detail);
  }

  // Agent reply: show agent name + text output
  if (toolName === 'agent_output' && input?.text) {
    if (input.agent) {
      const who = document.createElement('span');
      who.className = 'debug-agent';
      who.textContent = input.agent;
      el.appendChild(who);
    }
    const body = document.createElement('span');
    body.className = 'debug-agent-text';
    body.textContent = input.text;
    el.appendChild(body);
  }

  // System init: show available tools
  if (toolName === 'system' && input?.tools?.length) {
    const detail = document.createElement('span');
    detail.className = 'debug-detail';
    detail.textContent = `Tools: ${input.tools.join(', ')}`;
    el.appendChild(detail);
  }

  // Result: show cost + turns
  if (toolName === 'result') {
    const detail = document.createElement('span');
    detail.className = 'debug-detail';
    const cost = input?.cost != null ? ` — $${input.cost.toFixed(4)}` : '';
    detail.textContent = `${input?.turns ?? '?'} turn(s)${cost}`;
    el.appendChild(detail);
  }

  // Agent team: list member names
  if (toolName === 'TeamCreate') {
    const members = Array.isArray(input?.agents)
      ? input.agents.map((a) => a.name || a).join(', ')
      : input?.description || '';
    if (members) {
      const detail = document.createElement('span');
      detail.className = 'debug-detail';
      detail.textContent = `Members: ${members}`;
      el.appendChild(detail);
    }
  }

  placeIntoMessages(el, seq);
}

function summarizeEvent(ev) {
  if (ev.type === 'system' && ev.subtype === 'task_started') {
    return `▶ task_started: ${ev.description || ev.task_id}`;
  }
  if (ev.type === 'system' && ev.subtype === 'task_progress') {
    const s = ev.usage ? ` (${ev.usage.tool_uses} tools, ${(ev.usage.duration_ms / 1000).toFixed(1)}s)` : '';
    return `⏳ task_progress: ${ev.description || ''}${s}`;
  }
  if (ev.type === 'system' && ev.subtype === 'task_complete') {
    return `✓ task_complete: ${ev.task_id}`;
  }
  if (ev.type === 'result') {
    const cost = ev.total_cost_usd != null ? ` — $${ev.total_cost_usd.toFixed(4)}` : '';
    return `✅ result: ${ev.num_turns} turn(s)${cost} [${ev.stop_reason}]`;
  }
  if (ev.type === 'assistant') {
    const blocks = ev.message?.content || [];
    return blocks.map((b) => {
      if (b.type === 'text') return `💬 "${b.text.slice(0, 120)}${b.text.length > 120 ? '…' : ''}"`;
      if (b.type === 'tool_use') {
        const inp = JSON.stringify(b.input).slice(0, 100);
        return `🔧 ${b.name}(${inp})`;
      }
      return null;
    }).filter(Boolean).join('\n');
  }
  if (ev.type === 'user') {
    const content = ev.message?.content || [];
    const results = content.filter((b) => b.type === 'tool_result');
    if (results.length) {
      return results.map((r) => {
        const text = Array.isArray(r.content)
          ? r.content.filter((c) => c.type === 'text').map((c) => c.text).join('').slice(0, 120)
          : (typeof r.content === 'string' ? r.content.slice(0, 120) : '');
        return `↩ tool_result: ${text}`;
      }).join('\n');
    }
    return null;
  }
  return null;
}

function appendRaw(event, seq = ++seqCounter) {
  const summary = summarizeEvent(event);
  if (!summary) return;
  const el = document.createElement('details');
  el.className = 'msg msg-debug msg-raw';
  const sum = document.createElement('summary');
  sum.textContent = summary;
  el.appendChild(sum);
  const full = document.createElement('pre');
  full.className = 'raw-full';
  full.textContent = JSON.stringify(event, null, 2);
  el.appendChild(full);
  placeIntoMessages(el, seq);
}

// Apply the debug_raw display filters and render. Called both from the live
// WebSocket handler and from the replay on debug toggle ON.
function renderDebugRaw(msg, seq = ++seqCounter) {
  const ev = msg.event;
  if (ev.type === 'rate_limit_event') return;
  if (ev.type === 'system' && ev.subtype === 'init') return;
  if (ev.type === 'assistant') {
    const blocks = ev.message?.content || [];
    if (blocks.length === 0 || blocks.every((b) => b.type === 'thinking')) return;
  }
  appendRaw(ev, seq);
}

// Auto-resize textarea
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 100) + 'px';
});

// Submit on Enter (Shift+Enter = newline)
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const content = input.value.trim();
  if (!content || working) return;
  appendMessage('user', content);
  ws.send(JSON.stringify({ content }));
  input.value = '';
  input.style.height = 'auto';
  hasUserMessage = true;
  updateStatsBtnVisibility();
});

// Toggle open/close
toggle.addEventListener('click', () => {
  widget.classList.add('chat-closed');
  fab.style.display = 'flex';
});
fab.addEventListener('click', () => {
  widget.classList.remove('chat-closed');
  fab.style.display = 'none';
});

// Expand toggle
expandBtn.addEventListener('click', () => {
  const expanded = widget.classList.toggle('chat-expanded');
  expandBtn.textContent = expanded ? '⤡' : '⤢';
  expandBtn.title = expanded ? 'Reduce' : 'Expand';
});

// Debug toggle
debugBtn.addEventListener('click', () => {
  debugMode = !debugMode;
  debugBtn.classList.toggle('debug-active', debugMode);
  debugBtn.title = debugMode ? 'Debug ON' : 'Debug OFF';
  if (debugMode) {
    // Replay every buffered debug event at its original seq so it is
    // spliced in between the already-rendered user/assistant messages at
    // the correct chronological position — not piled up at the end.
    for (const entry of debugEventBuffer) {
      if (entry.msg.type === 'debug') {
        appendDebug(entry.msg.tool, entry.msg.input, entry.msg.agent, entry.seq);
      } else if (entry.msg.type === 'debug_raw') {
        renderDebugRaw(entry.msg, entry.seq);
      }
    }
  } else {
    messages.querySelectorAll('.msg-debug').forEach((el) => el.remove());
  }
});

async function enterStatsMode() {
  if (!currentSessionId) return;
  statsMode = true;
  widget.classList.add('chat-stats-mode');
  statsPanel.hidden = false;
  statsBtn.textContent = '←';
  statsBtn.title = 'Back to chat';

  statsPanel.replaceChildren(el('div', { className: 'stats-loading' }, 'Loading stats…'));
  try {
    const res = await fetch(`/api/stats?sessionId=${encodeURIComponent(currentSessionId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderStatsPanel(data);
  } catch (err) {
    const retry = el('button', { id: 'stats-retry-btn', onclick: enterStatsMode }, 'Retry');
    const back  = el('button', { id: 'stats-back-btn',  onclick: exitStatsMode  }, '← Back to chat');
    const label = el('div', null, el('strong', null, 'Failed to load stats:'), ' ', String(err.message));
    statsPanel.replaceChildren(el('div', { className: 'stats-error' }, label, retry, back));
  }
}

function exitStatsMode() {
  statsMode = false;
  widget.classList.remove('chat-stats-mode');
  statsPanel.hidden = true;
  statsPanel.replaceChildren();
  statsBtn.textContent = '📊';
  statsBtn.title = 'Session stats';
}

statsBtn.addEventListener('click', () => {
  if (statsMode) exitStatsMode(); else enterStatsMode();
});

function renderStatsPanel(data) {
  statsPanel.replaceChildren(
    renderSummarySection(data),
    renderChronologySection(data),
    renderTopOpsSection(data),
    renderSkillsHooksRulesSection(data),
    renderErrorsRetriesSection(data),
  );
}

function renderSummarySection(data) {
  const kpi = el('div', { className: 'stats-kpi-line' },
    el('span', null, `⏱️ ${formatDuration(data.summary.totalMs)} total`),
    el('span', null, `🤖 ${data.summary.agentsCount} agents`),
    el('span', null, `🔧 ${data.summary.opsCount} ops`),
    el('span', null, `🪙 ${formatTokens(data.summary.tokensTotal)} tokens`),
    el('span', null, `💵 $${data.summary.costUsd.toFixed(3)}`),
    el('span', { className: 'kpi-warn' }, `⚠️ ${data.summary.errorsCount} errors`),
    el('span', { className: 'kpi-warn' }, `🔁 ${data.summary.retriesCount} retries`),
  );

  const teamRow = data.teams.length
    ? el('div', { className: 'stats-team-row' },
        ...data.teams.map((t) => {
          const pill = el('span', { className: 'stats-team-pill', style: { borderColor: t.color, color: t.color } });
          pill.textContent = `👥 ${t.team_name.replace(/^ticket-/, '')} · ${formatDuration(t.durationMs)} · ${t.agentsCount} agents${t.errorsCount ? ' · ⚠️ ' + t.errorsCount : ''}`;
          return pill;
        }))
    : null;

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

  return el('section', { className: 'stats-section stats-summary' }, kpi, teamRow, breakdown);
}

function relLabelFactory(baseTs) {
  const base = baseTs ? new Date(baseTs).getTime() : 0;
  return (ts) => {
    const d = new Date(ts).getTime() - base;
    const m = Math.floor(d / 60000);
    const s = Math.floor((d % 60000) / 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
}

const TOOL_ICON = { Read: '📖', Write: '✏️', Edit: '✏️', Bash: '⚡', Grep: '🔍', Glob: '🔍' };
function toolIcon(name) { return TOOL_ICON[name] || '🔧'; }

function renderChronologySection(data) {
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

  const dur = child.kind === 'hook'
    ? formatDuration(child.durationMs)
    : (child.isApprox ? `~${formatDuration(child.approxDurationMs)}` : formatDuration(child.approxDurationMs));

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

function renderTopOpsSection(data) {
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

function renderSkillsHooksRulesSection(data) {
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

function renderErrorsRetriesSection(data) {
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
