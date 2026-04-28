function buildWsUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get('session');
  const qs = id ? `?session=${encodeURIComponent(id)}` : '';
  return `ws://${location.host}${qs}`;
}

export function initConnection({ handleWsMessage, appendMessage, resetChatUi }) {
  let ws;
  let switchingSession = false;

  function connectWs() {
    ws = new WebSocket(buildWsUrl());
    ws.onmessage = handleWsMessage;
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

  window.addEventListener('popstate', () => {
    switchingSession = true;
    try { ws?.close(); } catch {}
    resetChatUi();
    connectWs();
  });

  // Returns true if the payload was actually sent. Callers should treat false
  // as "user must retry" (e.g. show error, keep input intact).
  function safeSend(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return true;
  }

  return { connectWs, switchSession, getWs: () => ws, safeSend };
}
