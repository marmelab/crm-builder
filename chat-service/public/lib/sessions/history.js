import { STATE_LABELS } from './state-labels.js';
import { formatRelative } from '../dom.js';
import { openConfirmModal } from './new_session_modal.js';

const TRASH_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

export function initHistory({ historyPanel, historyList, historyEmpty, getSessionId, switchSession, closeDiscussion }) {
  let refreshTimer = null;

  function refreshHistory() {
    if (historyPanel.classList.contains('collapsed')) return;
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

    const main = document.createElement('div');
    main.className = 'history-item-main';

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = d.title || '(untitled)';
    main.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const statePill = document.createElement('span');
    const st = d.state || 'in_progress';
    statePill.className = `history-state state-${st}`;
    statePill.textContent = STATE_LABELS[st] || st;
    meta.appendChild(statePill);
    meta.appendChild(document.createTextNode(` · ${formatRelative(d.lastMessageAt || d.createdAt)} · ${d.messageCount} message${d.messageCount > 1 ? 's' : ''}`));
    main.appendChild(meta);
    li.appendChild(main);

    const delBtn = document.createElement('button');
    delBtn.className = 'history-delete';
    delBtn.type = 'button';
    delBtn.title = 'Delete session';
    delBtn.setAttribute('aria-label', 'Delete session');
    delBtn.innerHTML = TRASH_ICON_SVG;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryItem(d);
    });
    li.appendChild(delBtn);

    li.addEventListener('click', () => {
      if (d.id === getSessionId()) {
        closeDiscussion();
        return;
      }
      switchSession(d.id);
    });
    return li;
  }

  async function deleteHistoryItem(d) {
    const ok = await openConfirmModal({
      title: 'Delete this session?',
      body: `"${d.title || '(untitled)'}" will be permanently removed. This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/sessions/${d.id}`, { method: 'DELETE' });
      if (!res.ok) {
        if (res.status === 409) {
          await openConfirmModal({
            title: 'Cannot delete',
            body: 'This session is still running. Stop the agent first.',
            confirmLabel: 'OK',
            hideCancel: true,
          });
        } else {
          console.error('Delete failed:', res.status);
        }
        return;
      }
      // If the deleted session was the one currently open, close the panel.
      // Otherwise the WS `session_deleted` push (other tabs) handles it.
      if (d.id === getSessionId()) closeDiscussion();
      loadHistory();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }

  loadHistory();

  return { refreshHistory, renderHistoryItem };
}
