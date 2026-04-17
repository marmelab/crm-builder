const widget  = document.getElementById('chat-widget');
const fab     = document.getElementById('chat-fab');
const toggle  = document.getElementById('chat-toggle');
const form    = document.getElementById('chat-form');
const input   = document.getElementById('chat-input');
const send    = document.getElementById('chat-send');
const status  = document.getElementById('chat-status');
const messages = document.getElementById('chat-messages');

let working = false;

// WebSocket
const ws = new WebSocket(`ws://${location.host}`);

ws.onmessage = (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }

  if (msg.type === 'status') {
    working = msg.working;
    send.disabled = working;
    status.textContent = working ? 'Working...' : '';
    const existing = messages.querySelector('.msg-working');
    if (working && !existing) {
      appendMessage('working', '⟳ Working on it...');
    } else if (!working && existing) {
      existing.remove();
    }
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

function appendMessage(role, content) {
  const el = document.createElement('div');
  el.className = `msg msg-${role}`;
  el.textContent = content;
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
