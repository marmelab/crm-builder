import { STATE_LABELS } from './state-labels.js';
import { formatRelative } from '../dom.js';

export function initHistory({ historyList, historyEmpty, getSessionId, switchSession, closeDiscussion }) {
  let refreshTimer = null;

  function refreshHistoryIfOpen() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadHistory, 250);
  }

  async function loadHistory() {
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
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }

  function renderHistoryItem(d) {
    const li = document.createElement('li');
    li.className = 'history-item';
    if (d.id === getSessionId()) li.classList.add('active');

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
      if (d.id === getSessionId()) {
        closeDiscussion();
        return;
      }
      switchSession(d.id);
    });
    return li;
  }

  loadHistory();

  return { refreshHistoryIfOpen, openHistory: loadHistory };
}
