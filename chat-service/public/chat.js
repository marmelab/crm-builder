import { el, formatTokens } from './lib/dom.js';
import { renderStatsPanel, initStatsRefresh } from './lib/stats/index.js';
import { initConnection, initDisplay, initHistory, openConfirmModal, initRecentPopup } from './lib/sessions/index.js';
import { renderInlineMarkdown } from './lib/markdown.js';
import { initRollback } from './lib/rollback/index.js';

const widget   = document.getElementById('chat-widget');
const toggle   = document.getElementById('chat-toggle');
const debugBtn = document.getElementById('chat-debug');
const stateBtn = document.getElementById('chat-state');
const newBtn = document.getElementById('chat-new');
const historyPanel = document.getElementById('chat-history-panel');
const historyCollapseBtn = document.getElementById('history-collapse');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const chatTitle = document.getElementById('chat-title');
const form     = document.getElementById('chat-form');
const input    = document.getElementById('chat-input');
const send     = document.getElementById('chat-send');
const stopBtn = document.getElementById('chat-stop');
const messages = document.getElementById('chat-messages');
const stats = document.getElementById('chat-stats');
const statsBtn = document.getElementById('chat-stats-btn');
const statsPanel = document.getElementById('chat-stats-panel');
const statsPanelBody = document.getElementById('chat-stats-panel-body');
const statsCloseBtn = document.getElementById('chat-stats-close');

let working  = false;
let progressTotal = 0;
let progressDone  = 0;
let progressSteps = [];
// Remaining time is computed server-side from fixed per-role durations and
// shipped in the `progress` payload. We anchor the snapshot to its reception
// time so the displayed value can tick down smoothly between events.
let remainingTimeMsAtReceipt = 0;
let remainingTimeReceivedAt = 0;
let remainingTimeTickHandle = null;
let debugMode = false;
let statsMode = false;

let seqCounter = 0;

// Capped: an orchestrator turn emits hundreds of debug_raw frames; without a
// bound the buffer grows unboundedly across long sessions.
const DEBUG_BUFFER_MAX = 1000;
const debugEventBuffer = [];
function pushDebugEvent(entry) {
  debugEventBuffer.push(entry);
  if (debugEventBuffer.length > DEBUG_BUFFER_MAX) debugEventBuffer.shift();
}

function placeIntoMessages(el, seq) {
  el.dataset.seq = seq;
  // Don't yank the scroll back to bottom if the user has scrolled up to read.
  // Only auto-follow when they were already near the bottom before insertion.
  const NEAR_BOTTOM_PX = 80;
  const wasNearBottom =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < NEAR_BOTTOM_PX;
  for (const child of messages.children) {
    const cs = Number(child.dataset.seq);
    if (!Number.isNaN(cs) && cs > seq) {
      messages.insertBefore(el, child);
      if (wasNearBottom) messages.scrollTop = messages.scrollHeight;
      return;
    }
  }
  messages.appendChild(el);
  if (wasNearBottom) messages.scrollTop = messages.scrollHeight;
}

const TOOL_LABELS = {
  orchestrator: '🎭 Orchestrator',
  Task:         '🤖 Agent',
  Agent:        '🤖 Agent',
  agent_output: '💬 Agent reply',
  TeamCreate:   '👥 Team spawned',
  TeamDelete:   '✓  Team done',
  Read:         '📖 Reading',
  Write:        '✏️  Writing',
  Edit:         '✏️  Editing',
  Bash:         '⚡ Running command',
  Glob:         '🔍 Searching files',
  Grep:         '🔍 Searching code',
  SendMessage:  '✉️  Message',
  system:       '🔌 Session started',
  result:       '✅ Turn complete',
};

function switchSessionAndOpen(id) {
  widget.classList.remove('chat-closed');
  connection.switchSession(id);
  if (id === null) input.focus();
}

function closeDiscussion() {
  widget.classList.add('chat-closed');
  connection.closeSession();
  // No refresh: closing the panel doesn't change the sessions list contents.
  // The .active marker on the previously-open session is cleared locally so
  // the sidebar reflects "no session open" without hitting /api/sessions.
  historyList.querySelector('.history-item.active')?.classList.remove('active');
}

const display = initDisplay({
  chatTitle,
  stateBtn,
  newBtn,
  switchSession: switchSessionAndOpen,
  refreshHistory: () => historyApi.refreshHistory(),
});

const historyApi = initHistory({
  historyPanel,
  historyList,
  historyEmpty,
  getSessionId: () => display.getSessionId(),
  switchSession: switchSessionAndOpen,
  closeDiscussion,
});

initRollback({ getSessionId: () => display.getSessionId(), appendMessage });

const connection = initConnection({
  handleWsMessage,
  appendMessage,
  resetChatUi,
  onPopstate: (hasSession) => {
    widget.classList.toggle('chat-closed', !hasSession);
  },
});

function clearMessageNodes() {
  messages.querySelectorAll('.msg, .msg-choices, .msg-working').forEach((n) => n.remove());
}

function resetChatUi() {
  clearMessageNodes();
  display.setSessionId(null);
  if (statsMode) exitStatsMode();
  working = false;
  send.hidden = false;
  send.disabled = false;
  stopBtn.hidden = true;
  stopBtn.disabled = false;
  stats.textContent = '';
  progressTotal = 0;
  progressDone = 0;
  progressSteps = [];
  remainingTimeMsAtReceipt = 0;
  remainingTimeReceivedAt = 0;
  stopRemainingTimeTicker();
  debugEventBuffer.length = 0;
}

function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return 'Estimated: less than a minute remaining';
  const min = Math.round(sec / 60);
  if (min < 60) return `Estimated: ~${min} min remaining`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `Estimated: ~${h}h ${m}min remaining` : `Estimated: ~${h}h remaining`;
}

function startRemainingTimeTicker() {
  if (remainingTimeTickHandle) return;
  // 5s cadence — fast enough that the estimate "breathes" with elapsed time,
  // slow enough to avoid layout churn while the user reads other messages.
  remainingTimeTickHandle = setInterval(tickRemainingTime, 5000);
}

function stopRemainingTimeTicker() {
  if (!remainingTimeTickHandle) return;
  clearInterval(remainingTimeTickHandle);
  remainingTimeTickHandle = null;
}

// Remaining-time text computed from the server snapshot, decremented by
// wall-clock so the countdown stays smooth between progress events. If the
// snapshot hasn't arrived yet (right after sending a message), we still want
// to render *something* under the bar, so default to "Estimating…".
function remainingTimeText() {
  if (remainingTimeMsAtReceipt > 0 && remainingTimeReceivedAt > 0) {
    const live = remainingTimeMsAtReceipt - (Date.now() - remainingTimeReceivedAt);
    return live > 0 ? formatRemaining(live) || '' : 'Wrapping up…';
  }
  return 'Estimating remaining time…';
}

// Lean tick — only the remaining-time <span> can change between progress
// events, so avoid querying/rewriting the bar, fill and label every 5s.
// The `:not(.msg-assistant)` qualifier targets the spinner bubble, not the
// demoted prior-turn narrations that also carry `.msg-working`.
function tickRemainingTime() {
  const bubble = messages.querySelector('.msg-working:not(.msg-assistant)');
  if (!bubble) { stopRemainingTimeTicker(); return; }
  const remainingTimeEl = bubble._remainingTimeEl;
  if (!remainingTimeEl) return;
  remainingTimeEl.textContent = remainingTimeText();
}

// Identifies the latest assistant narration of the current turn (walking back
// to the previous user message). Marks it with `.msg-mirrored` so CSS can hide
// the standalone bubble — its content is mirrored inside the working bubble.
function refreshMirroredNarration() {
  const all = messages.querySelectorAll('.msg');
  let latest = null;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m.classList.contains('msg-user')) break;
    if (m.classList.contains('msg-rollback')) continue;
    if (m.classList.contains('msg-working') && !m.classList.contains('msg-assistant')) continue;
    if (m.classList.contains('msg-assistant')) { latest = m; break; }
  }
  messages.querySelectorAll('.msg-mirrored').forEach((n) => {
    if (n !== latest) n.classList.remove('msg-mirrored');
  });
  if (latest) latest.classList.add('msg-mirrored');
  return latest;
}

// Builds the inner HTML for the mirrored slot from the source narration,
// stripping the `.msg-time` span (it would otherwise leak into the bubble).
function narrationHtmlForMirror(source) {
  const temp = document.createElement('div');
  temp.innerHTML = source.innerHTML;
  temp.querySelectorAll('.msg-time').forEach((n) => n.remove());
  return temp.innerHTML;
}

function updateWorkingProgress() {
  const bubble = messages.querySelector('.msg-working:not(.msg-assistant)');
  if (!bubble) return;
  let wrap = bubble.querySelector('.msg-working-progress');
  // Always render the bar — even before any step info is known. With no info
  // the fallback paints a single pending segment so the bar reads as 0%, which
  // is more reassuring than a hint while the user waits for the first event.
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'msg-working-progress';
    const bar = document.createElement('div');
    bar.className = 'msg-working-progress-bar';
    const lastMessage = document.createElement('div');
    lastMessage.className = 'msg-working-progress-last-message';
    // Inner wrapper holds the clamped text; the outer flex-centres it inside
    // the reserved 3-line block so short narrations don't stick to the top.
    const lastMessageText = document.createElement('div');
    lastMessageText.className = 'msg-working-progress-last-message-text';
    lastMessage.appendChild(lastMessageText);
    const remainingTime = document.createElement('span');
    remainingTime.className = 'msg-working-progress-remaining-time';
    wrap.append(bar, lastMessage, remainingTime);
    bubble.appendChild(wrap);
    bubble._barEl = bar;
    bubble._lastMessageEl = lastMessageText;
    bubble._remainingTimeEl = remainingTime;
  }
  renderProgressSegments(bubble._barEl);
  const latest = refreshMirroredNarration();
  if (latest) {
    bubble._lastMessageEl.innerHTML = narrationHtmlForMirror(latest);
  } else {
    // No narration has streamed in yet — give the slot a soft placeholder so
    // the bubble doesn't feel half-rendered while we wait for the first one.
    bubble._lastMessageEl.textContent = 'Thinking…';
  }
  bubble._remainingTimeEl.textContent = remainingTimeText();
}

// Bar segments are flex-sized by `durationMs` so a long-running role (e.g.
// developer at 500s) visually dwarfs a quick one (merger at 30s). When the
// server omits steps (legacy / edge), fall back to N equal segments so the
// label/remaining-time still match the bar.
function renderProgressSegments(bar) {
  const steps = progressSteps.length
    ? progressSteps
    : fallbackEqualSteps(progressTotal, progressDone);

  if (bar.children.length !== steps.length) {
    bar.replaceChildren(...steps.map(makeStepEl));
  }

  steps.forEach((step, i) => {
    updateStepEl(bar.children[i], step);
  });
}

function makeStepEl() {
  const seg = document.createElement('div');
  seg.className = 'msg-working-progress-step';
  const mask = document.createElement('div');
  mask.className = 'msg-working-progress-step-mask';
  seg.appendChild(mask);
  return seg;
}

// Step-driven only: status maps to a class, CSS handles the mask transition.
// pending/in_progress → mask fully covers the segment (scaleX(1) by default);
// done → mask collapses (scaleX(0) via `.is-done` rule). No wall-clock fill.
function updateStepEl(seg, step) {
  seg.style.flexGrow = String(Math.max(1, step.durationMs));
  seg.title = `${step.role} · ${Math.round(step.durationMs / 1000)}s`;
  if (seg.dataset.status === step.status) return;
  seg.dataset.status = step.status;
  seg.className = `msg-working-progress-step is-${step.status}`;
}

function fallbackEqualSteps(total, done) {
  // No info yet (right after sending a message): paint a single pending
  // segment so the bar reads as 0%. Without this the bar would be empty
  // and the blue stripes underneath would look like 100% done.
  if (total <= 0) return [{ role: '', durationMs: 1, status: 'pending' }];
  const out = [];
  for (let i = 0; i < total; i++) {
    out.push({ role: '', durationMs: 1, status: i < done ? 'done' : 'pending' });
  }
  return out;
}

function renderWorkingUi() {
  stopBtn.hidden = !working;
  stopBtn.disabled = false;
  send.hidden = working;
  const existing = messages.querySelector('.msg-working:not(.msg-assistant)');
  if (working && !existing) {
    const el = document.createElement('div');
    el.className = 'msg msg-working';
    el.dataset.seq = String(Number.MAX_SAFE_INTEGER);
    messages.appendChild(el);
    updateWorkingProgress();
    messages.scrollTop = messages.scrollHeight;
  } else if (!working && existing) {
    existing.remove();
    // Reveal the latest narration that the bubble had been mirroring — once
    // the turn is over, it becomes the user-visible "result" of the turn.
    messages.querySelectorAll('.msg-mirrored').forEach((n) => n.classList.remove('msg-mirrored'));
  }
}

function handleWsMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }

  if (msg.type === 'init') {
    display.setSessionId(msg.sessionId);
    // Reflect the live session in the URL so a refresh resumes it instead
    // of being treated as "no session" and closing the widget. replace, not
    // push — the empty-URL state is transitional and shouldn't stack in history.
    const url = new URL(location.href);
    if (url.searchParams.get('session') !== msg.sessionId) {
      url.searchParams.set('session', msg.sessionId);
      history.replaceState({}, '', url);
    }
    display.setDisplayedTitle(msg.title || 'New session');
    display.setDisplayedState(msg.state || 'in_progress');
    clearMessageNodes();
    // Prefer the chronological timeline; fall back to the legacy split fields
    // if the server didn't send one (older deploy).
    const timeline = Array.isArray(msg.timeline) && msg.timeline.length
      ? msg.timeline
      : [
          ...(msg.messages || []).map((m) => ({ kind: 'message', role: m.role, content: m.content })),
          ...(msg.debugEvents || []).map((d) => ({ kind: 'debug', ...d })),
        ];
    // Tail user messages still in the queue: walk the timeline backwards and
    // mark the last N user-message items as queued (queue holds user-only).
    const queuedIdx = new Set();
    let remaining = msg.queuedCount || 0;
    for (let i = timeline.length - 1; i >= 0 && remaining > 0; i--) {
      const it = timeline[i];
      if (it.kind === 'message' && it.role === 'user') {
        queuedIdx.add(i);
        remaining--;
      }
    }
    timeline.forEach((it, i) => {
      if (it.kind === 'message') {
        appendMessage(it.role, it.content, { queued: queuedIdx.has(i), subtype: it.subtype, ts: it.ts });
        return;
      }
      // Debug event — buffer it so a later debug-toggle ON can replay it,
      // and render now if debug is already ON.
      const s = ++seqCounter;
      pushDebugEvent({ msg: it, seq: s });
      if (debugMode) {
        if (it.type === 'debug') appendDebug(it.tool, it.input, it.agent, s);
        else if (it.type === 'debug_raw') renderDebugRaw(it, s);
      }
    });
    markStaleWorkingMessages();
    if (msg.working) {
      working = true;
      // On resume, the remaining time stays as "Estimating…" until the next
      // `progress` event lands with a fresh server-side estimate.
      startRemainingTimeTicker();
      renderWorkingUi();
    }
    historyApi.refreshHistory();
    return;
  }

  if (msg.type === 'session_deleted') {
    // Server is about to tear down the WS; close the panel cleanly so the
    // user doesn't see a "Connection lost" toast for a session they just
    // deleted (possibly from another tab).
    closeDiscussion();
    historyApi.refreshHistory();
    return;
  }

  if (msg.type === 'state') {
    display.setDisplayedState(msg.state);
    historyApi.refreshHistory();
    return;
  }

  if (msg.type === 'title') {
    display.setDisplayedTitle(msg.title);
    historyApi.refreshHistory();
    return;
  }

  if (msg.type === 'status') {
    const wasWorking = working;
    working = msg.working;
    if (!wasWorking && working) {
      // Reset stale progress from the previous turn so the bar starts at 0%
      // and the bubble doesn't briefly flash "100% done" before the first
      // `progress` frame of the new turn arrives.
      progressTotal = 0;
      progressDone = 0;
      progressSteps = [];
      remainingTimeMsAtReceipt = 0;
      remainingTimeReceivedAt = 0;
      startRemainingTimeTicker();
      const oldestQueued = messages.querySelector('.msg-queued');
      if (oldestQueued) {
        oldestQueued.classList.remove('msg-queued');
        oldestQueued.querySelector('.queued-badge')?.remove();
      }
    } else if (wasWorking && !working) {
      stopRemainingTimeTicker();
      remainingTimeMsAtReceipt = 0;
      remainingTimeReceivedAt = 0;
    }
    renderWorkingUi();
    if (statsMode && wasWorking !== working) statsRefresh.schedule();
    return;
  }

  if (msg.type === 'choices') {
    appendChoices(msg.content, msg.options);
    return;
  }

  if (msg.type === 'progress') {
    progressTotal = msg.total || 0;
    progressDone  = msg.done  || 0;
    progressSteps = Array.isArray(msg.steps) ? msg.steps : [];
    if (typeof msg.remainingTimeMs === 'number') {
      remainingTimeMsAtReceipt = msg.remainingTimeMs;
      remainingTimeReceivedAt = Date.now();
    }
    updateWorkingProgress();
    return;
  }

  if (msg.type === 'mode_changed') {
    const prevMode = modeToggleBtn.dataset.mode || 'demo';
    const prevStarting = modeToggleBtn.classList.contains('mode-starting');
    updateModeBtn(msg.mode, msg.supabaseReady ?? false);
    // Reload the CRM iframe when the mode actually changes, or when Supabase
    // transitions from starting to ready (so the app connects with a live DB).
    const modeChanged = msg.mode !== prevMode;
    const justReady = msg.mode === 'full' && prevStarting && (msg.supabaseReady ?? false);
    if (modeChanged || justReady) {
      const frame = document.getElementById('crm-frame');
      if (frame) frame.src = frame.src;
    }
    return;
  }

  if (msg.type === 'stats') {
    const agents = msg.activeAgents || 0;
    const agentsPart = agents > 0 ? `🤖 ${agents} · ` : '';
    const total = (typeof msg.tokensTotal === 'number') ? msg.tokensTotal : msg.tokensUsed;
    stats.textContent = `${agentsPart}${formatTokens(total)} tokens · $${msg.costUsd.toFixed(2)}`;

    if (statsMode) statsRefresh.schedule();
    return;
  }

  if (msg.type === 'debug') {
    const s = ++seqCounter;
    pushDebugEvent({ msg, seq: s });
    if (debugMode) appendDebug(msg.tool, msg.input, msg.agent, s);
    return;
  }

  if (msg.type === 'debug_raw') {
    const s = ++seqCounter;
    pushDebugEvent({ msg, seq: s });
    if (debugMode) renderDebugRaw(msg, s);
    return;
  }

  if (msg.type === 'message' && msg.role === 'assistant') {
    // Keep the working bubble visible — the turn isn't over until a
    // `status: working=false` frame arrives. The bubble's sentinel seq
    // ensures the new message lands above it.
    appendMessage('assistant', msg.content, { subtype: msg.subtype, ts: msg.ts });
    historyApi.refreshHistory();
  }
}

// Refreshing without a session in the URL must NOT spawn a fresh server
// session — the user closed the discussion deliberately, and a new session
// would also litter sessions/ with empty directories. Connect only when
// there's a session to resume; otherwise keep the widget closed and let
// the user pick from history or click "New session".
if (new URLSearchParams(location.search).get('session')) {
  connection.connectWs();
} else {
  widget.classList.add('chat-closed');
}

document.getElementById('chat-empty-link').addEventListener('click', async () => {
  if (!(await openConfirmModal())) return;
  const label = '🗺️  Set up my CRM from scratch';
  if (!connection.safeSend({ content: 'FULL_SETUP', display: label })) return;
  appendMessage('user', label);
  historyApi.refreshHistory();
});

function appendChoices(content, options, seq = ++seqCounter) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-choices';

  const text = document.createElement('p');
  text.className = 'choices-text';
  text.textContent = content;
  wrap.appendChild(text);

  options.forEach(({ id, label, sublabel }) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    const lbl = document.createElement('span');
    lbl.className = 'choice-label';
    lbl.textContent = label;
    btn.appendChild(lbl);
    if (sublabel) {
      const sub = document.createElement('span');
      sub.className = 'choice-sublabel';
      sub.textContent = sublabel;
      btn.appendChild(sub);
    }
    btn.addEventListener('click', () => {
      if (!connection.safeSend({ content: id, display: label })) return;
      wrap.remove();
      appendMessage('user', label);
      historyApi.refreshHistory();
    });
    wrap.appendChild(btn);
  });

  placeIntoMessages(wrap, seq);
}

const ROLLBACK_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2"/><path d="M16 21h2a2 2 0 0 0 2-2V8"/><path d="m9 15 3-3 3 3"/><path d="M12 12v9"/></svg>';

function formatMessageTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${time}`;
}

// Walk back through messages within the current turn (i.e. until the last
// user message) and add `msg-working` to the most recent unmarked assistant
// narration. Rollback bubbles aren't narrations and are skipped.
function demotePreviousTurnAssistant() {
  const all = messages.querySelectorAll('.msg');
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m.classList.contains('msg-user')) return;
    if (m.classList.contains('msg-rollback')) continue;
    if (m.classList.contains('msg-assistant') && !m.classList.contains('msg-working')) {
      m.classList.add('msg-working');
      return;
    }
  }
}

// On resume, the message log doesn't store the `msg-working` state we built
// up live. Reconstruct it: in each maximal run of consecutive assistant
// narrations (rollbacks ignored), mark all but the last as `msg-working`.
function markStaleWorkingMessages() {
  const all = messages.querySelectorAll('.msg');
  let lastNarrationIdx = -1;
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (m.classList.contains('msg-rollback')) continue;
    if (m.classList.contains('msg-assistant')) {
      if (lastNarrationIdx !== -1) all[lastNarrationIdx].classList.add('msg-working');
      lastNarrationIdx = i;
    } else if (m.classList.contains('msg-user')) {
      lastNarrationIdx = -1;
    }
  }
}

function appendMessage(role, content, seqOrOpts = ++seqCounter) {
  const opts = typeof seqOrOpts === 'object' && seqOrOpts !== null ? seqOrOpts : {};
  const seq = typeof seqOrOpts === 'number' ? seqOrOpts : (opts.seq ?? ++seqCounter);
  const queued = !!opts.queued;
  const subtype = opts.subtype;
  // While the session is `in_progress`, a new assistant narration demotes the
  // previous one of the same turn to `msg-working`, so only the latest stays
  // unmarked. The CSS layer is free to hide `.msg-working` if intermediate
  // narrations should be collapsed. Rollback messages are out-of-band.
  if (role === 'assistant' && !subtype && working) {
    demotePreviousTurnAssistant();
  }
  const el = document.createElement('div');
  el.className = `msg msg-${role}${queued ? ' msg-queued' : ''}${subtype ? ' msg-' + subtype : ''}`;
  if (subtype === 'rollback') {
    const header = document.createElement('div');
    header.className = 'msg-rollback-header';
    header.innerHTML = `${ROLLBACK_ICON_SVG}<span>Rollback</span>`;
    const body = document.createElement('div');
    body.className = 'msg-rollback-body';
    body.textContent = content;
    el.append(header, body);
  } else if (role === 'assistant') {
    el.innerHTML = renderInlineMarkdown(content);
  } else {
    el.textContent = content;
  }
  if (queued) {
    const badge = document.createElement('span');
    badge.className = 'queued-badge';
    badge.textContent = '⏳ waiting';
    el.appendChild(badge);
  }
  const stamp = formatMessageTime(opts.ts);
  if (stamp) {
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = stamp;
    el.appendChild(time);
  }
  placeIntoMessages(el, seq);
  // Refresh the working bubble's mirrored "last message" slot whenever a new
  // assistant narration lands during a turn — the bubble shows the latest one
  // centred between the progress bar and the remaining-time label.
  if (role === 'assistant' && !subtype && working) {
    updateWorkingProgress();
  }
}

function toolDetail(toolName, input) {
  if (!input) return null;
  const short = (s, n = 60) => s && s.length > n ? '…' + s.slice(-n) : s;
  switch (toolName) {
    case 'Read':  return short(input.file_path);
    case 'Write': return short(input.file_path);
    case 'Edit':  return short(input.file_path);
    case 'Bash':  return short(input.command, 80);
    case 'Grep':  return `"${input.pattern}"${input.path ? ' in ' + input.path : ''}`;
    case 'Glob':  return input.pattern;
    case 'SendMessage': {
      const to = input.to ? `→ ${input.to}` : '→ ?';
      const body = (input.content || '').replace(/\s+/g, ' ').trim();
      return body ? `${to}: ${body.length > 200 ? body.slice(0, 200) + '…' : body}` : to;
    }
    default:      return null;
  }
}

// Substring-match fallback in agentColor() means longer keys must come first
// (`simple-developer` before `developer`, `quality-reviewer` before `reviewer`).
const AGENT_COLORS = {
  'simple-developer': '#fb923c',
  'quality-reviewer': '#a78bfa',
  'code-reviewer':    '#a78bfa',
  'security-reviewer':'#f43f5e',
  'test-validator':   '#38bdf8',
  architect:          '#c084fc',
  orchestrator:       '#fbbf24',
  planner:            '#34d399',
  developer:          '#f97316',
  merger:             '#2dd4bf',
  documentator:       '#facc15',
  devops:             '#94a3b8',
};

function agentColor(label) {
  if (!label) return null;
  const key = label.toLowerCase();
  if (AGENT_COLORS[key]) return AGENT_COLORS[key];
  for (const [name, color] of Object.entries(AGENT_COLORS)) {
    if (key.includes(name)) return color;
  }
  return '#8b5cf6';
}

function appendDebug(toolName, input, agentCtx, seq = ++seqCounter) {
  const label = TOOL_LABELS[toolName] || `🔧 ${toolName}`;
  const el = document.createElement('div');
  el.className = 'msg msg-debug';

  const name = document.createElement('span');
  name.className = 'debug-tool';
  name.dataset.tool = toolName;
  const color = toolName === 'orchestrator' ? '#fbbf24' : agentColor(agentCtx);
  if (color) name.style.color = color;
  name.textContent = label;
  el.appendChild(name);

  // Agent context badge (which agent is doing this)
  if (agentCtx && toolName !== 'Task' && toolName !== 'TeamCreate' && toolName !== 'orchestrator') {
    const ctx = document.createElement('span');
    ctx.className = 'debug-context';
    ctx.textContent = agentCtx;
    ctx.style.color = agentColor(agentCtx) || '#8b5cf6';
    el.appendChild(ctx);
  }

  // Tool input detail (file path, command, etc.)
  const detail = toolDetail(toolName, input);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'debug-detail';
    d.textContent = detail;
    el.appendChild(d);
  }

  // Orchestrator raw text
  if (toolName === 'orchestrator' && input?.text) {
    const body = document.createElement('span');
    body.className = 'debug-agent-text';
    body.textContent = input.text;
    el.appendChild(body);
  }

  // Single agent: show its description
  if (toolName === 'Task' && input?.description) {
    const detail = document.createElement('span');
    detail.className = 'debug-detail';
    detail.textContent = input.description;
    el.appendChild(detail);
  }

  // Agent reply: show agent name + text output
  if (toolName === 'agent_output' && input?.text) {
    if (input.agent) {
      const who = document.createElement('span');
      who.className = 'debug-agent';
      who.textContent = input.agent;
      el.appendChild(who);
    }
    const body = document.createElement('span');
    body.className = 'debug-agent-text';
    body.textContent = input.text;
    el.appendChild(body);
  }

  // System init: show available tools
  if (toolName === 'system' && input?.tools?.length) {
    const detail = document.createElement('span');
    detail.className = 'debug-detail';
    detail.textContent = `Tools: ${input.tools.join(', ')}`;
    el.appendChild(detail);
  }

  // Result: show cost + turns
  if (toolName === 'result') {
    const detail = document.createElement('span');
    detail.className = 'debug-detail';
    const cost = input?.cost != null ? ` — $${input.cost.toFixed(2)}` : '';
    detail.textContent = `${input?.turns ?? '?'} turn(s)${cost}`;
    el.appendChild(detail);
  }

  // Agent team: list member names
  if (toolName === 'TeamCreate') {
    const members = Array.isArray(input?.agents)
      ? input.agents.map((a) => a.name || a).join(', ')
      : input?.description || '';
    if (members) {
      const detail = document.createElement('span');
      detail.className = 'debug-detail';
      detail.textContent = `Members: ${members}`;
      el.appendChild(detail);
    }
  }

  placeIntoMessages(el, seq);
}

function summarizeEvent(ev) {
  if (ev.type === 'system' && ev.subtype === 'task_started') {
    return `▶ task_started: ${ev.description || ev.task_id}`;
  }
  if (ev.type === 'system' && ev.subtype === 'task_progress') {
    const s = ev.usage ? ` (${ev.usage.tool_uses} tools, ${(ev.usage.duration_ms / 1000).toFixed(1)}s)` : '';
    return `⏳ task_progress: ${ev.description || ''}${s}`;
  }
  if (ev.type === 'system' && ev.subtype === 'task_complete') {
    return `✓ task_complete: ${ev.task_id}`;
  }
  if (ev.type === 'result') {
    const cost = ev.total_cost_usd != null ? ` — $${ev.total_cost_usd.toFixed(2)}` : '';
    return `✅ result: ${ev.num_turns} turn(s)${cost} [${ev.stop_reason}]`;
  }
  if (ev.type === 'assistant') {
    const blocks = ev.message?.content || [];
    return blocks.map((b) => {
      if (b.type === 'text') return `💬 "${b.text.slice(0, 120)}${b.text.length > 120 ? '…' : ''}"`;
      if (b.type === 'tool_use') {
        const inp = JSON.stringify(b.input).slice(0, 100);
        return `🔧 ${b.name}(${inp})`;
      }
      return null;
    }).filter(Boolean).join('\n');
  }
  if (ev.type === 'user') {
    const content = ev.message?.content || [];
    const results = content.filter((b) => b.type === 'tool_result');
    if (results.length) {
      return results.map((r) => {
        const text = Array.isArray(r.content)
          ? r.content.filter((c) => c.type === 'text').map((c) => c.text).join('').slice(0, 120)
          : (typeof r.content === 'string' ? r.content.slice(0, 120) : '');
        return `↩ tool_result: ${text}`;
      }).join('\n');
    }
    return null;
  }
  return null;
}

function appendRaw(event, seq = ++seqCounter) {
  const summary = summarizeEvent(event);
  if (!summary) return;
  const el = document.createElement('details');
  el.className = 'msg msg-debug msg-raw';
  const sum = document.createElement('summary');
  sum.textContent = summary;
  el.appendChild(sum);
  const full = document.createElement('pre');
  full.className = 'raw-full';
  full.textContent = JSON.stringify(event, null, 2);
  el.appendChild(full);
  placeIntoMessages(el, seq);
}

function renderDebugRaw(msg, seq = ++seqCounter) {
  const ev = msg.event;
  if (ev.type === 'rate_limit_event') return;
  if (ev.type === 'system' && ev.subtype === 'init') return;
  if (ev.type === 'assistant') {
    const blocks = ev.message?.content || [];
    if (blocks.length === 0 || blocks.every((b) => b.type === 'thinking')) return;
  }
  appendRaw(ev, seq);
}

stopBtn.addEventListener('click', () => {
  if (!working || stopBtn.disabled) return;
  connection.safeSend({ type: 'stop' });
  stopBtn.disabled = true; // re-enabled on next status flip
});

// Auto-resize textarea
const INPUT_MAX_HEIGHT = 120;
input.addEventListener('input', () => {
  input.style.height = 'auto';
  const sh = input.scrollHeight;
  input.style.height = Math.min(sh, INPUT_MAX_HEIGHT) + 'px';
  input.style.overflowY = sh > INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
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
  if (!content) return;
  if (!connection.safeSend({ content })) {
    appendMessage('assistant', 'Connection lost. Please reload the page.');
    return;
  }
  appendMessage('user', content, { queued: working });
  historyApi.refreshHistory();
  input.value = '';
  input.style.height = 'auto';
});

// Close the chat widget. The sessions sidebar stays visible — clicking a
// session (or ✚ New) re-opens the widget via switchSessionAndOpen.
toggle.addEventListener('click', closeDiscussion);

const SIDEBAR_COLLAPSED_KEY = 'chat-sidebar-collapsed';

function applySidebarCollapsed(collapsed) {
  historyPanel.classList.toggle('collapsed', collapsed);
  historyCollapseBtn.title = collapsed ? 'Expand panel' : 'Collapse panel';
  historyCollapseBtn.setAttribute('aria-label', historyCollapseBtn.title);
}

// Restore the user's previous choice across reloads.
applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');

const recentPopup = initRecentPopup({ renderHistoryItem: historyApi.renderHistoryItem });

historyCollapseBtn.addEventListener('click', () => {
  const collapsed = !historyPanel.classList.contains('collapsed');
  applySidebarCollapsed(collapsed);
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch {}
  // Refreshes are skipped while collapsed; pull the latest list on expand.
  if (!collapsed) {
    historyApi.refreshHistory();
    recentPopup.closeRecentPopup();
  }
});

// Debug toggle
debugBtn.addEventListener('click', () => {
  debugMode = !debugMode;
  debugBtn.classList.toggle('debug-active', debugMode);
  widget.classList.toggle('debug-active', debugMode);
  debugBtn.title = debugMode ? 'Debug ON' : 'Debug OFF';
  if (debugMode) {
    for (const entry of debugEventBuffer) {
      if (entry.msg.type === 'debug') {
        appendDebug(entry.msg.tool, entry.msg.input, entry.msg.agent, entry.seq);
      } else if (entry.msg.type === 'debug_raw') {
        renderDebugRaw(entry.msg, entry.seq);
      }
    }
  } else {
    messages.querySelectorAll('.msg-debug').forEach((el) => el.remove());
  }
});

const statsRefresh = initStatsRefresh({
  getSessionId: () => display.getSessionId(),
  isStatsMode: () => statsMode,
  panel: statsPanelBody,
});

async function enterStatsMode() {
  if (!display.getSessionId()) return;
  statsMode = true;
  statsPanel.hidden = false;
  statsBtn.classList.add('stats-active');
  statsBtn.title = 'Hide session stats';

  statsPanelBody.replaceChildren(el('div', { className: 'stats-loading' }, 'Loading stats…'));
  try {
    const res = await fetch(`/api/stats?sessionId=${encodeURIComponent(display.getSessionId())}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderStatsPanel(statsPanelBody, data);
    statsRefresh.markRefreshed();
  } catch (err) {
    const retry = el('button', { id: 'stats-retry-btn', onclick: enterStatsMode }, 'Retry');
    const back  = el('button', { id: 'stats-back-btn',  onclick: exitStatsMode  }, '← Close');
    const label = el('div', null, el('strong', null, 'Failed to load stats:'), ' ', String(err.message));
    statsPanelBody.replaceChildren(el('div', { className: 'stats-error' }, label, retry, back));
  }
}

function exitStatsMode() {
  statsMode = false;
  statsPanel.hidden = true;
  statsPanelBody.replaceChildren();
  statsBtn.classList.remove('stats-active');
  statsBtn.title = 'Session stats';
  statsRefresh.clearPending();
}

statsBtn.addEventListener('click', () => {
  if (statsMode) exitStatsMode(); else enterStatsMode();
});
statsCloseBtn.addEventListener('click', exitStatsMode);

// ── Mode toggle (Demo ↔ Full / Supabase) ──────────────────────
const modeToggleBtn = document.getElementById('mode-toggle');
let modePollingTimer = null;

function updateModeBtn(mode, supabaseReady) {
  const label = modeToggleBtn.querySelector('.mode-toggle-label');
  modeToggleBtn.dataset.mode = mode;
  if (mode === 'full') {
    if (label) label.textContent = supabaseReady ? 'Real data' : 'Real data ↻';
    modeToggleBtn.classList.toggle('mode-full', true);
    modeToggleBtn.classList.toggle('mode-starting', !supabaseReady);
    modeToggleBtn.title = supabaseReady
      ? 'Using your real database — click to switch to demo'
      : 'Connecting to your database… click to switch back to demo';
    if (!supabaseReady && !modePollingTimer) {
      modePollingTimer = setInterval(pollMode, 4000);
    } else if (supabaseReady && modePollingTimer) {
      clearInterval(modePollingTimer);
      modePollingTimer = null;
    }
  } else {
    if (label) label.textContent = 'Demo';
    modeToggleBtn.classList.remove('mode-full', 'mode-starting');
    modeToggleBtn.title = 'Using sample data — click to switch to your real database';
    if (modePollingTimer) { clearInterval(modePollingTimer); modePollingTimer = null; }
  }
}

async function pollMode() {
  try {
    const res = await fetch('/api/mode');
    if (!res.ok) return;
    const { mode, supabaseReady } = await res.json();
    updateModeBtn(mode, supabaseReady);
  } catch {}
}

modeToggleBtn.addEventListener('click', async () => {
  const currentMode = modeToggleBtn.dataset.mode || 'demo';
  const nextMode = currentMode === 'demo' ? 'full' : 'demo';
  updateModeBtn(nextMode, false);
  try {
    const res = await fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: nextMode }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // App.tsx is already swapped server-side — reload the CRM iframe now
    const frame = document.getElementById('crm-frame');
    if (frame) frame.src = frame.src;
    await pollMode();
  } catch {
    await pollMode();
  }
});

pollMode();
