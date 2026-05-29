import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_SUPABASE = join(__dirname, 'fixtures', 'fake-supabase.sh');

let tmpDir;
let mod;

// Module reads DEPLOY_CONFIG_PATH/SUPABASE_BIN from process.env at module-import
// time → set env BEFORE the dynamic import. SUPABASE_BIN points at a fake CLI
// so runDeploy exercises its phases without a real project. Sharing one tmp
// config path across tests so they can interleave reads/writes; beforeEach
// resets the file content to a known shape.
before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'deploy-test-'));
  process.env.DEPLOY_CONFIG_PATH = join(tmpDir, 'config.json');
  process.env.SUPABASE_BIN = FAKE_SUPABASE;
  // The deploy spawns the CLI with cwd: DEPLOY_APP_DIR (default /app). That dir
  // exists in the container but not on a bare CI runner, where a missing cwd
  // makes spawn fail with `spawn script ENOENT`. Point it at the tmp dir so the
  // phases run regardless of host layout.
  process.env.DEPLOY_APP_DIR = tmpDir;
  mod = await import('../lib/server/deploy-routes.js');
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  mod._resetForTests();
  // Drop any FAKE_SUPABASE_* env from previous tests so each starts clean.
  for (const k of ['FAKE_SUPABASE_EXIT', 'FAKE_SUPABASE_STDERR', 'FAKE_SUPABASE_DELAY_MS', 'FAKE_SUPABASE_LEAK']) {
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

test('POST /api/deploy/configure — first configure still requires secrets', async () => {
  await rm(process.env.DEPLOY_CONFIG_PATH, { force: true });

  const req = makeReq('POST', {
    projectRef: 'abcdefghijklmnopqrst',
    supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
    anonKey: '', serviceRoleKey: '', dbPassword: '', accessToken: '',
  });
  const res = makeRes();
  await mod.handleConfigureDeploy(req, res);
  await res.done;

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'invalid_config');
  // Each missing secret is reported.
  for (const k of ['anonKey', 'serviceRoleKey', 'dbPassword', 'accessToken']) {
    assert.ok(body.errors.some((e) => e.includes(k)), `${k} should be required on first configure`);
  }
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

test('POST /api/deploy/run — 409 when deploy already running', async () => {
  // Seed configured state.
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(validConfig()), { mode: 0o600 });
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
  // settled state. Poll the in-memory flag.
  await new Promise((resolve) => {
    const tick = () => (mod.deployState.running ? setTimeout(tick, 50) : resolve());
    tick();
  });
});

test('POST /api/deploy/run — happy path: tail captures lines, deploy_done fires, lastDeployAt stamped', async () => {
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(validConfig()), { mode: 0o600 });

  const res = makeRes();
  await mod.handleDeployRun(makeReq('POST'), res);
  await res.done;
  assert.equal(res.statusCode, 202);

  // Wait for the child to finish.
  await new Promise((resolve) => {
    const tick = () => (mod.deployState.running ? setTimeout(tick, 30) : resolve());
    tick();
  });

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
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(validConfig()), { mode: 0o600 });
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

    await new Promise((resolve) => {
      const tick = () => (mod.deployState.running ? setTimeout(tick, 30) : resolve());
      tick();
    });
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
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(validConfig()), { mode: 0o600 });
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

    await new Promise((resolve) => {
      const tick = () => (freshMod.deployState.running ? setTimeout(tick, 20) : resolve());
      tick();
    });

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
    JSON.stringify(validConfig({ dbPassword: leakedSecret })),
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
    await new Promise((resolve) => {
      const tick = () => (mod.deployState.running ? setTimeout(tick, 30) : resolve());
      tick();
    });
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
  await writeFile(process.env.DEPLOY_CONFIG_PATH, JSON.stringify(validConfig()), { mode: 0o600 });

  const req = makeSseReq();
  const res = makeSseRes();
  mod.handleDeployEvents(req, res);
  res.chunks.length = 0; // drop the connect snapshot; assert only on live events

  const runRes = makeRes();
  await mod.handleDeployRun(makeReq('POST'), runRes);
  await runRes.done;
  await new Promise((resolve) => {
    const tick = () => (mod.deployState.running ? setTimeout(tick, 30) : resolve());
    tick();
  });

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
  await new Promise((resolve) => {
    const tick = () => (mod.deployState.running ? setTimeout(tick, 30) : resolve());
    tick();
  });
  assert.equal(res.chunks.length, before, 'disconnected client must receive no further frames');
});
