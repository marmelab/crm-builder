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
          title: 'Nothing to undo',
          body: 'There are no changes from this session left to undo.',
          confirmLabel: 'OK',
          hideCancel: true,
        });
        return;
      }

      // Pin the displayed session title — same reasoning as `sessionId` above:
      // the user might rename the chat while the confirm modal is open, but
      // they decided to undo the session as they see it now.
      const sessionTitle = document.getElementById('chat-title')?.textContent?.trim();

      // If any of this session's commits has been extended by later commits
      // (overlappingLaterCommits) on the base branch, undoing it can't be a
      // simple revert — the agent will have to figure out a resolution and
      // it may not produce what the user expects. Warn explicitly.
      const overlapCount = data.commits.reduce(
        (n, c) => n + (c.overlappingLaterCommits?.length || 0),
        0,
      );
      const baseBody = sessionTitle
        ? `Every change made in the session "${sessionTitle}" will be undone. Other sessions stay untouched.`
        : 'Every change made in this session will be undone. Other sessions stay untouched.';
      const body = overlapCount > 0
        ? `${baseBody}\n\nHeads up: this session's changes were extended by ${overlapCount} later change(s) on the same files. The system will try to undo it cleanly, but the result may differ from what you expect — and in some cases the undo can't be applied at all.`
        : baseBody;
      const ok = await openConfirmModal({
        title: 'Undo this session?',
        body,
        confirmLabel: overlapCount > 0 ? 'Undo anyway' : 'Undo',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
      if (getSessionId() !== sessionId) return;

      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/rollback`, {
        method: 'POST',
      });
      const result = await r.json().catch(() => ({}));
      // The server broadcasts the assistant message via WS for success (200),
      // conflict-handed-off-to-agent (202), and the legacy conflict-aborted
      // (409). Only unexpected failures (500, parse error, etc.) reach the
      // client without a broadcast, so we render those locally.
      const stillActive = getSessionId() === sessionId;
      const serverBroadcasted = r.ok || r.status === 409;
      if (!serverBroadcasted && stillActive) {
        const text = result.chatMessage
          || "We couldn't undo your changes right now. Please try again in a moment.";
        appendMessage('assistant', text, { subtype: 'rollback' });
      }
    } catch (err) {
      console.error('[rollback] error', err);
      if (getSessionId() === sessionId) {
        appendMessage(
          'assistant',
          "We couldn't undo your changes right now. Please try again in a moment.",
          { subtype: 'rollback' },
        );
      }
    } finally {
      btn.disabled = false;
    }
  });
}
