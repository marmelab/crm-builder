// Drives the Deploy button + Configure/Progress modal.
//
// Server contract:
//   GET  /api/deploy/status     → { configured, projectRef, ..., running, tail }
//   GET  /api/deploy/events      → SSE stream (see below)
//   POST /api/deploy/configure  → 200 with same shape  | 400 { errors }
//   POST /api/deploy/run        → 202 { deployId }     | 409 { error }  | 412 { error: 'not_configured' }
//
// Live progress rides a dedicated SSE channel (NOT the chat WebSocket): deploy
// is cross-session global state and the modal lives in the always-visible
// sidebar, so it must stream even with no chat session open. EventSource
// auto-reconnects; the server replays a snapshot on each (re)connect.
//
// SSE events (JSON in `data:`):
//   deploy_snapshot { running, deployId, tail, ok, exitCode, durationMs, ... }  (on connect)
//   deploy_started  { deployId, startedAt }
//   deploy_log      { deployId, stream, line }
//   deploy_done     { deployId, ok, exitCode, durationMs, finishedAt }

import { openConfirmModal } from '../sessions/new_session_modal.js';

let state = {
  configured: false,
  running: false,
  expectedSecrets: [],
  configuredSecrets: [],
};

let elements = null;

// Top-level secret inputs. Never prefilled; on edit, a blank one keeps the
// stored value (the server merges blanks against the existing config).
const SECRET_FIELDS = ['anonKey', 'serviceRoleKey', 'dbPassword', 'accessToken'];
// Original placeholders for the secret inputs, captured once so we can restore
// them when showing the first-time configure form (vs the edit form).
let originalPlaceholders = {};

function $(sel) { return document.querySelector(sel); }

function refreshButtonLabel() {
  if (!elements?.btn) return;
  const label = elements.btnLabel;
  if (state.running) {
    elements.btn.classList.add('deploy-btn-running');
    if (label) label.textContent = 'Deploying…';
    elements.btn.title = 'A deploy is in progress';
  } else {
    elements.btn.classList.remove('deploy-btn-running');
    if (label) label.textContent = state.configured ? 'Deploy' : 'Configure Supabase';
    elements.btn.title = state.configured ? 'Deploy to Supabase' : 'Configure Supabase';
  }
  // The Edit affordance only makes sense once configured and while idle.
  if (elements.editBtn) elements.editBtn.hidden = !(state.configured && !state.running);
  // Mid-deploy the modal is non-dismissable (see close handlers) — hide the ✕
  // so it doesn't look clickable while it's inert.
  if (elements.modalClose) elements.modalClose.hidden = state.running;
  refreshDashboardLink();
}

// Point the "Open Supabase dashboard" link at the configured project, shown
// only once a projectRef is known.
function refreshDashboardLink() {
  const link = elements?.dashboardLink;
  if (!link) return;
  if (state.configured && state.projectRef) {
    link.href = `https://supabase.com/dashboard/project/${state.projectRef}`;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

// Prefill the configure form for the current state. Non-secret fields are
// shown (they're not sensitive); secret fields stay blank — on edit they get a
// "leave blank to keep" placeholder and lose their `required` flag, on first
// configure they keep their original placeholder and stay required.
function prefillForm() {
  const form = elements.form;
  if (!form) return;
  const setVal = (name, val) => {
    const el = form.querySelector(`input[name="${name}"]`);
    if (el) el.value = val ?? '';
  };
  setVal('projectRef', state.projectRef);
  setVal('supabaseUrl', state.supabaseUrl);
  for (const name of SECRET_FIELDS) {
    const el = form.querySelector(`input[name="${name}"]`);
    if (!el) continue;
    el.value = '';
    if (state.configured) {
      el.required = false;
      el.placeholder = '(configured — leave blank to keep)';
    } else {
      el.required = true;
      el.placeholder = originalPlaceholders[name] ?? '';
    }
  }
  if (elements.title) {
    elements.title.textContent = state.configured ? 'Edit Supabase configuration' : 'Configure Supabase';
  }
}

function showView(name) {
  for (const view of elements.modal.querySelectorAll('.deploy-view')) {
    const match = view.classList.contains(`deploy-view-${name}`);
    view.hidden = !match;
  }
}

function openModal() {
  elements.modal.hidden = false;
  // Focus the first input when the configure view is showing.
  setTimeout(() => {
    const first = elements.modal.querySelector('.deploy-view:not([hidden]) input');
    first?.focus();
  }, 0);
}

function closeModal() {
  elements.modal.hidden = true;
  showView('configure');
  elements.errors.hidden = true;
  elements.errors.textContent = '';
}

function buildSecretInputs() {
  const fs = elements.modal.querySelector('[data-secrets-fieldset]');
  if (!fs) return;
  // Wipe any previously-rendered inputs (keep <legend> + the hint <p>).
  for (const node of [...fs.querySelectorAll('label')]) node.remove();
  for (const key of state.expectedSecrets) {
    const label = document.createElement('label');
    label.className = 'deploy-field';
    const span = document.createElement('span');
    span.className = 'deploy-field-label';
    span.textContent = key;
    const input = document.createElement('input');
    input.type = 'password';
    input.name = `functionSecrets.${key}`;
    input.spellcheck = false;
    input.autocomplete = 'off';
    if (state.configuredSecrets?.includes(key)) {
      input.placeholder = '(configured — leave blank to keep)';
    }
    label.appendChild(span);
    label.appendChild(input);
    fs.appendChild(label);
  }
}

// Merge incoming status into local state — fields absent from `status` keep
// their previous value. Necessary because the WS `init` payload only carries
// a minimal runtime snapshot (no expectedSecrets, no projectRef), whereas the
// REST /api/deploy/status response is the full picture.
function applyStatus(status) {
  if (!status) return;
  const next = { ...state };
  const passthrough = [
    'configured', 'running', 'expectedSecrets', 'configuredSecrets',
    'projectRef', 'supabaseUrl', 'lastDeployAt',
    'deployId', 'ok', 'exitCode', 'durationMs',
  ];
  for (const k of passthrough) {
    if (k in status) next[k] = status[k];
  }
  state = next;
  refreshButtonLabel();
  buildSecretInputs();
  // If a deploy is running on the backend, rehydrate the progress view.
  if (state.running && Array.isArray(status.tail)) {
    if (elements.title) elements.title.textContent = 'Deploy to Supabase';
    showView('progress');
    elements.log.textContent = status.tail.map((f) => f.line).join('\n');
    elements.progressStatus.textContent = 'Deploying…';
    elements.progressClose.disabled = true;
  }
  // If a deploy just finished and the modal was open in progress view, leave it.
  if (!state.running && status.deployId && elements.modal && !elements.modal.hidden) {
    const inProgressView = !elements.modal.querySelector('.deploy-view-progress[hidden]');
    if (inProgressView) {
      paintTerminalStatus(status.ok, status.durationMs, status.exitCode);
    }
  }
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/deploy/status');
    if (!res.ok) return;
    const data = await res.json();
    applyStatus(data);
  } catch (err) {
    console.warn('[deploy] status fetch failed:', err);
  }
}

function collectFormConfig(form) {
  // FormData would also pick up Cancel-button name= values; iterate inputs explicitly.
  const fd = {};
  const functionSecrets = {};
  for (const input of form.querySelectorAll('input')) {
    const name = input.name;
    if (!name) continue;
    const val = input.value;
    if (name.startsWith('functionSecrets.')) {
      const k = name.slice('functionSecrets.'.length);
      if (val) functionSecrets[k] = val;
    } else {
      fd[name] = val;
    }
  }
  if (Object.keys(functionSecrets).length) fd.functionSecrets = functionSecrets;
  return fd;
}

async function submitConfigure(form) {
  elements.errors.hidden = true;
  elements.errors.textContent = '';
  const body = collectFormConfig(form);
  const res = await fetch('/api/deploy/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const errs = data.errors?.length ? data.errors.join(' · ') : (data.message || `HTTP ${res.status}`);
    elements.errors.textContent = `Configuration error: ${errs}`;
    elements.errors.hidden = false;
    return false;
  }
  const status = await res.json();
  applyStatus(status);
  return true;
}

function paintTerminalStatus(ok, durationMs, exitCode) {
  const seconds = Math.max(1, Math.round((durationMs || 0) / 1000));
  if (ok) {
    elements.progressStatus.textContent = `✓ Deploy succeeded in ${seconds}s`;
    elements.progressStatus.className = 'deploy-progress-status deploy-ok';
  } else {
    elements.progressStatus.textContent = `✗ Deploy failed (exit ${exitCode}) — see log for details`;
    elements.progressStatus.className = 'deploy-progress-status deploy-fail';
  }
  elements.progressClose.disabled = false;
}

async function triggerDeploy() {
  // Reset progress view before kicking off — old tail must not stay on screen.
  elements.log.textContent = '';
  elements.progressStatus.textContent = 'Deploying…';
  elements.progressStatus.className = 'deploy-progress-status';
  elements.progressClose.disabled = true;
  if (elements.title) elements.title.textContent = 'Deploy to Supabase';
  showView('progress');
  openModal();

  const res = await fetch('/api/deploy/run', { method: 'POST' });
  if (res.status === 412) {
    // Race: somehow lost config between status check and click. Bounce to configure.
    elements.errors.textContent = 'Supabase is not configured yet — fill in the form first.';
    elements.errors.hidden = false;
    showView('configure');
    return;
  }
  if (res.status === 409) {
    // Backend already running — applyStatus on next event will hydrate tail.
    return;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    elements.progressStatus.textContent = `✗ Failed to start deploy: ${data.message || res.status}`;
    elements.progressStatus.className = 'deploy-progress-status deploy-fail';
    elements.progressClose.disabled = false;
  }
}

function onDeployStarted(msg) {
  state.running = true;
  state.deployId = msg.deployId;
  refreshButtonLabel();
  if (!elements.modal.hidden) {
    elements.log.textContent = '';
    elements.progressStatus.textContent = 'Deploying…';
    elements.progressStatus.className = 'deploy-progress-status';
    elements.progressClose.disabled = true;
    if (elements.title) elements.title.textContent = 'Deploy to Supabase';
    showView('progress');
  }
}

function onDeployLog(msg) {
  if (!elements?.log) return;
  // Append regardless of whether the modal is open right now — when the user
  // re-opens it, all lines so far are already there.
  const prev = elements.log.textContent;
  elements.log.textContent = prev ? prev + '\n' + msg.line : msg.line;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function onDeployDone(msg) {
  state.running = false;
  refreshButtonLabel();
  paintTerminalStatus(msg.ok, msg.durationMs, msg.exitCode);
  // Re-fetch the public status to pick up lastDeployAt.
  fetchStatus();
}

export function initDeploy() {
  elements = {
    btn: $('#deploy-btn'),
    btnLabel: document.querySelector('#deploy-btn .deploy-btn-label'),
    editBtn: $('#deploy-edit-btn'),
    dashboardLink: $('#deploy-dashboard-btn'),
    modal: $('#deploy-modal'),
  };
  if (!elements.btn || !elements.modal) return null;
  elements.title = elements.modal.querySelector('#deploy-modal-title');
  elements.form = elements.modal.querySelector('.deploy-form');
  elements.errors = elements.modal.querySelector('.deploy-form-errors');
  elements.log = elements.modal.querySelector('.deploy-progress-log');
  elements.progressStatus = elements.modal.querySelector('.deploy-progress-status');
  elements.progressClose = elements.modal.querySelector('.deploy-progress-close');
  elements.modalClose = elements.modal.querySelector('.deploy-modal-close');

  // Stash the secret inputs' original placeholders so prefillForm can restore
  // them for the first-time configure view.
  for (const name of SECRET_FIELDS) {
    const el = elements.form?.querySelector(`input[name="${name}"]`);
    if (el) originalPlaceholders[name] = el.placeholder;
  }

  elements.btn.addEventListener('click', async () => {
    if (state.running) {
      // Show the in-flight progress, do not start a second deploy.
      showView('progress');
      openModal();
      return;
    }
    if (state.configured) {
      // Don't deploy on the first click — a deploy pushes migrations to the
      // live remote DB and can't be undone. Confirm first (same modal the
      // equally-destructive rollback action uses).
      const ok = await openConfirmModal({
        title: 'Deploy to Supabase?',
        body: `This pushes your current CRM to the live Supabase project ${state.projectRef || ''}: pending database migrations are applied to the remote database and the edge functions are redeployed. Schema changes to a live database can't be automatically undone.`,
        confirmLabel: 'Deploy',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
      triggerDeploy();
    } else {
      showView('configure');
      prefillForm();
      openModal();
    }
  });

  // Edit: re-open the (prefilled) configure form on an already-configured setup.
  elements.editBtn?.addEventListener('click', () => {
    if (state.running) return;
    elements.errors.hidden = true;
    elements.errors.textContent = '';
    showView('configure');
    prefillForm();
    openModal();
  });

  // The ✕ and the backdrop dismiss the modal — but not mid-deploy: a running
  // deploy can't be aborted, so closing the window would only hide live
  // progress with no way to follow it. The progress "Close" button is already
  // disabled while running; the form Cancel only shows in the configure view.
  const closeIfIdle = () => { if (!state.running) closeModal(); };
  elements.modal.querySelector('.deploy-modal-backdrop')?.addEventListener('click', closeIfIdle);
  elements.modal.querySelector('.deploy-modal-close')?.addEventListener('click', closeIfIdle);
  elements.modal.querySelector('.deploy-modal-cancel')?.addEventListener('click', closeModal);
  elements.modal.querySelector('.deploy-progress-close')?.addEventListener('click', closeModal);

  elements.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = elements.form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const ok = await submitConfigure(elements.form);
      if (ok) closeModal();
    } finally {
      submitBtn.disabled = false;
    }
  });

  fetchStatus();
  connectEvents();

  return { onDeployStarted, onDeployLog, onDeployDone, applyStatus, refresh: fetchStatus };
}

// Subscribe to the deploy SSE stream. EventSource reconnects on its own after a
// drop; the server replays a `deploy_snapshot` on every (re)connect so a tab
// that joins mid-deploy paints the current tail and keeps streaming from there.
function connectEvents() {
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/deploy/events');
  es.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.type) {
      case 'deploy_snapshot': applyStatus(msg); break;
      case 'deploy_started':  onDeployStarted(msg); break;
      case 'deploy_log':      onDeployLog(msg); break;
      case 'deploy_done':     onDeployDone(msg); break;
    }
  });
  // Errors are transient — EventSource handles reconnection. Nothing to do.
  es.addEventListener('error', () => {});
}
