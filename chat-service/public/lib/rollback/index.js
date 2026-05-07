import { openConfirmModal } from '../sessions/new_session_modal.js';

export function initRollback({ getSessionId, appendMessage }) {
  const btn = document.getElementById('chat-restore-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    // Pin the session at click time — if the user switches tabs while the
    // confirm modal is open, we must not roll back the new session.
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
      if (getSessionId() !== sessionId) return;

      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/rollback`, {
        method: 'POST',
      });
      const result = await r.json().catch(() => ({}));
      // The server broadcasts the assistant message via WS for both success
      // (200) and conflict (409) — those don't need a local render. Only
      // unexpected failures (500, parse error, etc.) reach the client without
      // a broadcast, so we render those locally.
      const stillActive = getSessionId() === sessionId;
      const serverBroadcasted = r.ok || r.status === 409;
      if (!serverBroadcasted && stillActive) {
        const text = result.chatMessage || `Rollback failed: ${result.message || `HTTP ${r.status}`}`;
        appendMessage('assistant', text, { subtype: 'rollback' });
      }
    } catch (err) {
      console.error('[rollback] error', err);
      if (getSessionId() === sessionId) {
        appendMessage('assistant', `Rollback error: ${err.message}`, { subtype: 'rollback' });
      }
    } finally {
      btn.disabled = false;
    }
  });
}
