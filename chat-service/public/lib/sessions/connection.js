function buildWsUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get('session');
  const qs = id ? `?session=${encodeURIComponent(id)}` : '';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${qs}`;
}

export function initConnection({ handleWsMessage, appendMessage, resetChatUi, onPopstate }) {
  let ws;
  let switchingSession = false;

  function connectWs() {
    ws = new WebSocket(buildWsUrl());
    // Drop in-flight frames from a superseded socket: after switchSession,
    // the old WebSocket can still deliver buffered messages briefly. Comparing
    // event.target to the current `ws` filters them out without needing extra
    // bookkeeping.
    ws.onmessage = (event) => {
      if (event.target === ws) handleWsMessage(event);
    };
    ws.onclose = () => {
      if (switchingSession) { switchingSession = false; return; }
      appendMessage('assistant', 'Connection lost. Please reload the page.');
    };
  }

  // Switch to another session (or start a fresh one with id=null) without
  // reloading the page — keeps the CRM iframe state intact.
  function switchSession(id) {
    switchingSession = true;
    try { ws?.close(); } catch {}
    const url = new URL(location.href);
    if (id) url.searchParams.set('session', id);
    else url.searchParams.delete('session');
    history.pushState({}, '', url);
    resetChatUi();
    connectWs();
  }

  // Like switchSession(null) but skips reconnecting — used when closing the
  // chat panel; the next switchSession() call brings the socket back.
  function closeSession() {
    switchingSession = true;
    try { ws?.close(); } catch {}
    const url = new URL(location.href);
    url.searchParams.delete('session');
    history.pushState({}, '', url);
    resetChatUi();
  }

  window.addEventListener('popstate', () => {
    switchingSession = true;
    try { ws?.close(); } catch {}
    resetChatUi();
    // Reconnect only if the user navigated back/forward into a state that
    // has a session — otherwise we'd silently spawn a new server session
    // just because the browser walked the history. Defer widget visibility
    // to the host so it can mirror the URL.
    const hasSession = !!new URLSearchParams(location.search).get('session');
    if (hasSession) connectWs();
    onPopstate?.(hasSession);
  });

  // Returns true if the payload was actually sent. Callers should treat false
  // as "user must retry" (e.g. show error, keep input intact).
  function safeSend(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return true;
  }

  return { connectWs, switchSession, closeSession, getWs: () => ws, safeSend };
}
