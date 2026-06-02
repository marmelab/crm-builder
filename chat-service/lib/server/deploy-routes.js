import { mkdir, mkdtemp, readFile, writeFile, rename, chmod, stat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EXPECTED_SECRETS } from './deploy-secrets-manifest.js';

export const DEPLOY_CONFIG_PATH =
  process.env.DEPLOY_CONFIG_PATH || '/var/lib/atomic-crm/supabase-deploy/config.json';
// The Supabase CLI binary (on PATH in the image) and the CRM source dir it
// operates on. Overridable in tests to point at a fake CLI.
export const SUPABASE_BIN = process.env.SUPABASE_BIN || 'supabase';
export const DEPLOY_APP_DIR = process.env.DEPLOY_APP_DIR || process.env.APP_DIR || '/app';

const PROJECT_REF_RE = /^[a-z0-9]{20}$/;
const SUPABASE_URL_RE = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/;
const TAIL_CAP = 200;

// Secret fields. On an EDIT (a config already exists) a blank value means
// "keep the stored one" — so they're only required on the very first configure.
const SECRET_KEYS = ['anonKey', 'serviceRoleKey', 'dbPassword', 'accessToken'];

// In-memory snapshot of the current/last deploy. Reset on process restart —
// fine for v1 because the script is idempotent: a rerun finishes the work.
export const deployState = {
  running: false,
  deployId: null,
  startedAt: null,
  finishedAt: null,
  ok: null,
  exitCode: null,
  durationMs: null,
  tail: [],
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 100_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// String-replace live secret values with '***' before they hit a log or a
// broadcast. Empty/missing values are skipped — replacing '' would corrupt
// every line. Secrets ≥ 4 chars only, to avoid masking common short words
// that happen to match a token fragment.
export function redactSecrets(line, config) {
  if (!line || typeof line !== 'string' || !config) return line;
  const candidates = [
    config.accessToken,
    config.dbPassword,
    config.serviceRoleKey,
    config.anonKey,
    ...Object.values(config.functionSecrets || {}),
  ];
  let out = line;
  for (const v of candidates) {
    if (typeof v !== 'string' || v.length < 4) continue;
    // Split-join avoids needing to escape regex metacharacters in the secret.
    out = out.split(v).join('***');
  }
  return out;
}

export async function loadConfig() {
  try {
    const raw = await readFile(DEPLOY_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// `isEdit` (a config already exists) relaxes the secret fields: blank means
// "keep the stored value", so only projectRef + supabaseUrl stay mandatory.
function validateConfigBody(body, isEdit) {
  const errors = [];
  // Project ref + URL are always required — the form prefills them on edit.
  for (const k of ['projectRef', 'supabaseUrl']) {
    if (typeof body?.[k] !== 'string' || !body[k].trim()) errors.push(`${k} is required`);
  }
  // Secrets are required on first configure; on edit a blank keeps the old one.
  for (const k of SECRET_KEYS) {
    const provided = typeof body?.[k] === 'string' && body[k].trim() !== '';
    if (!provided && !isEdit) errors.push(`${k} is required`);
  }
  if (body?.projectRef && !PROJECT_REF_RE.test(body.projectRef)) {
    errors.push('projectRef must be 20 lowercase alphanumeric chars');
  }
  if (body?.supabaseUrl && !SUPABASE_URL_RE.test(body.supabaseUrl)) {
    errors.push('supabaseUrl must look like https://<project-ref>.supabase.co');
  }
  // Prefix check only when a (new) token is actually supplied.
  if (typeof body?.accessToken === 'string' && body.accessToken.trim() && !body.accessToken.trim().startsWith('sbp_')) {
    errors.push("accessToken must be a Supabase personal access token (starts with 'sbp_')");
  }
  if (body?.functionSecrets !== undefined) {
    if (typeof body.functionSecrets !== 'object' || Array.isArray(body.functionSecrets)) {
      errors.push('functionSecrets must be an object of KEY → value strings');
    } else {
      for (const [k, v] of Object.entries(body.functionSecrets)) {
        if (typeof v !== 'string') errors.push(`functionSecrets.${k} must be a string`);
      }
    }
  }
  return errors;
}

// Atomic write: tmp + rename — readers either see the old file or the new one,
// never a half-written one. chmod 600 BEFORE rename so the final file is never
// briefly world-readable.
async function writeConfigAtomic(config) {
  await mkdir(dirname(DEPLOY_CONFIG_PATH), { recursive: true });
  const tmp = `${DEPLOY_CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await chmod(tmp, 0o600);
  await rename(tmp, DEPLOY_CONFIG_PATH);
}

function publicStatus(config) {
  return {
    configured: !!config,
    projectRef: config?.projectRef || null,
    supabaseUrl: config?.supabaseUrl || null,
    lastDeployAt: config?.lastDeployAt || null,
    expectedSecrets: EXPECTED_SECRETS,
    configuredSecrets: config ? Object.keys(config.functionSecrets || {}) : [],
    running: deployState.running,
    deployId: deployState.deployId,
    startedAt: deployState.startedAt,
    finishedAt: deployState.finishedAt,
    ok: deployState.ok,
    exitCode: deployState.exitCode,
    durationMs: deployState.durationMs,
    tail: deployState.tail,
  };
}

export async function handleGetDeployStatus(req, res) {
  try {
    const config = await loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(publicStatus(config)));
  } catch (err) {
    console.error('[deploy] status failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'status_failed', message: err.message }));
  }
}

export async function handleConfigureDeploy(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch { res.writeHead(400); res.end('Bad request'); return; }

  // Load the existing config up-front: it drives edit-mode validation (blank
  // secrets allowed) and supplies the values we keep when a field is left blank.
  const prev = await loadConfig().catch(() => null);

  const errors = validateConfigBody(body, !!prev);
  if (errors.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_config', errors }));
    return;
  }

  // Whitelist fields — never persist anything else the client might send.
  // Start function secrets from the previous set so a blank input keeps the
  // stored value; only non-empty inputs overwrite.
  const next = {
    projectRef: body.projectRef.trim(),
    supabaseUrl: body.supabaseUrl.trim(),
    functionSecrets: { ...(prev?.functionSecrets || {}) },
    updatedAt: new Date().toISOString(),
  };
  // Secrets: a non-empty value overwrites; a blank one keeps the stored value.
  for (const k of SECRET_KEYS) {
    const raw = body[k];
    const provided = typeof raw === 'string' && raw.trim() !== '';
    // dbPassword is intentionally not trimmed; the rest are.
    if (provided) next[k] = k === 'dbPassword' ? raw : raw.trim();
    else next[k] = prev?.[k];
  }
  if (body.functionSecrets) {
    for (const key of EXPECTED_SECRETS) {
      const v = body.functionSecrets[key];
      if (typeof v === 'string' && v.length > 0) next.functionSecrets[key] = v;
    }
  }
  // Preserve lastDeployAt from the previous config so configure-after-deploy
  // doesn't lose the timestamp.
  if (prev?.lastDeployAt) next.lastDeployAt = prev.lastDeployAt;

  try {
    await writeConfigAtomic(next);
  } catch (err) {
    console.error('[deploy] configure write failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'write_failed', message: err.message }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(publicStatus(next)));
}

// Connected Server-Sent Events streams (one per open browser tab). Deploy is a
// global, cross-session action — its progress rides a dedicated SSE channel
// (GET /api/deploy/events), independent of the chat WebSocket which only exists
// while a chat session is open. The modal lives in the always-visible sidebar,
// so a user can deploy with no session open and still needs live progress.
const sseClients = new Set();

// Serialize one event onto an SSE stream. Wrapped in try/catch because a
// half-closed socket throws on write; we drop it from the set on the next
// 'close' event anyway.
function sseWrite(res, payload) {
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* dead socket */ }
}

// GET /api/deploy/events — open SSE stream. On connect we replay the current
// snapshot so a (re)connecting tab rehydrates an in-flight or just-finished
// deploy mid-progress. EventSource auto-reconnects on drop, so each reconnect
// gets a fresh snapshot for free.
export function handleDeployEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeat proxy buffering (e.g. nginx) so frames flush in real time.
    'X-Accel-Buffering': 'no',
  });
  sseClients.add(res);
  sseWrite(res, { type: 'deploy_snapshot', ...deploySnapshot() });
  // Comment-only heartbeat keeps intermediaries from reaping an idle stream.
  const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* dead */ } }, 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

// Fan a deploy event out to every connected SSE stream, irrespective of session.
function broadcastDeploy(payload) {
  for (const res of sseClients) sseWrite(res, payload);
}

function pushTail(line) {
  deployState.tail.push(line);
  if (deployState.tail.length > TAIL_CAP) {
    deployState.tail.splice(0, deployState.tail.length - TAIL_CAP);
  }
}

// A step marker (▶ / ✓ / ✗) — the high-level progress the user actually wants
// to see. Goes to three places: the chat-service stdout (so a deploy is
// traceable in `docker logs`), the in-memory tail snapshot, and every connected
// WS (the modal's stream component). Deliberately NOT persisted to a session
// log.jsonl — a deploy is a global action, not a chat message (see broadcastDeploy).
function emitStep(line, deployId) {
  console.log(`[deploy:${deployId}] ${line}`);
  const frame = { type: 'deploy_log', deployId, stream: 'stdout', line };
  pushTail(frame);
  broadcastDeploy(frame);
}

// One (already-redacted) raw line from the Supabase CLI. It is intentionally
// NOT broadcast to the frontend and NOT kept in the tail — the modal shows
// steps only. The full firehose is mirrored to the chat-service stderr so a
// failed deploy stays fully diagnosable from `docker logs`.
function logSupabaseLine(line, deployId) {
  console.error(`[deploy:${deployId}] ${line}`);
}

// Matches a CR, an LF, or a CRLF as a single line boundary.
const LINE_BREAK_RE = /\r\n|\r|\n/;

// Wire one of the spawn's pipes to: redact → sink. Buffers partial lines across
// chunk boundaries so we never hand a half line to `redactSecrets` (a secret
// straddling a chunk would otherwise slip through). Breaks on CR as well as LF:
// progress UIs (e.g. `supabase db push`) repaint a single line with a bare `\r`
// and no newline — splitting only on `\n` would hold all of that in the buffer
// until the process exits.
function pipeStream(stream, config, deployId, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let m;
    while ((m = LINE_BREAK_RE.exec(buf)) !== null) {
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      onLine(redactSecrets(raw, config), deployId);
    }
  });
  stream.on('end', () => {
    if (buf.length) {
      onLine(redactSecrets(buf, config), deployId);
      buf = '';
    }
  });
}

function newDeployId() {
  // Process-local counter is enough: we only allow one deploy at a time, and
  // the tail buffer clears on each new run — clients use the latest deployId
  // they see. Avoids needing crypto.
  newDeployId.counter = (newDeployId.counter || 0) + 1;
  return `deploy-${Date.now()}-${newDeployId.counter}`;
}

// Single-quote-escape one argv token for a POSIX `sh -c` command string: wrap
// in single quotes, and rewrite any embedded quote as the '\'' idiom. Bullet-
// proof against shell metacharacters, so even a db password full of $, `, " or
// spaces can neither break out of the string nor inject — there is no shell-
// injection surface despite building a command string.
function shQuote(token) {
  return `'${String(token).split("'").join(`'\\''`)}'`;
}

// Run one Supabase CLI subcommand. Its (verbose) output is redacted and mirrored
// to the chat-service stderr for diagnosis only — the user-facing step markers
// are emitted separately by runDeploy, so the modal never sees this firehose.
//
// The CLI is wrapped in util-linux `script`, which runs it under a real PTY.
// Without that, the Supabase CLI (a Go binary that checks isatty()) treats the
// pipe as non-interactive and withholds its progress output entirely, leaving
// the console empty. `script` flags: -q silences its banner, -f flushes after
// every write (real-time), -e exits with the child's status so phase failures
// still surface a real exit code; /dev/null discards the typescript capture.
// A PTY is a single stream, so the CLI's stdout+stderr arrive merged on script's
// stdout. The argv is shQuote-escaped, so no injection despite the command being
// a string. Resolves on exit 0; rejects (with the exit code attached) otherwise,
// so the orchestrator stops at the first failing phase. Both secrets go through
// the environment (SUPABASE_ACCESS_TOKEN / SUPABASE_DB_PASSWORD) rather than argv,
// so neither is visible in `ps` on the host the Docker daemon runs on.
function runSupabasePhase(args, config, deployId) {
  return new Promise((resolve, reject) => {
    const cmd = [SUPABASE_BIN, ...args].map(shQuote).join(' ');
    let child;
    try {
      child = spawn('script', ['-qfe', '-c', cmd, '/dev/null'], {
        cwd: DEPLOY_APP_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SUPABASE_ACCESS_TOKEN: config.accessToken,
          // The CLI reads the db password from this env var, so `link`/`db push`
          // need no --password flag — keeps it out of argv (and thus `ps`).
          ...(config.dbPassword ? { SUPABASE_DB_PASSWORD: config.dbPassword } : {}),
        },
      });
    } catch (err) {
      reject(err);
      return;
    }
    pipeStream(child.stdout, config, deployId, logSupabaseLine);
    pipeStream(child.stderr, config, deployId, logSupabaseLine);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`supabase ${args[0]} exited with code ${code}`), { code }));
    });
  });
}

// `supabase secrets set --env-file` reads KEY=VALUE lines. Writing them to a
// mode-600 tempfile (rather than argv) keeps the values out of `ps`/history.
// Returns the file path; caller is responsible for deleting it.
async function writeSecretsEnvFile(secrets) {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-secrets-'));
  const file = join(dir, 'secrets.env');
  const body = Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await writeFile(file, body, { mode: 0o600 });
  return { file, dir };
}

// Push the current CRM state to a remote Supabase project. Each phase is
// idempotent (rerunnable on transient failure), mirroring the former
// deploy-remote.sh — now in-process so it streams line-by-line to the modal
// without a bash layer in between.
export async function runDeploy(config, deployId) {
  for (const k of ['projectRef', 'dbPassword', 'accessToken']) {
    if (!config?.[k]) throw new Error(`config missing required field: ${k}`);
  }
  const ref = config.projectRef;

  // The db password rides SUPABASE_DB_PASSWORD in the phase env (see
  // runSupabasePhase), so neither link nor db push needs a --password flag.
  emitStep(`▶ Linking project ${ref}`, deployId);
  await runSupabasePhase(['link', '--project-ref', ref], config, deployId);

  // --include-all promotes every not-yet-applied migration without the CLI
  // prompting for older ones. --yes auto-confirms the final "push these
  // migrations?" prompt: we run the CLI under `script` (a real PTY), so it sees
  // isatty() and would otherwise block forever waiting on a stdin we don't wire.
  emitStep('▶ Pushing migrations', deployId);
  await runSupabasePhase(['db', 'push', '--include-all', '--yes'], config, deployId);

  // No names → deploy every function under supabase/functions/. Re-deploying an
  // unchanged bundle is a no-op on the remote, so idempotency holds.
  //
  // --use-api bundles the functions server-side instead of spawning a local
  // Docker container. That matters because the chat-service runs *inside* the
  // atomic-crm container but talks to the host Docker daemon: a Docker-based
  // bundle would ask the daemon to mount `/app/supabase/functions/...`, a path
  // that only exists inside our container — on the host it's absent, so the
  // bundling container fails with "entrypoint path does not exist
  // (supabase/functions/<name>/index.ts)". Server-side bundling sidesteps the
  // bind-mount mismatch entirely (no Docker, no path translation).
  emitStep('▶ Deploying edge functions', deployId);
  await runSupabasePhase(['functions', 'deploy', '--project-ref', ref, '--use-api'], config, deployId);

  const secrets = config.functionSecrets || {};
  if (Object.keys(secrets).length) {
    emitStep('▶ Syncing function secrets', deployId);
    const { file, dir } = await writeSecretsEnvFile(secrets);
    try {
      await runSupabasePhase(['secrets', 'set', '--project-ref', ref, '--env-file', file], config, deployId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    emitStep('▶ No function secrets to sync', deployId);
  }

  emitStep('✓ Deploy complete', deployId);
}

export async function handleDeployRun(req, res) {
  if (deployState.running) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'deploy_in_progress', deployId: deployState.deployId }));
    return;
  }
  // Claim the slot synchronously, BEFORE the first await. `await loadConfig()`
  // yields the event loop, so two POSTs in the same tick would otherwise both
  // read running===false and both launch a deploy against the live project —
  // exactly what the 409 guard exists to prevent.
  deployState.running = true;

  const config = await loadConfig();
  if (!config) {
    deployState.running = false; // release the slot we optimistically claimed
    res.writeHead(412, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_configured' }));
    return;
  }

  const deployId = newDeployId();
  const startedAt = new Date().toISOString();
  deployState.deployId = deployId;
  deployState.startedAt = startedAt;
  deployState.finishedAt = null;
  deployState.ok = null;
  deployState.exitCode = null;
  deployState.durationMs = null;
  // New deploy → fresh tail. Clients that reconnect mid-run will see only
  // this deploy's output, not noise from a previous one.
  deployState.tail = [];

  console.log(`[deploy] started ${deployId} (project ${config.projectRef})`);
  broadcastDeploy({ type: 'deploy_started', deployId, startedAt });

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ deployId, startedAt }));

  const t0 = Date.now();

  // Run the phases in-process. A thrown phase (non-zero exit, or the CLI being
  // missing → ENOENT) rejects here and finalizes with a real exit code, so the
  // deploy can never hang with running=true.
  runDeploy(config, deployId)
    .then(() => finalize(config, deployId, t0, 0))
    .catch((err) => {
      const msg = err?.message || String(err);
      console.error('[deploy] failed:', msg);
      // A one-line failure step for the modal; the full CLI error is already on
      // the chat-service stderr (logSupabaseLine).
      emitStep(`✗ deploy error: ${msg}`, deployId);
      finalize(config, deployId, t0, typeof err?.code === 'number' ? err.code : 1, msg);
    });
}

async function finalize(config, deployId, t0, exitCode, errMessage) {
  const durationMs = Date.now() - t0;
  const ok = exitCode === 0;
  const finishedAt = new Date().toISOString();
  deployState.running = false;
  deployState.finishedAt = finishedAt;
  deployState.ok = ok;
  deployState.exitCode = exitCode;
  deployState.durationMs = durationMs;
  console.log(`[deploy] ${deployId} ${ok ? 'succeeded' : 'failed'} (exit ${exitCode}, ${durationMs}ms)`);

  if (ok) {
    // Stamp lastDeployAt on the config so the UI can show "last deploy 5 min ago".
    try {
      const fresh = await loadConfig();
      if (fresh) {
        fresh.lastDeployAt = finishedAt;
        await writeConfigAtomic(fresh);
      }
    } catch (err) {
      console.warn('[deploy] could not stamp lastDeployAt:', err.message);
    }
  }

  broadcastDeploy({
    type: 'deploy_done',
    deployId,
    ok,
    exitCode,
    durationMs,
    finishedAt,
    ...(errMessage ? { errMessage } : {}),
  });
}

// Snapshot for the WebSocket `init` payload — joiners can rehydrate any
// running or just-finished deploy mid-progress.
export function deploySnapshot() {
  return {
    running: deployState.running,
    deployId: deployState.deployId,
    startedAt: deployState.startedAt,
    finishedAt: deployState.finishedAt,
    ok: deployState.ok,
    exitCode: deployState.exitCode,
    durationMs: deployState.durationMs,
    tail: deployState.tail,
  };
}

// Test-only: reset state between unit tests. Not part of the public API.
export function _resetForTests() {
  deployState.running = false;
  deployState.deployId = null;
  deployState.startedAt = null;
  deployState.finishedAt = null;
  deployState.ok = null;
  deployState.exitCode = null;
  deployState.durationMs = null;
  deployState.tail = [];
  sseClients.clear();
}

// Utility for `await statConfig()` in tests — surfaces whether the file
// exists without exposing its contents.
export async function configExists() {
  try { await stat(DEPLOY_CONFIG_PATH); return true; }
  catch { return false; }
}
