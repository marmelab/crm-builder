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

// Placeholder until Tasks 11-15 fill in the sections
function renderStatsPanel(data) {
  const pre = el('pre', { style: { fontSize: '11px', color: '#636366', overflow: 'auto' } });
  pre.textContent = JSON.stringify(data, null, 2);
  statsPanel.replaceChildren(pre);
}
