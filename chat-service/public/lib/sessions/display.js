import { STATE_LABELS } from './state-labels.js';

export function initDisplay({ chatTitle, stateBtn, newBtn, switchSession, refreshSessionPanels }) {
  let currentSessionId = null;
  let currentTitle = '';

  function setDisplayedTitle(t) {
    currentTitle = t;
    chatTitle.textContent = t;
  }

  function setDisplayedState(s) {
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
      refreshSessionPanels();
    } catch (err) {
      console.error('Rename failed:', err);
    }
  });

  newBtn.addEventListener('click', () => {
    switchSession(null);
  });

  return {
    setDisplayedTitle,
    setDisplayedState,
    getSessionId: () => currentSessionId,
    setSessionId: (id) => { currentSessionId = id; },
  };
}
