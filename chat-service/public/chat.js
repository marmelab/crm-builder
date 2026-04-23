const widget   = document.getElementById('chat-widget');
const fab      = document.getElementById('chat-fab');
const toggle   = document.getElementById('chat-toggle');
const expandBtn = document.getElementById('chat-expand');
const debugBtn = document.getElementById('chat-debug');
const stateBtn = document.getElementById('chat-state');
const historyBtn = document.getElementById('chat-history');
const newBtn = document.getElementById('chat-new');
const historyPanel = document.getElementById('chat-history-panel');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const historyClose = document.getElementById('history-close');
const chatTitle = document.getElementById('chat-title');
const form     = document.getElementById('chat-form');
const input    = document.getElementById('chat-input');
const send     = document.getElementById('chat-send');
const statusDots = document.getElementById('chat-status-dots');
const messages = document.getElementById('chat-messages');
const stats = document.getElementById('chat-stats');

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const days = Math.round(h / 24);
  if (days < 7) return `il y a ${days} j`;
  return d.toLocaleDateString();
}

let working  = false;
let debugMode = false;
let currentDiscussionId = null;
let currentTitle = '';
let currentState = 'en_cours';

const STATE_LABELS = {
  en_cours: 'En cours',
  terminee: 'Terminée',
};

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

function buildWsUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get('discussion');
  const qs = id ? `?discussion=${encodeURIComponent(id)}` : '';
  return `ws://${location.host}${qs}`;
}

let ws;
let switchingDiscussion = false;

function connectWs() {
  ws = new WebSocket(buildWsUrl());
  ws.onmessage = handleWsMessage;
  ws.onclose = () => {
    if (switchingDiscussion) { switchingDiscussion = false; return; }
    appendMessage('assistant', 'Connection lost. Please reload the page.');
  };
}

// Switch to another discussion (or start a fresh one with id=null) without
// reloading the page — keeps the CRM iframe state intact.
function switchDiscussion(id) {
  switchingDiscussion = true;
  try { ws?.close(); } catch {}
  const url = new URL(location.href);
  if (id) url.searchParams.set('discussion', id);
  else url.searchParams.delete('discussion');
  history.pushState({}, '', url);
  resetChatUi();
  connectWs();
}

function resetChatUi() {
  messages.innerHTML = '';
  currentDiscussionId = null;
  currentTitle = '';
  working = false;
  send.disabled = false;
  statusDots.style.display = 'none';
  historyPanel.hidden = true;
  stats.textContent = '';
}

window.addEventListener('popstate', () => {
  switchingDiscussion = true;
  try { ws?.close(); } catch {}
  resetChatUi();
  connectWs();
});

function handleWsMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  if (msg.type === 'init') {
    currentDiscussionId = msg.discussionId;
    setDisplayedTitle(msg.title || 'New discussion');
    setDisplayedState(msg.state || 'en_cours');
    messages.innerHTML = '';
    (msg.messages || []).forEach((m) => appendMessage(m.role, m.content));
    return;
  }

  if (msg.type === 'state') {
    setDisplayedState(msg.state);
    return;
  }

  if (msg.type === 'title') {
    setDisplayedTitle(msg.title);
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
}

connectWs();

function setDisplayedTitle(t) {
  currentTitle = t;
  chatTitle.textContent = t;
}

function setDisplayedState(s) {
  currentState = s;
  stateBtn.textContent = STATE_LABELS[s] || s;
  stateBtn.className = `state-${s}`;
  stateBtn.title = s === 'terminee'
    ? 'Session Claude terminée — envoyez un message pour relancer'
    : 'Claude est en cours…';
}

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
      ws.send(JSON.stringify({ content: id, display: label }));
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

// ─── History panel ──────────────────────────────────────────
async function openHistory() {
  try {
    const res = await fetch('/api/discussions');
    const list = await res.json();
    historyList.innerHTML = '';
    if (list.length === 0) {
      historyEmpty.hidden = false;
    } else {
      historyEmpty.hidden = true;
      list.forEach((d) => historyList.appendChild(renderHistoryItem(d)));
    }
    historyPanel.hidden = false;
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

function renderHistoryItem(d) {
  const li = document.createElement('li');
  li.className = 'history-item';
  if (d.id === currentDiscussionId) li.classList.add('active');

  const title = document.createElement('div');
  title.className = 'history-title';
  title.textContent = d.title || '(sans titre)';
  li.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'history-meta';
  const statePill = document.createElement('span');
  const st = d.state || 'en_cours';
  statePill.className = `history-state state-${st}`;
  statePill.textContent = STATE_LABELS[st] || st;
  meta.appendChild(statePill);
  meta.appendChild(document.createTextNode(` · ${formatRelative(d.lastMessageAt || d.createdAt)} · ${d.messageCount} message${d.messageCount > 1 ? 's' : ''}`));
  li.appendChild(meta);

  li.addEventListener('click', () => {
    if (d.id === currentDiscussionId) {
      historyPanel.hidden = true;
      return;
    }
    switchDiscussion(d.id);
  });
  return li;
}

historyBtn.addEventListener('click', () => {
  if (historyPanel.hidden) openHistory();
  else historyPanel.hidden = true;
});
historyClose.addEventListener('click', () => { historyPanel.hidden = true; });

newBtn.addEventListener('click', () => {
  switchDiscussion(null);
});

// ─── Title rename ───────────────────────────────────────────
chatTitle.addEventListener('click', async () => {
  if (!currentDiscussionId) return;
  const next = prompt('Renommer la discussion :', currentTitle);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === currentTitle) return;
  try {
    const res = await fetch(`/api/discussions/${currentDiscussionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed }),
    });
    if (!res.ok) throw new Error('rename failed');
    const meta = await res.json();
    setDisplayedTitle(meta.title || 'New discussion');
  } catch (err) {
    console.error('Rename failed:', err);
  }
});

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
