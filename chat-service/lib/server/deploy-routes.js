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
// `npm run build` (tsc && vite build) and `wrangler deploy` for the optional
// Cloudflare frontend deploy. Both binaries live on PATH in the image;
// overridable in tests to point at fakes.
export const BUILD_BIN = process.env.BUILD_BIN || 'npm';
export const WRANGLER_BIN = process.env.WRANGLER_BIN || 'wrangler';
export const DEPLOY_APP_DIR = process.env.DEPLOY_APP_DIR || process.env.APP_DIR || '/app';
// The Supabase App.tsx variant baked into the image. A deploy MUST build the
// Supabase variant: the container may be running in demo (FakeRest) mode, whose
// src/App.tsx wires an in-browser fake data provider — building that would ship
// a non-functional app with no real backend. Overridable in tests.
export const APP_SUPABASE_VARIANT =
  process.env.APP_SUPABASE_VARIANT || '/app-variants/App.supabase.tsx';

const PROJECT_REF_RE = /^[a-z0-9]{20}$/;
// Cloudflare account IDs are 32 hex chars. Case-insensitive: the dashboard
// shows them lowercase but a pasted uppercase variant is still valid.
const CF_ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;
// Compatibility date baked into the generated wrangler config. A fixed past
// date keeps deploys deterministic; bump it when adopting newer Workers runtime
// semantics.
const WRANGLER_COMPAT_DATE = '2025-05-29';
const TAIL_CAP = 200;

// Secret fields. A blank value always means "keep the stored one" — partial
// saves let the user fill these in across several sittings (see
// validateConfigBody), so they are never strictly required at save time.
const SECRET_KEYS = ['anonKey', 'serviceRoleKey', 'dbPassword', 'accessToken'];

// The Supabase fields a deploy actually needs. The Supabase URL is intentionally
// NOT among them: it's always https://<projectRef>.supabase.co (see
// supabaseUrlFor), so the project ref alone determines it. Derived from
// SECRET_KEYS so the two lists can never drift apart.
const SUPABASE_REQUIRED = ['projectRef', ...SECRET_KEYS];

// The canonical Supabase URL for a project — always derivable from the ref, so we
// never store or trust a separate URL field that could disagree with it.
function supabaseUrlFor(config) {
  return `https://${config.projectRef}.supabase.co`;
}

// A config's Supabase half is deploy-ready once every required field is filled.
// A partial draft (some fields still blank) is a valid saved state but not runnable.
function isSupabaseComplete(config) {
  return !!config && SUPABASE_REQUIRED.every((k) => typeof config[k] === 'string' && config[k].length > 0);
}

// The Cloudflare half is ready once both the API token and the account ID exist.
function isCloudflareComplete(config) {
  return !!(config?.cloudflareApiToken && config?.cloudflareAccountId);
}

// A deploy needs BOTH targets: Supabase (backend) and Cloudflare (frontend).
function isDeployable(config) {
  return isSupabaseComplete(config) && isCloudflareComplete(config);
}

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
    config.cloudflareApiToken,
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

// Partial saves are allowed: the user fills the form across several sittings and
// can switch away whenever, so NO field is required at save time. We only reject
// values that are present but malformed — a blank field is always acceptable
// (the merge keeps any stored value). Whether the config is complete enough to
// deploy is a separate, run-time check (isSupabaseComplete / handleDeployRun).
function validateConfigBody(body) {
  const errors = [];
  if (body?.projectRef && !PROJECT_REF_RE.test(body.projectRef)) {
    errors.push('projectRef must be 20 lowercase alphanumeric chars');
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
  // Cloudflare (optional frontend target). Either field may be saved on its own
  // as a draft — the pairing is only enforced when a deploy is attempted (a lone
  // account ID or token leaves cloudflareConfigured false). The account ID is
  // non-secret and taken verbatim; the token follows the blank-keeps-stored rule.
  const cfAccountId = typeof body?.cloudflareAccountId === 'string' ? body.cloudflareAccountId.trim() : '';
  if (cfAccountId && !CF_ACCOUNT_ID_RE.test(cfAccountId)) {
    errors.push('cloudflareAccountId must be 32 hex chars');
  }
  const cfTokenProvided = typeof body?.cloudflareApiToken === 'string' && body.cloudflareApiToken.trim() !== '';
  if (cfTokenProvided && body.cloudflareApiToken.trim().length < 20) {
    errors.push('cloudflareApiToken looks too short to be a Cloudflare API token');
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
    // `configured` = a config file exists at all (drives the Edit-vs-Configure
    // title); `supabaseComplete` = every Supabase field is filled, i.e. the
    // backend half is deploy-ready. Partial drafts are configured but not complete.
    configured: !!config,
    supabaseComplete: isSupabaseComplete(config),
    projectRef: config?.projectRef || null,
    lastDeployAt: config?.lastDeployAt || null,
    // Cloudflare frontend target. The account ID is safe to echo (it's not a
    // secret and the form prefills it); the token is never returned, but we do
    // report whether one is stored so the form can show a "leave blank to keep"
    // hint even before the account ID lands (partial save).
    cloudflareConfigured: isCloudflareComplete(config),
    cloudflareAccountId: config?.cloudflareAccountId || null,
    cloudflareTokenStored: !!config?.cloudflareApiToken,
    expectedSecrets: EXPECTED_SECRETS,
    configuredSecrets: config ? Object.keys(config.functionSecrets || {}) : [],
    // Which top-level secret fields are stored (names only — never the values).
    // Lets the form show a "leave blank to keep" hint per field after a partial
    // save, instead of an all-or-nothing guess.
    configuredSecretFields: config ? SECRET_KEYS.filter((k) => typeof config[k] === 'string' && config[k].length > 0) : [],
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

  // Load the existing config up-front: it supplies the values we keep when a
  // field is left blank (the blank-keeps-stored merge below).
  const prev = await loadConfig().catch(() => null);

  const errors = validateConfigBody(body);
  if (errors.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_config', errors }));
    return;
  }

  // Whitelist fields — never persist anything else the client might send.
  // Start function secrets from the previous set so a blank input keeps the
  // stored value; only non-empty inputs overwrite. projectRef follows the same
  // blank-keeps-stored rule as the secrets: a partial save may omit it, and the
  // form prefills it on edit, so a blank (or absent) input means "leave what's
  // stored" — never crash on, or clear, a missing field. The Supabase URL is not
  // stored at all (it's derived from the ref at deploy time, see supabaseUrlFor).
  const next = {
    projectRef: (typeof body.projectRef === 'string' && body.projectRef.trim()) ? body.projectRef.trim() : prev?.projectRef,
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
  // Cloudflare (optional). Both fields follow the same blank-keeps-stored rule as
  // the Supabase secrets: a non-blank value overwrites, a blank one keeps the
  // stored value. So a partial save — a token entered before the account ID, or
  // an edit that only touches the Supabase tab — never silently drops a stored
  // Cloudflare credential. The account ID is normalised to lowercase: Cloudflare
  // canonicalises it that way, and an uppercase paste would otherwise be accepted
  // here only to fail at `wrangler deploy`, after the live DB is already migrated.
  const cfAccountId = typeof body.cloudflareAccountId === 'string' ? body.cloudflareAccountId.trim() : '';
  next.cloudflareAccountId = cfAccountId ? cfAccountId.toLowerCase() : prev?.cloudflareAccountId;
  const cfToken = typeof body.cloudflareApiToken === 'string' ? body.cloudflareApiToken.trim() : '';
  next.cloudflareApiToken = cfToken || prev?.cloudflareApiToken;
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

// One (already-redacted) raw line from a deploy phase's CLI (Supabase, vite
// build, or wrangler). It is intentionally NOT broadcast to the frontend and
// NOT kept in the tail — the modal shows steps only. The full firehose is
// mirrored to the chat-service stderr so a failed deploy stays fully
// diagnosable from `docker logs`.
function logPhaseLine(line, deployId) {
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

// Run one deploy phase as a child process. Its (verbose) output is redacted and
// mirrored to the chat-service stderr for diagnosis only — the user-facing step
// markers are emitted separately by runDeploy, so the modal never sees this
// firehose.
//
// The command is wrapped in util-linux `script`, which runs it under a real
// PTY. Without that, a CLI that checks isatty() (the Supabase Go binary,
// wrangler) treats the pipe as non-interactive and withholds its progress
// output entirely, leaving the console empty. `script` flags: -q silences its
// banner, -f flushes after every write (real-time), -e exits with the child's
// status so phase failures still surface a real exit code; /dev/null discards
// the typescript capture. A PTY is a single stream, so the child's
// stdout+stderr arrive merged on script's stdout. The argv is shQuote-escaped,
// so no injection despite the command being a string. Resolves on exit 0;
// rejects (with the exit code attached) otherwise, so the orchestrator stops at
// the first failing phase. Sensitive credentials go through `env` (never argv →
// never visible in `ps`).
function runCommandPhase({ argv, env, label, config, deployId, cwd = DEPLOY_APP_DIR }) {
  return new Promise((resolve, reject) => {
    const cmd = argv.map(shQuote).join(' ');
    let child;
    try {
      child = spawn('script', ['-qfe', '-c', cmd, '/dev/null'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
    } catch (err) {
      reject(err);
      return;
    }
    pipeStream(child.stdout, config, deployId, logPhaseLine);
    pipeStream(child.stderr, config, deployId, logPhaseLine);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`${label} exited with code ${code}`), { code }));
    });
  });
}

// Supabase phase: both the access token and the db password go through the
// environment (SUPABASE_ACCESS_TOKEN / SUPABASE_DB_PASSWORD) rather than argv,
// so neither is visible in `ps`. The CLI reads the db password from
// SUPABASE_DB_PASSWORD, so `link`/`db push` need no --password flag.
function runSupabasePhase(args, config, deployId) {
  return runCommandPhase({
    argv: [SUPABASE_BIN, ...args],
    env: {
      SUPABASE_ACCESS_TOKEN: config.accessToken,
      ...(config.dbPassword ? { SUPABASE_DB_PASSWORD: config.dbPassword } : {}),
    },
    label: `supabase ${args[0]}`,
    config,
    deployId,
  });
}

// Build env injected into `vite build` so the remote Supabase connection is
// baked into the static bundle. vite.config.ts only applies these when
// NODE_ENV === 'production' AND VITE_SUPABASE_URL is set. The URL is derived
// from the project ref (never a separately-stored field that could disagree).
// The CRM reads the publishable key from VITE_SB_PUBLISHABLE_KEY (not
// *_ANON_KEY); the stored `anonKey` is that public client key.
function buildEnv(config) {
  return {
    NODE_ENV: 'production',
    VITE_IS_DEMO: 'false',
    VITE_SUPABASE_URL: supabaseUrlFor(config),
    VITE_SB_PUBLISHABLE_KEY: config.anonKey,
    VITE_ATTACHMENTS_BUCKET: 'attachments',
  };
}

// Run a git subcommand against the CRM repo (DEPLOY_APP_DIR). No secret ever
// passes through git here; stdout is mirrored to stderr for diagnosis only.
// Resolves on exit 0; rejects (with the exit code attached) otherwise.
function runGit(args, deployId) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', ['-C', DEPLOY_APP_DIR, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { reject(err); return; }
    let err = '';
    child.stdout.on('data', (d) => logPhaseLine(`git: ${String(d).trimEnd()}`, deployId));
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`git ${args[0]} exited with code ${code}: ${err.trim()}`), { code }));
    });
  });
}

// Hard-link a directory tree (cp -al): instant and zero extra disk when src and
// dst share a device (node_modules into the build worktree). Best-effort — if it
// fails, the build itself fails loudly on the missing dependency.
function cpHardlink(src, dst, deployId) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('cp', ['-al', src, dst], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { resolve(); return; }
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve());
    child.on('close', (code) => {
      if (code !== 0) logPhaseLine(`node_modules hard-link skipped (cp exit ${code}): ${err.trim()}`, deployId);
      resolve();
    });
  });
}

// A throwaway detached git worktree of the CRM at HEAD, kept on the same volume
// as /app (under worktrees/) so node_modules hard-links in at zero cost. The
// deploy builds HERE rather than in /app, so the live Vite dev server's
// /app/src is never touched during a deploy.
const BUILD_WORKTREE = join(DEPLOY_APP_DIR, 'worktrees', '_deploy');

async function removeBuildWorktree(deployId) {
  await runGit(['worktree', 'remove', '--force', BUILD_WORKTREE], deployId).catch(() => {});
  await rm(BUILD_WORKTREE, { recursive: true, force: true }).catch(() => {});
  await runGit(['worktree', 'prune'], deployId).catch(() => {});
}

async function createBuildWorktree(deployId) {
  await removeBuildWorktree(deployId);            // clear any stale leftover
  await mkdir(dirname(BUILD_WORKTREE), { recursive: true });
  await runGit(['worktree', 'add', '--detach', '--force', BUILD_WORKTREE, 'HEAD'], deployId);
  // node_modules is gitignored → absent from the fresh checkout. Hard-link it in.
  await cpHardlink(join(DEPLOY_APP_DIR, 'node_modules'), join(BUILD_WORKTREE, 'node_modules'), deployId);
  return BUILD_WORKTREE;
}

// Compile the CRM to <worktree>/dist via `npm run build` (tsc && vite build), in
// an isolated worktree (see createBuildWorktree). The build ALWAYS uses the
// Supabase App.tsx variant: the live tree may be in demo (FakeRest) mode, whose
// App.tsx wires an in-browser fake provider — building that would ship a
// backend-less app. A missing/unreadable variant is FATAL: we abort rather than
// silently publish the wrong build. Returns the worktree path; the caller removes
// it once wrangler has consumed <worktree>/dist (see runDeploy's finally).
async function runBuildPhase(config, deployId) {
  const buildDir = await createBuildWorktree(deployId);
  const variant = await readFile(APP_SUPABASE_VARIANT, 'utf8');
  await writeFile(join(buildDir, 'src', 'App.tsx'), variant, 'utf8');
  logPhaseLine('applied Supabase App.tsx variant in the build worktree', deployId);
  await runCommandPhase({
    argv: [BUILD_BIN, 'run', 'build'],
    env: buildEnv(config),
    label: 'vite build',
    config,
    deployId,
    cwd: buildDir,
  });
  return buildDir;
}

// Create a fresh mode-700 temp dir under the OS tmp; returns its path and a
// cleanup thunk. Centralises the mkdtemp + rm dance the env-file writers share.
async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) };
}

// Write a throwaway wrangler config describing an assets-only Worker that serves
// the freshly-built <buildDir>/dist. `single-page-application` makes the Worker
// return index.html for any unmatched path so React Router deep links resolve.
// The worker name is derived from the Supabase project ref so two projects don't
// collide on one Cloudflare account. Mode 600 + temp dir mirrors the secrets
// env-file pattern; the caller runs the returned cleanup afterwards.
async function writeWranglerConfig(config, buildDir) {
  const { dir, cleanup } = await makeTempDir('deploy-wrangler-');
  const file = join(dir, 'wrangler.json');
  const body = {
    name: `atomic-crm-${config.projectRef}`,
    compatibility_date: WRANGLER_COMPAT_DATE,
    assets: {
      directory: join(buildDir, 'dist'),
      not_found_handling: 'single-page-application',
    },
  };
  await writeFile(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  return { file, cleanup };
}

// Publish the freshly-built bundle to Cloudflare Workers static assets. The API
// token + account ID go through the environment (never argv); wrangler runs
// non-interactively because the token is present.
async function runCloudflarePhase(config, buildDir, deployId) {
  const { file, cleanup } = await writeWranglerConfig(config, buildDir);
  try {
    await runCommandPhase({
      argv: [WRANGLER_BIN, 'deploy', '--config', file],
      env: {
        CLOUDFLARE_API_TOKEN: config.cloudflareApiToken,
        CLOUDFLARE_ACCOUNT_ID: config.cloudflareAccountId,
      },
      label: 'wrangler deploy',
      config,
      deployId,
      cwd: buildDir,
    });
  } finally {
    await cleanup();
  }
}

// `supabase secrets set --env-file` reads KEY=VALUE lines. Writing them to a
// mode-600 tempfile (rather than argv) keeps the values out of `ps`/history.
// Returns the file path; caller is responsible for deleting it.
async function writeSecretsEnvFile(secrets) {
  const { dir, cleanup } = await makeTempDir('deploy-secrets-');
  const file = join(dir, 'secrets.env');
  const body = Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  await writeFile(file, body, { mode: 0o600 });
  return { file, cleanup };
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
  const cfEnabled = isCloudflareComplete(config);
  let buildDir = null;

  try {
    // Build the static CRM bundle FIRST when a Cloudflare target is configured: a
    // compile failure aborts the whole deploy before anything is pushed to the
    // live Supabase database. The build runs in an isolated worktree (see
    // runBuildPhase) so the live dev server's /app/src is untouched. With no
    // Cloudflare config this is skipped and the deploy is a Supabase-only push.
    if (cfEnabled) {
      emitStep('▶ Building CRM (vite)', deployId);
      buildDir = await runBuildPhase(config, deployId);
    }

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
      const { file, cleanup } = await writeSecretsEnvFile(secrets);
      try {
        await runSupabasePhase(['secrets', 'set', '--project-ref', ref, '--env-file', file], config, deployId);
      } finally {
        await cleanup();
      }
    } else {
      emitStep('▶ No function secrets to sync', deployId);
    }

    // Frontend: publish the compiled bundle to Cloudflare Workers AFTER the
    // Supabase backend is live, so the deployed app points at a ready database.
    if (cfEnabled) {
      emitStep(`▶ Deploying frontend to Cloudflare Workers (atomic-crm-${ref})`, deployId);
      await runCloudflarePhase(config, buildDir, deployId);
    }

    emitStep('✓ Deploy complete', deployId);
  } finally {
    // Always tear down the throwaway build worktree (fixed path), on success or
    // failure — including a failure inside runBuildPhase after the worktree was
    // created but before `buildDir` was assigned.
    if (cfEnabled) await removeBuildWorktree(deployId);
  }
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
  // A deploy needs BOTH targets fully configured: Supabase (backend) AND
  // Cloudflare (frontend). Refuse a partial draft as firmly as a missing config:
  // a deploy that started with, say, no dbPassword would link the project and
  // push migrations before failing mid-way against the live database. All
  // surface as `not_configured` — the form gates the button anyway, this is the
  // server-side backstop.
  if (!isDeployable(config)) {
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

  // Flip running off only after the lastDeployAt stamp is persisted: a status
  // poll that sees running=false then always reads a fully finalized config,
  // and a second deploy can't slip in mid-stamp.
  deployState.running = false;

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
