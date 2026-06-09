import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SUPABASE = join(__dirname, 'fixtures', 'fake-supabase.sh');
const FAKE_BUILD = join(__dirname, 'fixtures', 'fake-build.sh');
const FAKE_WRANGLER = join(__dirname, 'fixtures', 'fake-wrangler.sh');
// Stand-in contents for the Supabase App.tsx variant the build swaps in.
const SUPABASE_VARIANT = '// supabase variant\nexport default () => null;\n';

let tmpDir;
let mod;

// Fake Supabase Management API. updateSupabaseAuthConfig GETs then PATCHes
// /v1/projects/<ref>/config/auth; this server records every request so a test
// can assert what got bound, and lets a test shape the GET response (the
// existing uri_allow_list we merge into) and force error statuses.
let authServer;
const authApi = {
  requests: [],        // { method, path, auth, body }
  getAllowList: '',    // uri_allow_list the GET returns
  patchStatus: 200,    // status the PATCH replies with (200 = ok)
  reset() { this.requests = []; this.getAllowList = ''; this.patchStatus = 200; },
};

// Module reads DEPLOY_CONFIG_PATH/SUPABASE_BIN from process.env at module-import
// time → set env BEFORE the dynamic import. SUPABASE_BIN points at a fake CLI
// so runDeploy exercises its phases without a real project. Sharing one tmp
// config path across tests so they can interleave reads/writes; beforeEach
// resets the file content to a known shape.
before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'deploy-test-'));
  process.env.DEPLOY_CONFIG_PATH = join(tmpDir, 'config.json');
  process.env.SUPABASE_BIN = FAKE_SUPABASE;
  // Build + wrangler fakes so the optional Cloudflare phases run without a real
  // Vite build or Cloudflare account. Harmless for the Supabase-only tests:
  // their configs carry no Cloudflare credentials, so neither phase fires.
  process.env.BUILD_BIN = FAKE_BUILD;
  process.env.WRANGLER_BIN = FAKE_WRANGLER;
  // Supabase App.tsx variant the build phase overlays in the build worktree.
  process.env.APP_SUPABASE_VARIANT = join(tmpDir, 'App.supabase.tsx');
  await writeFile(process.env.APP_SUPABASE_VARIANT, SUPABASE_VARIANT, { mode: 0o644 });
  // The deploy builds in an isolated detached git worktree of DEPLOY_APP_DIR at
  // HEAD (so the live /app/src is never touched) and spawns the CLIs with that
  // dir as cwd. Make tmpDir a real git repo with a committed src/App.tsx so
  // createBuildWorktree has something to check out — and so the phases run
  // regardless of host layout (a bare /app doesn't exist on a CI runner).
  process.env.DEPLOY_APP_DIR = tmpDir;
  await mkdir(join(tmpDir, 'src'), { recursive: true });
  await writeFile(join(tmpDir, 'src', 'App.tsx'), '// committed App.tsx\nexport default () => null;\n');
  await writeFile(join(tmpDir, 'package.json'), '{"name":"crm","version":"0.0.0","scripts":{"build":"true"}}\n');
  await writeFile(join(tmpDir, '.gitignore'), 'worktrees/\nnode_modules/\nconfig.json\n*.txt\n');
  const git = (...args) => execFileSync('git', ['-C', tmpDir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Deploy Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');

  // Fake Supabase Management API on an ephemeral port. Set SUPABASE_API_URL
  // BEFORE the dynamic import — the module reads it at import time.
  authServer = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      authApi.requests.push({
        method: req.method,
        path: req.url,
        auth: req.headers.authorization || '',
        body: buf ? JSON.parse(buf) : null,
      });
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ uri_allow_list: authApi.getAllowList }));
      } else {
        res.writeHead(authApi.patchStatus, { 'Content-Type': 'application/json' });
        res.end(authApi.patchStatus < 300 ? '{}' : '{"message":"nope"}');
      }
    });
  });
  await new Promise((r) => authServer.listen(0, '127.0.0.1', r));
  process.env.SUPABASE_API_URL = `http://127.0.0.1:${authServer.address().port}`;

  mod = await import('../lib/server/deploy-routes.js');
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  if (authServer) await new Promise((r) => authServer.close(r));
});

beforeEach(() => {
  mod._resetForTests();
  authApi.reset();
  // Drop any FAKE_* env from previous tests so each starts clean.
  for (const k of ['FAKE_SUPABASE_EXIT', 'FAKE_SUPABASE_STDERR', 'FAKE_SUPABASE_DELAY_MS', 'FAKE_SUPABASE_LEAK', 'FAKE_BUILD_EXIT', 'FAKE_WRANGLER_EXIT', 'FAKE_WRANGLER_URL']) {
    delete process.env[k];
  }
});

// Lightweight req/res harness — the routes accept Node http req/res but only
// read `req.url/method` and call `req.on('data'|'end')` for JSON bodies.
function makeReq(method, body) {
  const handlers = {};
  const req = {
    method,
    on(event, cb) { handlers[event] = cb; return req; },
  };
  if (body !== undefined) {
    queueMicrotask(() => {
      handlers.data?.(JSON.stringify(body));
      handlers.end?.();
    });
  } else {
    queueMicrotask(() => handlers.end?.());
  }
  return req;
}

function makeRes() {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers || {});
    },
    end(payload) {
      if (typeof payload === 'string') this.body += payload;
      else if (payload) this.body += Buffer.isBuffer(payload) ? payload.toString() : String(payload);
      resolve(this);
    },
  };
  res.done = done;
  return res;
}

function validConfig(overrides = {}) {
  return {
    projectRef: 'abcdefghijklmnopqrst',
    supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
    anonKey: 'eyJanon',
    serviceRoleKey: 'eyJservice',
    dbPassword: 'super-secret-password',
    // Prefix-only fake — validator just checks `startsWith('sbp_')`. Avoid the
    // 40-hex-char shape that triggers GitHub Push Protection's Supabase PAT
    // detector.
    accessToken: 'sbp_TEST_TOKEN_NOT_A_REAL_SECRET',
    ...overrides,
  };
}

// Poll until the in-flight deploy settles (running flips back to false) so the
// next test starts from a clean state. A couple of tests import a fresh module
// instance, so the target is overridable; intervalMs is just polling cadence.
function drainDeploy(module = mod, intervalMs = 30) {
  return new Promise((resolve) => {
    const tick = () => (module.deployState.running ? setTimeout(tick, intervalMs) : resolve());
    tick();
  });
}

test('GET /api/deploy/status — unconfigured: returns configured=false, never leaks secrets', async () => {
  // No config file yet.
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });

  const res = makeRes();
  await mod.handleGetDeployStatus({}, res);
  await res.done;

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.configured, false);
  assert.equal(body.projectRef, null);
  assert.ok(Array.isArray(body.expectedSecrets));
  assert.ok(!('dbPassword' in body));
  assert.ok(!('accessToken' in body));
  assert.ok(!('serviceRoleKey' in body));
});

test('POST /api/deploy/configure — writes config 600, status echoes safe fields only', async () => {
  const req = makeReq('POST', validConfig({ functionSecrets: { POSTMARK_WEBHOOK_USER: 'u', POSTMARK_WEBHOOK_PASSWORD: 'p' } }));
  const res = makeRes();
  await mod.handleConfigureDeploy(req, res);
  await res.done;

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.configured, true);
  assert.equal(body.projectRef, 'abcdefghijklmnopqrst');
  // Sanity: no secret material in the response.
  for (const banned of ['dbPassword', 'accessToken', 'serviceRoleKey', 'anonKey']) {
    assert.ok(!(banned in body), `${banned} leaked in status`);
  }
  // configuredSecrets list reflects what we sent.
  assert.deepEqual(body.configuredSecrets.sort(), ['POSTMARK_WEBHOOK_PASSWORD', 'POSTMARK_WEBHOOK_USER']);

  // File mode must be 600 — credentials must not be world-readable.
  const st = await stat(process.env.DEPLOY_CONFIG_PATH);
  assert.equal(st.mode & 0o777, 0o600);
  // The persisted file DOES contain the secrets (round-trip).
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.equal(disk.dbPassword, 'super-secret-password');
});

test('POST /api/deploy/configure — rejects malformed projectRef', async () => {
  const req = makeReq('POST', validConfig({ projectRef: 'TOO_SHORT' }));
  const res = makeRes();
  await mod.handleConfigureDeploy(req, res);
  await res.done;

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'invalid_config');
  assert.ok(body.errors.some((e) => e.includes('projectRef')));
});

test('POST /api/deploy/configure — rejects access token without sbp_ prefix', async () => {
  const req = makeReq('POST', validConfig({ accessToken: 'not_a_real_token' }));
  const res = makeRes();
  await mod.handleConfigureDeploy(req, res);
  await res.done;

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.ok(body.errors.some((e) => e.toLowerCase().includes('access')));
});

test('POST /api/deploy/configure — edit: blank secrets keep the stored values', async () => {
  // Seed an existing config.
  const seed = validConfig({
    dbPassword: 'original-password',
    functionSecrets: { POSTMARK_WEBHOOK_USER: 'u', POSTMARK_WEBHOOK_PASSWORD: 'p' },
  });
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(seed), { mode: 0o600 });

  // Re-submit with only the non-secret fields + a changed supabaseUrl; all
  // secrets blank → they must survive.
  const newRef = 'zzzzzzzzzzzzzzzzzzzz';
  const req = makeReq('POST', {
    projectRef: newRef,
    supabaseUrl: `https://${newRef}.supabase.co`,
    anonKey: '', serviceRoleKey: '', dbPassword: '', accessToken: '',
  });
  const res = makeRes();
  await mod.handleConfigureDeploy(req, res);
  await res.done;

  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.projectRef, newRef);
  // Stored secrets carried over.
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.equal(disk.dbPassword, 'original-password');
  assert.equal(disk.accessToken, seed.accessToken);
  assert.equal(disk.anonKey, seed.anonKey);
  assert.equal(disk.serviceRoleKey, seed.serviceRoleKey);
  // Function secrets preserved when their inputs are absent.
  assert.deepEqual(body.configuredSecrets.sort(), ['POSTMARK_WEBHOOK_PASSWORD', 'POSTMARK_WEBHOOK_USER']);
});

test('POST /api/deploy/configure — edit: non-blank secret overwrites the stored value', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(validConfig({ dbPassword: 'old-pw' })), { mode: 0o600 });

  const req = makeReq('POST', validConfig({ dbPassword: 'new-pw', anonKey: '', serviceRoleKey: '', accessToken: '' }));
  const res = makeRes();
  await mod.handleConfigureDeploy(req, res);
  await res.done;

  assert.equal(res.statusCode, 200, res.body);
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.equal(disk.dbPassword, 'new-pw');           // overwritten
  assert.equal(disk.accessToken, validConfig().accessToken); // kept (blank)
});

test('POST /api/deploy/configure — first configure accepts a partial draft (no secrets yet)', async () => {
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });

  const req = makeReq('POST', {
    projectRef: 'abcdefghijklmnopqrst',
    supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
    anonKey: '', serviceRoleKey: '', dbPassword: '', accessToken: '',
  });
  const res = makeRes();
  await mod.handleConfigureDeploy(req, res);
  await res.done;

  // Partial saves are allowed so the user can fill the form across sittings and
  // switch away whenever — the missing secrets just leave it not-yet-deployable.
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.configured, true, 'a config file now exists');
  assert.equal(body.supabaseComplete, false, 'but it is not deploy-ready');
  assert.equal(body.projectRef, 'abcdefghijklmnopqrst');
  assert.deepEqual(body.configuredSecretFields, [], 'no secrets stored yet');

  // The draft persisted the non-secret fields; blank secrets were not stored.
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.equal(disk.projectRef, 'abcdefghijklmnopqrst');
  assert.ok(!disk.dbPassword, 'a blank secret must not be stored');
});

test('POST /api/deploy/configure — completing the draft flips supabaseComplete and lists stored secrets', async () => {
  // Seed a partial draft (Supabase URL + project ref only).
  await writeFile(
    process.env.DEPLOY_CONFIG_PATH,
    JSON.stringify({ projectRef: 'abcdefghijklmnopqrst', supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co' }),
    { mode: 0o600 },
  );

  const res = makeRes();
  await mod.handleConfigureDeploy(makeReq('POST', validConfig()), res);
  await res.done;

  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.supabaseComplete, true, 'all Supabase fields now present');
  assert.deepEqual(
    body.configuredSecretFields.sort(),
    ['accessToken', 'anonKey', 'dbPassword', 'serviceRoleKey'],
    'every stored secret field is reported by name (never its value)',
  );
});

test('POST /api/deploy/configure — edit: bad access token is still rejected when supplied', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(validConfig()), { mode: 0o600 });

  const req = makeReq('POST', validConfig({ accessToken: 'not_sbp', anonKey: '', serviceRoleKey: '', dbPassword: '' }));
  const res = makeRes();
  await mod.handleConfigureDeploy(req, res);
  await res.done;

  assert.equal(res.statusCode, 400);
  assert.ok(JSON.parse(res.body).errors.some((e) => e.toLowerCase().includes('access')));
});

test('POST /api/deploy/run — 412 when not configured', async () => {
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });
  const req = makeReq('POST');
  const res = makeRes();
  await mod.handleDeployRun(req, res);
  await res.done;
  assert.equal(res.statusCode, 412);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'not_configured');
});

test('POST /api/deploy/run — 412 on a partial draft (config exists but Supabase incomplete)', async () => {
  // A saved-but-incomplete config must not start a deploy: it would link the
  // project and push migrations before failing mid-way against the live DB.
  await writeFile(
    process.env.DEPLOY_CONFIG_PATH,
    JSON.stringify(validConfig({ dbPassword: '' })), // every field but the db password
    { mode: 0o600 },
  );
  const res = makeRes();
  await mod.handleDeployRun(makeReq('POST'), res);
  await res.done;
  assert.equal(res.statusCode, 412);
  assert.equal(JSON.parse(res.body).error, 'not_configured');
  assert.equal(mod.deployState.running, false, 'the optimistically-claimed slot is released');
});

test('POST /api/deploy/run — 409 when deploy already running', async () => {
  // Seed a fully deployable config (both targets).
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });
  // Force a long-running fake so the second request races into the running flag.
  process.env.FAKE_SUPABASE_DELAY_MS = '300';

  const res1 = makeRes();
  await mod.handleDeployRun(makeReq('POST'), res1);
  await res1.done;
  assert.equal(res1.statusCode, 202);

  // Second request should bounce immediately.
  const res2 = makeRes();
  await mod.handleDeployRun(makeReq('POST'), res2);
  await res2.done;
  assert.equal(res2.statusCode, 409);
  assert.equal(JSON.parse(res2.body).error, 'deploy_in_progress');

  // Wait for the first run to drain so beforeEach in the next test sees a
  // settled state.
  await drainDeploy();
});

test('POST /api/deploy/run — two requests in the same tick: exactly one wins (TOCTOU guard)', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });

  // Fire BOTH before awaiting either — they race through the running-flag check
  // in the same tick. The guard claims the slot synchronously before the first
  // `await loadConfig()`, so the first request wins and the second bounces with
  // 409 (no CLI delay needed — the race is decided before any await). Pre-fix
  // both saw running===false across the await and both 202'd, launching
  // concurrent deploys against the live project — the regression we lock down.
  const res1 = makeRes();
  const res2 = makeRes();
  const p1 = mod.handleDeployRun(makeReq('POST'), res1);
  const p2 = mod.handleDeployRun(makeReq('POST'), res2);
  await Promise.all([p1, p2, res1.done, res2.done]);

  assert.equal(res1.statusCode, 202, 'the first request starts the deploy');
  assert.equal(res2.statusCode, 409, 'the second request is rejected');
  assert.equal(JSON.parse(res2.body).error, 'deploy_in_progress');

  await drainDeploy();
});

test('POST /api/deploy/run — happy path: tail captures lines, deploy_done fires, lastDeployAt stamped', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });

  const res = makeRes();
  await mod.handleDeployRun(makeReq('POST'), res);
  await res.done;
  assert.equal(res.statusCode, 202);

  // Wait for the child to finish.
  await drainDeploy();

  assert.equal(mod.deployState.ok, true);
  assert.equal(mod.deployState.exitCode, 0);
  assert.ok(mod.deployState.tail.length > 0, 'tail must capture stdout lines');
  const joined = mod.deployState.tail.map((f) => f.line).join('\n');
  assert.match(joined, /Linking project/);
  assert.match(joined, /Deploy complete/);

  // lastDeployAt persisted onto the config.
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.ok(disk.lastDeployAt, 'lastDeployAt must be stamped on success');
});

test('POST /api/deploy/run — failure path: exitCode propagated, full error on stderr only', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });
  process.env.FAKE_SUPABASE_EXIT = '7';
  process.env.FAKE_SUPABASE_STDERR = 'boom';

  // The full Supabase output is mirrored to the chat-service stderr — never to
  // the frontend tail. Capture console.error to assert that.
  const errLines = [];
  const origErr = console.error;
  console.error = (...a) => errLines.push(a.join(' '));

  try {
    const res = makeRes();
    await mod.handleDeployRun(makeReq('POST'), res);
    await res.done;
    assert.equal(res.statusCode, 202);

    await drainDeploy();
  } finally {
    console.error = origErr;
  }

  assert.equal(mod.deployState.ok, false);
  assert.equal(mod.deployState.exitCode, 7);

  // The modal tail carries steps only — including a failure step — never the
  // raw Supabase 'boom' line.
  const tail = mod.deployState.tail.map((f) => f.line).join('\n');
  assert.match(tail, /deploy error/);
  assert.ok(!tail.includes('boom'), `raw supabase output leaked into tail: ${tail}`);

  // The full Supabase error went to the chat-service stderr.
  assert.match(errLines.join('\n'), /boom/);
});

test('POST /api/deploy/run — missing supabase binary finalizes instead of hanging', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });
  const prevBin = process.env.SUPABASE_BIN;
  // Absolute path that doesn't exist → the first phase's spawn emits ENOENT.
  process.env.SUPABASE_BIN = join(tmpDir, 'no-such-supabase-binary');
  // Fresh module instance so SUPABASE_BIN is re-read at import; isolated state.
  const freshMod = await import('../lib/server/deploy-routes.js?missing-binary');
  try {
    const res = makeRes();
    await freshMod.handleDeployRun(makeReq('POST'), res);
    await res.done;
    assert.equal(res.statusCode, 202);

    await drainDeploy(freshMod);

    assert.equal(freshMod.deployState.running, false, 'deploy must not hang on a missing binary');
    assert.equal(freshMod.deployState.ok, false);
    const joined = freshMod.deployState.tail.map((f) => f.line).join('\n');
    assert.match(joined, /deploy error|ENOENT|spawn/);
  } finally {
    process.env.SUPABASE_BIN = prevBin;
  }
});

test('redactSecrets — masks every sensitive field value with ***', () => {
  const config = validConfig({ functionSecrets: { POSTMARK_WEBHOOK_USER: 'mailuser1234' } });
  const line = `Using token ${config.accessToken} and password ${config.dbPassword} and key ${config.serviceRoleKey} and ${config.anonKey} and user ${config.functionSecrets.POSTMARK_WEBHOOK_USER}`;
  const out = mod.redactSecrets(line, config);
  assert.ok(!out.includes(config.accessToken), 'access token leaked');
  assert.ok(!out.includes(config.dbPassword), 'db password leaked');
  assert.ok(!out.includes(config.serviceRoleKey), 'service role key leaked');
  assert.ok(!out.includes(config.anonKey), 'anon key leaked');
  assert.ok(!out.includes(config.functionSecrets.POSTMARK_WEBHOOK_USER), 'function secret leaked');
  assert.match(out, /\*\*\*/);
});

test('redactSecrets — ignores empty/short candidates so common words survive', () => {
  // 3-char password would risk masking common substrings; guard rail keeps it.
  const config = { accessToken: '', dbPassword: 'xy', serviceRoleKey: '', anonKey: '' };
  const out = mod.redactSecrets('the quick brown fox', config);
  assert.equal(out, 'the quick brown fox');
});

test('POST /api/deploy/run — redacts dbPassword from the mirrored Supabase output', async () => {
  const leakedSecret = 'leak-canary-1234567890';
  await writeFile(
    process.env.DEPLOY_CONFIG_PATH,
    JSON.stringify(cfConfig({ dbPassword: leakedSecret })),
    { mode: 0o600 },
  );
  process.env.FAKE_SUPABASE_LEAK = leakedSecret;

  const errLines = [];
  const origErr = console.error;
  console.error = (...a) => errLines.push(a.join(' '));

  try {
    const res = makeRes();
    await mod.handleDeployRun(makeReq('POST'), res);
    await res.done;
    await drainDeploy();
  } finally {
    console.error = origErr;
  }

  // The raw leak line goes to stderr only, with the secret redacted.
  const err = errLines.join('\n');
  assert.ok(!err.includes(leakedSecret), `secret leaked into stderr: ${err}`);
  assert.match(err, /leaked=\*\*\*/);

  // The frontend tail never sees the raw Supabase output at all.
  const tail = mod.deployState.tail.map((f) => f.line).join('\n');
  assert.ok(!tail.includes('leaked='), `raw supabase output leaked into tail: ${tail}`);
  assert.ok(!tail.includes(leakedSecret), `secret leaked into tail: ${tail}`);
});

// SSE harness: captures every `res.write` and exposes the parsed `data:` frames.
// Unlike makeRes(), an SSE response is never `end()`ed — it stays open and is
// torn down by the client closing the request.
function makeSseRes() {
  const closeHandlers = [];
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    // The handler registers req-close via req.on; expose a trigger for the test.
  };
  res.frames = () =>
    res.chunks
      .filter((c) => c.startsWith('data: '))
      .map((c) => JSON.parse(c.slice('data: '.length).trim()));
  res._closeHandlers = closeHandlers;
  return res;
}

function makeSseReq() {
  const handlers = {};
  return { on(event, cb) { handlers[event] = cb; return this; }, _fire: (e) => handlers[e]?.() };
}

test('GET /api/deploy/events — opens an SSE stream and replays a snapshot on connect', async () => {
  const req = makeSseReq();
  const res = makeSseRes();
  mod.handleDeployEvents(req, res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  const frames = res.frames();
  assert.equal(frames.length, 1, 'exactly one snapshot frame on connect');
  assert.equal(frames[0].type, 'deploy_snapshot');
  assert.equal(frames[0].running, false);

  req._fire('close'); // clean up the registered client + heartbeat
});

test('GET /api/deploy/events — streams started/log/done live during a deploy, then stops after disconnect', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });

  const req = makeSseReq();
  const res = makeSseRes();
  mod.handleDeployEvents(req, res);
  res.chunks.length = 0; // drop the connect snapshot; assert only on live events

  const runRes = makeRes();
  await mod.handleDeployRun(makeReq('POST'), runRes);
  await runRes.done;
  await drainDeploy();

  const types = res.frames().map((f) => f.type);
  assert.ok(types.includes('deploy_started'), 'SSE client must receive deploy_started');
  assert.ok(types.includes('deploy_log'), 'SSE client must receive deploy_log steps live');
  assert.ok(types.includes('deploy_done'), 'SSE client must receive deploy_done');
  const logLines = res.frames().filter((f) => f.type === 'deploy_log').map((f) => f.line).join('\n');
  assert.match(logLines, /Linking project/);

  // After the client disconnects it must be dropped — no further frames reach it.
  req._fire('close');
  const before = res.chunks.length;
  mod.deployState.running = false;
  await mod.handleDeployRun(makeReq('POST'), makeRes());
  await drainDeploy();
  assert.equal(res.chunks.length, before, 'disconnected client must receive no further frames');
});

// ── Cloudflare frontend deploy ────────────────────────────────────────────
// Obviously-fake credentials: a 32-hex account ID and a ≥20-char token that
// won't trip any real-secret scanner.
const CF_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const CF_TOKEN = 'cf-TEST-TOKEN-NOT-A-REAL-SECRET-123';

function cfConfig(overrides = {}) {
  return validConfig({ cloudflareAccountId: CF_ACCOUNT_ID, cloudflareApiToken: CF_TOKEN, ...overrides });
}

async function waitUntilSettled(m = mod) {
  await new Promise((resolve) => {
    const tick = () => (m.deployState.running ? setTimeout(tick, 30) : resolve());
    tick();
  });
}

test('POST /api/deploy/configure — Cloudflare: stores creds, status echoes accountId + configured, never the token', async () => {
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });

  const res = makeRes();
  await mod.handleConfigureDeploy(makeReq('POST', cfConfig()), res);
  await res.done;

  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.cloudflareConfigured, true);
  assert.equal(body.cloudflareAccountId, CF_ACCOUNT_ID);
  assert.ok(!('cloudflareApiToken' in body), 'cloudflare token must never be returned');

  // Round-trips to disk.
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.equal(disk.cloudflareAccountId, CF_ACCOUNT_ID);
  assert.equal(disk.cloudflareApiToken, CF_TOKEN);
});

test('POST /api/deploy/configure — Cloudflare: no creds keeps it disabled (Supabase-only)', async () => {
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });

  const res = makeRes();
  await mod.handleConfigureDeploy(makeReq('POST', validConfig()), res);
  await res.done;

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).cloudflareConfigured, false);
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.ok(!('cloudflareApiToken' in disk), 'no token stored when none supplied');
});

test('POST /api/deploy/configure — Cloudflare: account ID without token saves as an incomplete draft', async () => {
  // Partial Cloudflare is a valid saved state — it just doesn't enable the
  // frontend deploy until the token lands too (pairing enforced at deploy time).
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });
  const res = makeRes();
  await mod.handleConfigureDeploy(makeReq('POST', validConfig({ cloudflareAccountId: CF_ACCOUNT_ID })), res);
  await res.done;
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.cloudflareConfigured, false, 'a lone account ID does not enable Cloudflare');
  assert.equal(body.cloudflareAccountId, CF_ACCOUNT_ID, 'but the account ID is kept');
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.ok(!disk.cloudflareApiToken, 'no token stored');
});

test('POST /api/deploy/configure — Cloudflare: a token without an account ID is persisted (not dropped) but stays disabled', async () => {
  // A lone token must NOT be silently discarded — it's kept (blank-keeps rule)
  // so the user doesn't lose it, but Cloudflare stays disabled until the account
  // ID lands too. `cloudflareTokenStored` lets the form show "leave blank to keep".
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });
  const res = makeRes();
  await mod.handleConfigureDeploy(makeReq('POST', validConfig({ cloudflareApiToken: CF_TOKEN })), res);
  await res.done;
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.cloudflareConfigured, false, 'a lone token does not enable Cloudflare');
  assert.equal(body.cloudflareTokenStored, true, 'but the token is reported as stored');
  assert.ok(!('cloudflareApiToken' in body), 'the token value is still never returned');
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.equal(disk.cloudflareApiToken, CF_TOKEN, 'the token is persisted, not silently dropped');
  assert.ok(!disk.cloudflareAccountId, 'no account ID yet');
});

test('POST /api/deploy/configure — Cloudflare: malformed account ID is rejected', async () => {
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });
  const res = makeRes();
  await mod.handleConfigureDeploy(makeReq('POST', cfConfig({ cloudflareAccountId: 'not-hex' })), res);
  await res.done;
  assert.equal(res.statusCode, 400);
  assert.ok(JSON.parse(res.body).errors.some((e) => e.includes('cloudflareAccountId')));
});

test('POST /api/deploy/configure — Cloudflare edit: blank fields keep the stored creds (no accidental drop)', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });

  // Edit only the Supabase tab — both Cloudflare fields arrive blank in the body.
  // Blank keeps the stored value (same rule as the Supabase secrets), so a stored
  // Cloudflare credential is never silently dropped by an unrelated edit.
  const res = makeRes();
  await mod.handleConfigureDeploy(
    makeReq('POST', validConfig({ cloudflareAccountId: '', cloudflareApiToken: '', anonKey: '', serviceRoleKey: '', dbPassword: '', accessToken: '' })),
    res,
  );
  await res.done;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).cloudflareConfigured, true, 'blank fields keep Cloudflare configured');
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.equal(disk.cloudflareAccountId, CF_ACCOUNT_ID, 'account ID kept');
  assert.equal(disk.cloudflareApiToken, CF_TOKEN, 'token kept (not dropped)');
});

test('redactSecrets — masks the Cloudflare API token', () => {
  const out = mod.redactSecrets(`deploying with token ${CF_TOKEN}`, cfConfig());
  assert.ok(!out.includes(CF_TOKEN), 'cloudflare token leaked');
  assert.match(out, /\*\*\*/);
});

test('POST /api/deploy/run — Cloudflare enabled: build runs first, wrangler last, in order', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });

  const res = makeRes();
  await mod.handleDeployRun(makeReq('POST'), res);
  await res.done;
  assert.equal(res.statusCode, 202);
  await waitUntilSettled();

  assert.equal(mod.deployState.ok, true);
  const steps = mod.deployState.tail.map((f) => f.line).join('\n');
  // Order: build (first) → supabase link → cloudflare (last) → complete.
  const iBuild = steps.indexOf('Building CRM');
  const iLink = steps.indexOf('Linking project');
  const iCf = steps.indexOf('Cloudflare Workers');
  const iDone = steps.indexOf('Deploy complete');
  assert.ok(iBuild >= 0, 'build step must appear when Cloudflare is configured');
  assert.ok(iCf >= 0, 'cloudflare step must appear when configured');
  assert.ok(iBuild < iLink && iLink < iCf && iCf < iDone, `phase order wrong:\n${steps}`);
});

test('runDeploy — Cloudflare not configured: skips the build + wrangler phases', async () => {
  // The HTTP run endpoint now requires Cloudflare (see the 412 test below), but
  // the phase orchestration itself must still skip the CF phases cleanly when
  // invoked directly with a Supabase-only config.
  mod.deployState.tail = [];
  await mod.runDeploy(validConfig(), 'test-no-cf');

  const steps = mod.deployState.tail.map((f) => f.line).join('\n');
  assert.ok(!steps.includes('Building CRM'), 'build must be skipped without Cloudflare');
  assert.ok(!steps.includes('Cloudflare Workers'), 'cloudflare deploy must be skipped without config');
  assert.match(steps, /Deploy complete/);
});

test('POST /api/deploy/run — Cloudflare build failure aborts before Supabase', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });
  process.env.FAKE_BUILD_EXIT = '3';

  const errLines = [];
  const origErr = console.error;
  console.error = (...a) => errLines.push(a.join(' '));
  try {
    const res = makeRes();
    await mod.handleDeployRun(makeReq('POST'), res);
    await res.done;
    await waitUntilSettled();
  } finally {
    console.error = origErr;
  }

  assert.equal(mod.deployState.ok, false);
  assert.equal(mod.deployState.exitCode, 3);
  const steps = mod.deployState.tail.map((f) => f.line).join('\n');
  assert.match(steps, /Building CRM/);
  assert.ok(!steps.includes('Linking project'), 'Supabase must not run after a build failure');
});

test('POST /api/deploy/run — builds against the Supabase variant in an isolated worktree, never touching the live src/App.tsx', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });

  // Simulate a container running in demo mode: the live working-tree src/App.tsx
  // is the FakeRest variant. The build worktree checks out HEAD and overlays the
  // Supabase variant there — it must never write this live file.
  const liveApp = join(tmpDir, 'src', 'App.tsx');
  const fakerest = '// fakerest live variant\nexport default () => null;\n';
  await writeFile(liveApp, fakerest, { mode: 0o644 });

  // The fake build snapshots its cwd's src/App.tsx so we can prove the build ran
  // against the Supabase variant (in the worktree), not the live file.
  const snapshot = join(tmpDir, 'apptsx-at-build.txt');
  process.env.FAKE_BUILD_APPTSX_OUT = snapshot;
  try {
    const res = makeRes();
    await mod.handleDeployRun(makeReq('POST'), res);
    await res.done;
    await waitUntilSettled();
  } finally {
    delete process.env.FAKE_BUILD_APPTSX_OUT;
  }

  assert.equal(mod.deployState.ok, true, mod.deployState.tail.map((f) => f.line).join('\n'));
  // The build ran against the Supabase variant (overlaid in the worktree).
  assert.equal(await readFile(snapshot, 'utf8'), SUPABASE_VARIANT, 'build must run against the Supabase variant');
  // The live src/App.tsx was never touched by the deploy — full isolation.
  assert.equal(await readFile(liveApp, 'utf8'), fakerest, 'live src/App.tsx must be untouched by the deploy');

  // Restore the committed content so later tests' worktrees are unaffected.
  await writeFile(liveApp, '// committed App.tsx\nexport default () => null;\n', { mode: 0o644 });
});

test('POST /api/deploy/run — 412 when Supabase is complete but Cloudflare is not', async () => {
  // Both targets are required to deploy. A Supabase-only config (no Cloudflare)
  // must be refused at the run gate, exactly like a missing config.
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(validConfig()), { mode: 0o600 });
  const res = makeRes();
  await mod.handleDeployRun(makeReq('POST'), res);
  await res.done;
  assert.equal(res.statusCode, 412);
  assert.equal(JSON.parse(res.body).error, 'not_configured');
  assert.equal(mod.deployState.running, false, 'the optimistically-claimed slot is released');
});

test('POST /api/deploy/configure — Cloudflare: an uppercase account ID is stored lowercased', async () => {
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });
  const res = makeRes();
  await mod.handleConfigureDeploy(makeReq('POST', cfConfig({ cloudflareAccountId: CF_ACCOUNT_ID.toUpperCase() })), res);
  await res.done;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(JSON.parse(res.body).cloudflareAccountId, CF_ACCOUNT_ID, 'echoed lowercase');
  const disk = JSON.parse(await readFile(process.env.DEPLOY_CONFIG_PATH, 'utf8'));
  assert.equal(disk.cloudflareAccountId, CF_ACCOUNT_ID, 'stored lowercase, never the uppercase paste');
});

test('POST /api/deploy/run — a missing App.tsx variant aborts the deploy before Supabase', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });
  // Remove the variant the build overlays → runBuildPhase's readFile throws,
  // which must abort the whole deploy rather than ship the wrong (FakeRest) build.
  await rm(process.env.APP_SUPABASE_VARIANT, { force: true });

  const origErr = console.error;
  console.error = () => {};
  try {
    const res = makeRes();
    await mod.handleDeployRun(makeReq('POST'), res);
    await res.done;
    await waitUntilSettled();
  } finally {
    console.error = origErr;
    // Restore the variant for any later test.
    await writeFile(process.env.APP_SUPABASE_VARIANT, SUPABASE_VARIANT, { mode: 0o644 });
  }

  assert.equal(mod.deployState.ok, false, 'deploy must fail when the variant is missing');
  const steps = mod.deployState.tail.map((f) => f.line).join('\n');
  assert.match(steps, /Building CRM/);
  assert.ok(!steps.includes('Linking project'), 'Supabase must not run when the build aborts');
});

// --- Callback URL auto-binding -------------------------------------------

test('parseWorkerUrl — scrapes the workers.dev URL out of wrangler output', () => {
  const lines = [
    'wrangler deploy --config x (fake)',
    'Uploaded atomic-crm-abc (1.2 sec)',
    '  https://atomic-crm-abc.my-team.workers.dev',
    'Current Version ID: deadbeef',
  ];
  assert.equal(mod.parseWorkerUrl(lines), 'https://atomic-crm-abc.my-team.workers.dev');
});

test('parseWorkerUrl — null when no workers.dev URL is present', () => {
  assert.equal(mod.parseWorkerUrl(['wrangler deploy (fake)', 'no url here']), null);
  assert.equal(mod.parseWorkerUrl([]), null);
  assert.equal(mod.parseWorkerUrl(undefined), null);
});

test('POST /api/deploy/run — binds the wrangler URL as the Supabase callback (site_url + merged allow-list)', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });
  const PROD_URL = 'https://atomic-crm-abcdefghijklmnopqrst.my-team.workers.dev';
  process.env.FAKE_WRANGLER_URL = PROD_URL;
  // A pre-existing localhost entry must survive the merge, not be clobbered.
  authApi.getAllowList = 'http://localhost:5173';

  const res = makeRes();
  await mod.handleDeployRun(makeReq('POST'), res);
  await res.done;
  await waitUntilSettled();

  assert.equal(mod.deployState.ok, true, mod.deployState.tail.map((f) => f.line).join('\n'));
  const steps = mod.deployState.tail.map((f) => f.line).join('\n');
  assert.match(steps, /Binding .*workers\.dev as the Supabase callback URL/);
  assert.match(steps, /Supabase callback URL bound/);

  // The orchestrator GET-then-PATCHed the project's auth config.
  const patch = authApi.requests.find((r) => r.method === 'PATCH');
  assert.ok(patch, 'a PATCH to the auth config must have been sent');
  assert.match(patch.path, /\/v1\/projects\/abcdefghijklmnopqrst\/config\/auth$/);
  assert.match(patch.auth, /^Bearer sbp_/);
  assert.equal(patch.body.site_url, PROD_URL, 'site_url set to the prod URL');
  const allow = patch.body.uri_allow_list.split(',');
  assert.ok(allow.includes('http://localhost:5173'), 'existing allow-list entry preserved');
  assert.ok(allow.includes(PROD_URL), 'prod URL added to allow-list');
  assert.ok(allow.includes(`${PROD_URL}/**`), 'wildcard added to allow-list');
  // A clean auto-bind must NOT raise the manual-auth nag.
  assert.equal(mod.deployState.manualAuthUrl, false, 'manual-auth nag stays off on a successful bind');
});

test('POST /api/deploy/run — no workers.dev URL: warns, skips binding, deploy still succeeds', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });
  // FAKE_WRANGLER_URL unset → fake wrangler prints no URL → nothing to bind.

  const res = makeRes();
  await mod.handleDeployRun(makeReq('POST'), res);
  await res.done;
  await waitUntilSettled();

  assert.equal(mod.deployState.ok, true, 'deploy succeeds even when the URL is undeterminable');
  const steps = mod.deployState.tail.map((f) => f.line).join('\n');
  assert.match(steps, /Could not determine the production URL/);
  assert.equal(authApi.requests.length, 0, 'no auth API call without a URL');
  assert.equal(mod.deployState.manualAuthUrl, true, 'manual-auth nag raised when no URL was found');
});

test('POST /api/deploy/run — auth-config PATCH failure warns but keeps the deploy successful', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(cfConfig()), { mode: 0o600 });
  process.env.FAKE_WRANGLER_URL = 'https://atomic-crm-abcdefghijklmnopqrst.my-team.workers.dev';
  authApi.patchStatus = 403; // Management API rejects the bind

  const origErr = console.error;
  console.error = () => {};
  try {
    const res = makeRes();
    await mod.handleDeployRun(makeReq('POST'), res);
    await res.done;
    await waitUntilSettled();
  } finally {
    console.error = origErr;
  }

  assert.equal(mod.deployState.ok, true, 'a failed bind must not fail an already-shipped deploy');
  const steps = mod.deployState.tail.map((f) => f.line).join('\n');
  assert.match(steps, /Could not bind the callback URL.*403/);
  assert.match(steps, /set it manually in Supabase Studio/);
  assert.equal(mod.deployState.manualAuthUrl, true, 'manual-auth nag raised when the bind PATCH fails');
});
