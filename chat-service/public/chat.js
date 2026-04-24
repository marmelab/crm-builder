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
const stopBtn = document.getElementById('chat-stop');
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
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} d ago`;
  return d.toLocaleDateString();
}

let working  = false;
let debugMode = false;
let currentSessionId = null;
let currentTitle = '';
let currentState = 'in_progress';

const STATE_LABELS = {
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  waiting: 'Waiting',
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
  const id = params.get('session');
  const qs = id ? `?session=${encodeURIComponent(id)}` : '';
  return `ws://${location.host}${qs}`;
}

let ws;
let switchingSession = false;

function connectWs() {
  ws = new WebSocket(buildWsUrl());
  ws.onmessage = handleWsMessage;
  ws.onclose = () => {
    if (switchingSession) { switchingSession = false; return; }
    appendMessage('assistant', 'Connection lost. Please reload the page.');
  };
}

// Switch to another session (or start a fresh one with id=null) without
// reloading the page — keeps the CRM iframe state intact.
function switchSession(id) {
  switchingSession = true;
  try { ws?.close(); } catch {}
  const url = new URL(location.href);
  if (id) url.searchParams.set('session', id);
  else url.searchParams.delete('session');
  history.pushState({}, '', url);
  resetChatUi();
  connectWs();
}

function resetChatUi() {
  messages.innerHTML = '';
  currentSessionId = null;
  currentTitle = '';
  working = false;
  send.disabled = false;
  statusDots.style.display = 'none';
  stopBtn.hidden = true;
  stopBtn.disabled = false;
  historyPanel.hidden = true;
  stats.textContent = '';
}

window.addEventListener('popstate', () => {
  switchingSession = true;
  try { ws?.close(); } catch {}
  resetChatUi();
  connectWs();
});

// Sync the dots, stop button, and "Working on it..." bubble to the current
// value of `working`. Called from both init (on reconnect) and the status
// handler (on live transitions). Intentionally does NOT touch .msg-queued
// bubbles — that demote logic is a false→true transition concern and lives
// in the status handler.
function renderWorkingUi() {
  statusDots.style.display = working ? 'inline-flex' : 'none';
  stopBtn.hidden = !working;
  stopBtn.disabled = false;
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
}

function handleWsMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  if (msg.type === 'init') {
    currentSessionId = msg.sessionId;
    setDisplayedTitle(msg.title || 'New session');
    setDisplayedState(msg.state || 'in_progress');
    messages.innerHTML = '';
    const list = msg.messages || [];
    // The last `queuedCount` user messages are still sitting in the server's
    // queue — re-apply the "waiting" badge on reconnect.
    const queuedIdx = new Set();
    let remaining = msg.queuedCount || 0;
    for (let i = list.length - 1; i >= 0 && remaining > 0; i--) {
      if (list[i].role === 'user') { queuedIdx.add(i); remaining--; }
    }
    list.forEach((m, i) => appendMessage(m.role, m.content, { queued: queuedIdx.has(i) }));
    // Re-hydrate the "working" visuals directly (not through the status
    // handler) — going through the handler would interpret this as a new
    // turn starting and demote the queued bubbles we just rendered.
    if (msg.working) {
      working = true;
      renderWorkingUi();
    }
    refreshHistoryIfOpen();
    return;
  }

  if (msg.type === 'state') {
    setDisplayedState(msg.state);
    refreshHistoryIfOpen();
    return;
  }

  if (msg.type === 'title') {
    setDisplayedTitle(msg.title);
    refreshHistoryIfOpen();
    return;
  }

  if (msg.type === 'status') {
    const wasWorking = working;
    working = msg.working;
    // working=true coming out of an idle state means a queued message just
    // started processing — promote the oldest queued bubble to normal. Only
    // fire on a real false→true transition: `init` may set working=true
    // already on reconnect, and demoting there would strip the badge off
    // still-queued messages.
    if (!wasWorking && working) {
      const oldestQueued = messages.querySelector('.msg-queued');
      if (oldestQueued) {
        oldestQueued.classList.remove('msg-queued');
        oldestQueued.querySelector('.queued-badge')?.remove();
      }
    }
    renderWorkingUi();
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
    refreshHistoryIfOpen();
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
  if (s === 'cancelled') {
    stateBtn.title = 'Session cancelled by user — send a message to restart';
  } else if (s === 'waiting') {
    stateBtn.title = 'Claude is waiting for your reply';
  } else if (s === 'completed') {
    stateBtn.title = 'Claude session ended — send a message to restart';
  } else {
    stateBtn.title = 'Claude is working…';
  }
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
      refreshHistoryIfOpen();
    });
    wrap.appendChild(btn);
  });

  placeIntoMessages(wrap, seq);
}

function appendMessage(role, content, seqOrOpts = ++seqCounter) {
  const opts = typeof seqOrOpts === 'object' && seqOrOpts !== null ? seqOrOpts : {};
  const seq = typeof seqOrOpts === 'number' ? seqOrOpts : (opts.seq ?? ++seqCounter);
  const queued = !!opts.queued;
  const el = document.createElement('div');
  el.className = `msg msg-${role}${queued ? ' msg-queued' : ''}`;
  el.textContent = content;
  if (queued) {
    const badge = document.createElement('span');
    badge.className = 'queued-badge';
    badge.textContent = '⏳ waiting';
    el.appendChild(badge);
  }
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
// Debounced refresh for the open panel. Triggered by WS events that change
// list data (new message → messageCount/lastMessageAt, title/state changes)
// and by local sends (the server updates meta before we get any echo back).
let historyRefreshTimer = null;
function refreshHistoryIfOpen() {
  if (historyPanel.hidden) return;
  clearTimeout(historyRefreshTimer);
  historyRefreshTimer = setTimeout(openHistory, 250);
}

async function openHistory() {
  try {
    const res = await fetch('/api/sessions');
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
  if (d.id === currentSessionId) li.classList.add('active');

  const title = document.createElement('div');
  title.className = 'history-title';
  title.textContent = d.title || '(untitled)';
  li.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'history-meta';
  const statePill = document.createElement('span');
  const st = d.state || 'in_progress';
  statePill.className = `history-state state-${st}`;
  statePill.textContent = STATE_LABELS[st] || st;
  meta.appendChild(statePill);
  meta.appendChild(document.createTextNode(` · ${formatRelative(d.lastMessageAt || d.createdAt)} · ${d.messageCount} message${d.messageCount > 1 ? 's' : ''}`));
  li.appendChild(meta);

  li.addEventListener('click', () => {
    if (d.id === currentSessionId) {
      historyPanel.hidden = true;
      return;
    }
    switchSession(d.id);
  });
  return li;
}

historyBtn.addEventListener('click', () => {
  if (historyPanel.hidden) openHistory();
  else historyPanel.hidden = true;
});
historyClose.addEventListener('click', () => { historyPanel.hidden = true; });

stopBtn.addEventListener('click', () => {
  if (!working || stopBtn.disabled) return;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
  }
  stopBtn.disabled = true; // re-enabled on next status flip
});

newBtn.addEventListener('click', () => {
  switchSession(null);
});

// ─── Title rename ───────────────────────────────────────────
chatTitle.addEventListener('click', async () => {
  if (!currentSessionId) return;
  const next = prompt('Rename session:', currentTitle);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === currentTitle) return;
  try {
    const res = await fetch(`/api/sessions/${currentSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed }),
    });
    if (!res.ok) throw new Error('rename failed');
    const meta = await res.json();
    setDisplayedTitle(meta.title || 'New session');
    refreshHistoryIfOpen();
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
  if (!content) return;
  appendMessage('user', content, { queued: working });
  ws.send(JSON.stringify({ content }));
  refreshHistoryIfOpen();
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
