import { STATE_LABELS } from './state-labels.js';
import { el, formatRelative } from '../dom.js';

export function initTimeline({
  timelinePanel,
  timelineList,
  timelineEmpty,
  timelineBtn,
  timelineClose,
  getSessionId,
  switchSession,
}) {
  let refreshTimer = null;

  function refreshIfOpen() {
    if (timelinePanel.hidden) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (timelinePanel.hidden) return;
      open();
    }, 250);
  }

  async function open() {
    try {
      const res = await fetch('/api/sessions');
      const list = await res.json();
      timelineList.innerHTML = '';
      if (list.length === 0) {
        timelineEmpty.hidden = false;
      } else {
        timelineEmpty.hidden = true;
        list.forEach((d) => timelineList.appendChild(renderItem(d)));
      }
      timelinePanel.hidden = false;
    } catch (err) {
      console.error('Failed to load timeline:', err);
    }
  }

  function formatAbsolute(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
      + ' · '
      + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function renderItem(d) {
    const li = document.createElement('li');
    li.className = 'timeline-item';
    if (d.id === getSessionId()) li.classList.add('active');

    const dot = el('span', { className: 'timeline-dot' });
    li.appendChild(dot);

    const body = el('div', { className: 'timeline-body' });

    const dateIso = d.lastMessageAt || d.createdAt;
    const date = el('div', { className: 'timeline-date', title: dateIso || '' },
      el('span', {}, formatAbsolute(dateIso)),
      el('span', { className: 'timeline-relative' }, formatRelative(dateIso)),
    );
    body.appendChild(date);

    const title = el('div', { className: 'timeline-title' }, d.summary || d.title || '(no summary yet)');
    body.appendChild(title);

    const meta = el('div', { className: 'timeline-meta' });
    const st = d.state || 'in_progress';
    meta.appendChild(el('span', {
      className: `timeline-state state-${st}`,
    }, STATE_LABELS[st] || st));
    meta.appendChild(el('span', { className: 'timeline-count' },
      `${d.messageCount} message${d.messageCount > 1 ? 's' : ''}`
    ));
    body.appendChild(meta);

    const actions = el('div', { className: 'timeline-actions' });

    const viewBtn = el('button', {
      className: 'timeline-action timeline-view',
      title: 'View chat log',
      onclick: (e) => {
        e.stopPropagation();
        if (d.id === getSessionId()) {
          timelinePanel.hidden = true;
          return;
        }
        switchSession(d.id);
        timelinePanel.hidden = true;
      },
    }, 'View log');

    const continueBtn = el('button', {
      className: 'timeline-action timeline-continue',
      title: 'Continue this session (date is updated to now)',
      onclick: async (e) => {
        e.stopPropagation();
        try {
          await fetch(`/api/sessions/${encodeURIComponent(d.id)}/touch`, { method: 'POST' });
        } catch (err) {
          console.error('Failed to touch session:', err);
        }
        if (d.id === getSessionId()) {
          timelinePanel.hidden = true;
          return;
        }
        switchSession(d.id);
        timelinePanel.hidden = true;
      },
    }, '↻ Continue');

    const isCompleted = d.state === 'completed';
    const rollbackBtn = el('button', {
      className: 'timeline-action timeline-rollback',
      title: isCompleted
        ? 'Rollback this session (not implemented yet)'
        : 'Rollback is only available on completed sessions',
      disabled: !isCompleted,
      onclick: (e) => {
        e.stopPropagation();
      },
    }, '⏪ Rollback');

    actions.appendChild(viewBtn);
    actions.appendChild(continueBtn);
    actions.appendChild(rollbackBtn);
    body.appendChild(actions);

    li.appendChild(body);
    return li;
  }

  timelineBtn.addEventListener('click', () => {
    if (timelinePanel.hidden) open();
    else timelinePanel.hidden = true;
  });
  timelineClose.addEventListener('click', () => { timelinePanel.hidden = true; });

  return { refreshIfOpen, open };
}
