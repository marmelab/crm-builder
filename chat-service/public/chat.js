import { el, formatTokens } from './lib/dom.js';
import { renderStatsPanel } from './lib/stats/index.js';
import { initConnection, initDisplay, initHistory } from './lib/sessions/index.js';

const widget   = document.getElementById('chat-widget');
const toggle   = document.getElementById('chat-toggle');
const debugBtn = document.getElementById('chat-debug');
const stateBtn = document.getElementById('chat-state');
const newBtn = document.getElementById('chat-new');
const historyPanel = document.getElementById('chat-history-panel');
const historyCollapseBtn = document.getElementById('history-collapse');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');

historyCollapseBtn.addEventListener('click', () => {
  const collapsed = historyPanel.classList.toggle('collapsed');
  historyCollapseBtn.title = collapsed ? 'Expand panel' : 'Collapse panel';
  historyCollapseBtn.setAttribute('aria-label', historyCollapseBtn.title);
});
const chatTitle = document.getElementById('chat-title');
const form     = document.getElementById('chat-form');
const input    = document.getElementById('chat-input');
const send     = document.getElementById('chat-send');
const stopBtn = document.getElementById('chat-stop');
const messages = document.getElementById('chat-messages');
const stats = document.getElementById('chat-stats');
const statsBtn = document.getElementById('chat-stats-btn');
const statsPanel = document.getElementById('chat-stats-panel');
const statsPanelBody = document.getElementById('chat-stats-panel-body');
const statsCloseBtn = document.getElementById('chat-stats-close');

let working  = false;
let progressTotal = 0;
let progressDone  = 0;
let debugMode = false;
let hasUserMessage = false;
let statsMode = false;

let seqCounter = 0;

// Capped: an orchestrator turn emits hundreds of debug_raw frames; without a
// bound the buffer grows unboundedly across long sessions.
const DEBUG_BUFFER_MAX = 1000;
const debugEventBuffer = [];
function pushDebugEvent(entry) {
  debugEventBuffer.push(entry);
  if (debugEventBuffer.length > DEBUG_BUFFER_MAX) debugEventBuffer.shift();
}

function placeIntoMessages(el, seq) {
  el.dataset.seq = seq;
  // Don't yank the scroll back to bottom if the user has scrolled up to read.
  // Only auto-follow when they were already near the bottom before insertion.
  const NEAR_BOTTOM_PX = 80;
  const wasNearBottom =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < NEAR_BOTTOM_PX;
  for (const child of messages.children) {
    const cs = Number(child.dataset.seq);
    if (!Number.isNaN(cs) && cs > seq) {
      messages.insertBefore(el, child);
      if (wasNearBottom) messages.scrollTop = messages.scrollHeight;
      return;
    }
  }
  messages.appendChild(el);
  if (wasNearBottom) messages.scrollTop = messages.scrollHeight;
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

function switchSessionAndOpen(id) {
  widget.classList.remove('chat-closed');
  connection.switchSession(id);
}

function closeDiscussion() {
  widget.classList.add('chat-closed');
  connection.closeSession();
  historyApi.refreshHistoryIfOpen();
}

const display = initDisplay({
  chatTitle,
  stateBtn,
  newBtn,
  switchSession: switchSessionAndOpen,
  refreshHistoryIfOpen: () => historyApi.refreshHistoryIfOpen(),
});

const historyApi = initHistory({
  historyList,
  historyEmpty,
  getSessionId: () => display.getSessionId(),
  switchSession: switchSessionAndOpen,
  closeDiscussion,
});

const connection = initConnection({
  handleWsMessage,
  appendMessage,
  resetChatUi,
});

function resetChatUi() {
  messages.replaceChildren();
  display.setSessionId(null);
  if (statsMode) exitStatsMode();
  working = false;
  send.hidden = false;
  send.disabled = false;
  stopBtn.hidden = true;
  stopBtn.disabled = false;
  stats.textContent = '';
  progressTotal = 0;
  progressDone = 0;
  debugEventBuffer.length = 0;
}

function progressText() {
  if (!progressTotal || progressTotal <= 0) return '';
  const safeDone = Math.max(0, Math.min(progressDone, progressTotal));
  return `tasks completed ${safeDone}/${progressTotal}`;
}

function updateWorkingProgress() {
  const bubble = messages.querySelector('.msg-working');
  if (!bubble) return;
  const text = progressText();
  let line = bubble.querySelector('.msg-working-progress');
  if (!text) {
    if (line) line.remove();
    return;
  }
  if (!line) {
    line = document.createElement('span');
    line.className = 'msg-working-progress';
    bubble.appendChild(line);
  }
  line.textContent = text;
}

function renderWorkingUi() {
  stopBtn.hidden = !working;
  stopBtn.disabled = false;
  send.hidden = working;
  const existing = messages.querySelector('.msg-working');
  if (working && !existing) {
    const el = document.createElement('div');
    el.className = 'msg msg-working';
    el.dataset.seq = String(Number.MAX_SAFE_INTEGER);
    const dots = document.createElement('div');
    dots.className = 'bouncing-dots';
    dots.appendChild(document.createElement('span'));
    dots.appendChild(document.createElement('span'));
    dots.appendChild(document.createElement('span'));
    el.appendChild(dots);
    messages.appendChild(el);
    updateWorkingProgress();
    messages.scrollTop = messages.scrollHeight;
  } else if (!working && existing) {
    existing.remove();
  }
}

function handleWsMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  if (msg.type === 'init') {
    display.setSessionId(msg.sessionId);
    display.setDisplayedTitle(msg.title || 'New session');
    display.setDisplayedState(msg.state || 'in_progress');
    messages.innerHTML = '';
    const list = msg.messages || [];
    const queuedIdx = new Set();
    let remaining = msg.queuedCount || 0;
    for (let i = list.length - 1; i >= 0 && remaining > 0; i--) {
      if (list[i].role === 'user') { queuedIdx.add(i); remaining--; }
    }
    list.forEach((m, i) => appendMessage(m.role, m.content, { queued: queuedIdx.has(i) }));
    if (msg.working) {
      working = true;
      renderWorkingUi();
    }
    hasUserMessage = list.some((m) => m.role === 'user');
    historyApi.refreshHistoryIfOpen();
    return;
  }

  if (msg.type === 'state') {
    display.setDisplayedState(msg.state);
    historyApi.refreshHistoryIfOpen();
    return;
  }

  if (msg.type === 'title') {
    display.setDisplayedTitle(msg.title);
    historyApi.refreshHistoryIfOpen();
    return;
  }

  if (msg.type === 'status') {
    const wasWorking = working;
    working = msg.working;
    if (!wasWorking && working) {
      const oldestQueued = messages.querySelector('.msg-queued');
      if (oldestQueued) {
        oldestQueued.classList.remove('msg-queued');
        oldestQueued.querySelector('.queued-badge')?.remove();
      }
    }
    renderWorkingUi();
    if (statsMode && wasWorking !== working) scheduleStatsPanelRefresh();
    return;
  }

  if (msg.type === 'choices') {
    appendChoices(msg.content, msg.options);
    return;
  }

  if (msg.type === 'progress') {
    progressTotal = msg.total || 0;
    progressDone  = msg.done  || 0;
    updateWorkingProgress();
    return;
  }

  if (msg.type === 'stats') {
    const agents = msg.activeAgents || 0;
    const agentsPart = agents > 0 ? `🤖 ${agents} · ` : '';
    stats.textContent = `${agentsPart}${formatTokens(msg.tokensUsed)} tokens · $${msg.costUsd.toFixed(3)}`;
    if (statsMode) scheduleStatsPanelRefresh();
    return;
  }

  if (msg.type === 'debug') {
    const s = ++seqCounter;
    pushDebugEvent({ msg, seq: s });
    if (debugMode) appendDebug(msg.tool, msg.input, msg.agent, s);
    return;
  }

  if (msg.type === 'debug_raw') {
    const s = ++seqCounter;
    pushDebugEvent({ msg, seq: s });
    if (debugMode) renderDebugRaw(msg, s);
    return;
  }

  if (msg.type === 'message' && msg.role === 'assistant') {
    // Keep the working bubble visible — the turn isn't over until a
    // `status: working=false` frame arrives. The bubble's sentinel seq
    // ensures the new message lands above it.
    appendMessage('assistant', msg.content);
    historyApi.refreshHistoryIfOpen();
  }
}

connection.connectWs();

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
      if (!connection.safeSend({ content: id, display: label })) return;
      wrap.remove();
      appendMessage('user', label);
      hasUserMessage = true;
      historyApi.refreshHistoryIfOpen();
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

stopBtn.addEventListener('click', () => {
  if (!working || stopBtn.disabled) return;
  connection.safeSend({ type: 'stop' });
  stopBtn.disabled = true; // re-enabled on next status flip
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
  if (!connection.safeSend({ content })) {
    appendMessage('assistant', 'Connection lost. Please reload the page.');
    return;
  }
  appendMessage('user', content, { queued: working });
  historyApi.refreshHistoryIfOpen();
  input.value = '';
  input.style.height = 'auto';
  hasUserMessage = true;
});

// Close the chat widget. The sessions sidebar stays visible — clicking a
// session (or ✚ New) re-opens the widget via switchSessionAndOpen.
toggle.addEventListener('click', closeDiscussion);

// Debug toggle
debugBtn.addEventListener('click', () => {
  debugMode = !debugMode;
  debugBtn.classList.toggle('debug-active', debugMode);
  debugBtn.title = debugMode ? 'Debug ON' : 'Debug OFF';
  if (debugMode) {
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

const STATS_REFRESH_MIN_INTERVAL_MS = 2000;
let statsRefreshing = false;
let statsRefreshPendingTimer = null;
let statsLastRefreshAt = 0;

async function refreshStatsPanel() {
  if (!statsMode) return;
  const sessionId = display.getSessionId();
  if (!sessionId) return;
  if (statsRefreshing) return;
  statsRefreshing = true;
  statsLastRefreshAt = Date.now();
  try {
    const res = await fetch(`/api/stats?sessionId=${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (statsMode) renderStatsPanel(statsPanelBody, data);
  } catch (_err) {
    // Silent on background refresh — keep the previously-rendered panel visible.
  } finally {
    statsRefreshing = false;
  }
}

function scheduleStatsPanelRefresh() {
  if (!statsMode) return;
  if (statsRefreshPendingTimer) return;
  const since = Date.now() - statsLastRefreshAt;
  const delay = Math.max(0, STATS_REFRESH_MIN_INTERVAL_MS - since);
  statsRefreshPendingTimer = setTimeout(() => {
    statsRefreshPendingTimer = null;
    refreshStatsPanel();
  }, delay);
}

async function enterStatsMode() {
  if (!display.getSessionId()) return;
  statsMode = true;
  statsPanel.hidden = false;
  statsBtn.classList.add('stats-active');
  statsBtn.title = 'Hide session stats';

  statsPanelBody.replaceChildren(el('div', { className: 'stats-loading' }, 'Loading stats…'));
  try {
    const res = await fetch(`/api/stats?sessionId=${encodeURIComponent(display.getSessionId())}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderStatsPanel(statsPanelBody, data);
    statsLastRefreshAt = Date.now();
  } catch (err) {
    const retry = el('button', { id: 'stats-retry-btn', onclick: enterStatsMode }, 'Retry');
    const back  = el('button', { id: 'stats-back-btn',  onclick: exitStatsMode  }, '← Close');
    const label = el('div', null, el('strong', null, 'Failed to load stats:'), ' ', String(err.message));
    statsPanelBody.replaceChildren(el('div', { className: 'stats-error' }, label, retry, back));
  }
}

function exitStatsMode() {
  statsMode = false;
  statsPanel.hidden = true;
  statsPanelBody.replaceChildren();
  statsBtn.classList.remove('stats-active');
  statsBtn.title = 'Session stats';
  if (statsRefreshPendingTimer) {
    clearTimeout(statsRefreshPendingTimer);
    statsRefreshPendingTimer = null;
  }
}

statsBtn.addEventListener('click', () => {
  if (statsMode) exitStatsMode(); else enterStatsMode();
});
statsCloseBtn.addEventListener('click', exitStatsMode);
