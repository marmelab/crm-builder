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

let working  = false;
let debugMode = false;

const TOOL_LABELS = {
  Task:       '🤖 Agent',
  TeamCreate: '👥 Agent team',
  TeamDelete: '✓  Agent team done',
  Read:       '📖 Reading',
  Write:      '✏️  Writing',
  Edit:       '✏️  Editing',
  Bash:       '⚡ Running command',
  Glob:       '🔍 Searching files',
  Grep:       '🔍 Searching code',
};

const ws = new WebSocket(`ws://${location.host}`);

ws.onmessage = (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

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

  if (msg.type === 'debug') {
    if (debugMode) appendDebug(msg.tool, msg.input);
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

function appendChoices(content, options) {
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
    });
    wrap.appendChild(btn);
  });

  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}

function appendMessage(role, content) {
  const el = document.createElement('div');
  el.className = `msg msg-${role}`;
  el.textContent = content;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

function appendDebug(toolName, input) {
  const label = TOOL_LABELS[toolName] || `🔧 ${toolName}`;
  const el = document.createElement('div');
  el.className = 'msg msg-debug';

  const name = document.createElement('span');
  name.className = 'debug-tool';
  name.textContent = label;
  el.appendChild(name);

  // Single agent: show its description
  if (toolName === 'Task' && input?.description) {
    const detail = document.createElement('span');
    detail.className = 'debug-detail';
    detail.textContent = input.description;
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

  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
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
  if (!debugMode) {
    messages.querySelectorAll('.msg-debug').forEach((el) => el.remove());
  }
});
