import { openConfirmModal } from '../sessions/new_session_modal.js';

export function initRollback({ getSessionId, appendMessage }) {
  const btn = document.getElementById('chat-restore-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const sessionId = getSessionId();
    if (!sessionId) {
      console.warn('[rollback] no active session');
      return;
    }
    btn.disabled = true;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/commits`);
      if (!res.ok) {
        console.error('[rollback] fetch failed', res.status, await res.text());
        return;
      }
      const data = await res.json();
      console.log('[rollback] commits for session', data.sessionId, data);
      if (!data.commits?.length) {
        await openConfirmModal({
          title: 'Nothing to roll back',
          body: 'No changes from this session are still active.',
          confirmLabel: 'OK',
          hideCancel: true,
        });
        return;
      }

      const count = data.commits.length;
      const ok = await openConfirmModal({
        title: `Rollback ${count} commit${count > 1 ? 's' : ''}?`,
        body: 'This will revert every change made in this session. If git reports a conflict, the rollback stops.',
        confirmLabel: 'Rollback',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;

      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/rollback`, {
        method: 'POST',
      });
      const result = await r.json().catch(() => ({}));
      console.log('[rollback] result', r.status, result);
      const text = result.chatMessage || `Rollback failed: ${result.message || `HTTP ${r.status}`}`;
      appendMessage('assistant', text, { subtype: 'rollback' });
    } catch (err) {
      console.error('[rollback] error', err);
      appendMessage('assistant', `Rollback error: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}
