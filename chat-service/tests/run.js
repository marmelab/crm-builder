#!/usr/bin/env node
// Test runner — connects to chat-service WS, runs cases, compares to baseline.
// Usage:
//   node run.js                                  # run all cases, compare to baseline
//   node run.js --update-baseline                # run all cases, overwrite baseline
//   node run.js --case <id>                      # run a single case by id
//   node run.js --case <id> --from-session <sid> # replay metrics from an existing session log

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import WebSocket from 'ws';
import { captureDiff } from './lib/diff-capture.js';
import { evaluateFileSet } from './lib/evaluate-files.js';
import { runPlaywrightCheck } from './lib/run-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_PATH = join(__dirname, 'cases.json');
const RESULTS_DIR = join(__dirname, 'results');
const BASELINE_PATH = join(RESULTS_DIR, 'baseline.json');
const SESSIONS_DIR = process.env.SESSIONS_DIR || join(__dirname, '..', '..', 'sessions');
const WS_URL = process.env.CHAT_WS_URL || 'ws://localhost:8080';
const CHECKS_DIR = join(__dirname, 'checks');
const CONTAINER = process.env.BENCH_CONTAINER || 'atomic-crm-demo';

const args = process.argv.slice(2);
const caseIdx = args.indexOf('--case');
const sessIdx = args.indexOf('--from-session');
const flags = {
  updateBaseline: args.includes('--update-baseline'),
  caseId: caseIdx >= 0 ? args[caseIdx + 1] : null,
  fromSession: sessIdx >= 0 ? args[sessIdx + 1] : null,
  noReset: args.includes('--no-reset'),
};

function resetCrmSource() {
  try {
    // git checkout reverts src/ — but App.tsx in git is the Supabase-defaulted version,
    // so we re-apply the mode-specific variant after checkout.
    execSync(
      'docker exec -u developer atomic-crm-demo sh -c "' +
        'cd /app && git checkout -- src/ && ' +
        'if [ \\"${MODE:-demo}\\" = \\"demo\\" ]; then ' +
        '  cp /app-variants/App.fakerest.tsx src/App.tsx; ' +
        'else ' +
        '  cp /app-variants/App.supabase.tsx src/App.tsx; ' +
        'fi"',
      { stdio: 'pipe' }
    );
  } catch {
    console.warn('  (warning: could not reset /app/src in container — continuing)');
  }
}

function aggregateFromDebugRaw(metrics, ev) {
  if (ev?.type === 'assistant') {
    for (const block of ev.message?.content || []) {
      if (block.type === 'tool_use') {
        metrics.tools.push(block.name);
        if (block.name === 'Agent' || block.name === 'Task') {
          const sub = block.input?.subagent_type;
          if (sub) metrics.agents.push(sub);
        }
      }
    }
  }
  if (ev?.type === 'result') {
    metrics.turns += ev.num_turns || 0;
    metrics.costUsd += ev.total_cost_usd || 0;
    const u = ev.usage || {};
    metrics.tokensIn += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    metrics.tokensOut += u.output_tokens || 0;
  }
}

function validateExpectations(metrics, exp) {
  if (exp.mustNotInvoke) {
    for (const agent of exp.mustNotInvoke) {
      if (metrics.agents.includes(agent)) {
        metrics.success = false;
        metrics.errors.push(`forbidden agent invoked: ${agent}`);
      }
    }
  }
  if (exp.mustInvoke) {
    for (const agent of exp.mustInvoke) {
      if (!metrics.agents.includes(agent)) {
        metrics.success = false;
        metrics.errors.push(`required agent missing: ${agent}`);
      }
    }
  }
  if (exp.maxDurationMs && metrics.durationMs > exp.maxDurationMs) {
    metrics.success = false;
    metrics.errors.push(`duration ${metrics.durationMs}ms > max ${exp.maxDurationMs}ms`);
  }
  if (exp.maxCostUsd && metrics.costUsd > exp.maxCostUsd) {
    metrics.success = false;
    metrics.errors.push(`cost $${metrics.costUsd.toFixed(3)} > max $${exp.maxCostUsd}`);
  }
}

async function runCaseFromSession(caseDef, sessionId) {
  const logPath = join(SESSIONS_DIR, sessionId, 'log.jsonl');
  if (!existsSync(logPath)) throw new Error(`session log not found: ${logPath}`);
  const lines = (await readFile(logPath, 'utf8')).trim().split('\n');

  const metrics = {
    caseId: caseDef.id,
    category: caseDef.category,
    mode: caseDef.mode,
    durationMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    agents: [],
    tools: [],
    success: true,
    errors: [],
    warnings: [],
    result: { ran: false },
    sessionId,
  };

  let tFirstUser = null;
  let tLastStatusFalse = null;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'user_message' && !tFirstUser) tFirstUser = o.ts;
    if (o.type === 'status' && o.working === false) tLastStatusFalse = o.ts;
    if (o.type === 'debug_raw') aggregateFromDebugRaw(metrics, o.event);
  }
  if (tFirstUser && tLastStatusFalse) {
    metrics.durationMs = new Date(tLastStatusFalse) - new Date(tFirstUser);
  }

  validateExpectations(metrics, caseDef.expect || {});
  return metrics;
}

async function runCase(caseDef) {
  const ws = new WebSocket(WS_URL);
  const metrics = {
    caseId: caseDef.id,
    category: caseDef.category,
    mode: caseDef.mode,
    durationMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    agents: [],
    tools: [],
    success: true,
    errors: [],
  };

  const start = Date.now();
  let waitingForTurn = null;
  const TURN_TIMEOUT_MS = caseDef.expect?.maxDurationMs || 300000;

  const waitForTurn = () => new Promise((resolve, reject) => {
    waitingForTurn = resolve;
    const to = setTimeout(() => {
      waitingForTurn = null;
      reject(new Error(`turn timeout after ${TURN_TIMEOUT_MS / 1000}s`));
    }, TURN_TIMEOUT_MS);
    const wrapped = resolve;
    waitingForTurn = () => { clearTimeout(to); wrapped(); };
  });

  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'debug_raw') aggregateFromDebugRaw(metrics, msg.event);

    if (msg.type === 'status' && msg.working === false && waitingForTurn) {
      const r = waitingForTurn;
      waitingForTurn = null;
      r();
    }
  });

  // Step 1: select mode (triggers orchestrator intro)
  ws.send(JSON.stringify({ content: caseDef.mode === 'full_setup' ? 'FULL_SETUP' : 'QUICK_EDIT' }));
  await waitForTurn();

  // Step 2: send actual prompt
  ws.send(JSON.stringify({ content: caseDef.prompt }));
  await waitForTurn();

  metrics.durationMs = Date.now() - start;
  ws.close();

  metrics.warnings = [];
  metrics.result = { ran: false };

  let diff = null;
  try {
    diff = captureDiff(CONTAINER);
    metrics.diffStats = diff.numstat;
    metrics.modifiedFiles = diff.files;
  } catch (err) {
    metrics.warnings.push(`A: capture failed — ${err.message}`);
  }

  if (diff) {
    const { warnings } = evaluateFileSet(diff, caseDef.expect || {});
    metrics.warnings.push(...warnings);
  }

  try {
    metrics.result = await runPlaywrightCheck(caseDef.id, { checksDir: CHECKS_DIR });
    if (metrics.result.ran && !metrics.result.success) {
      metrics.success = false;
      metrics.errors.push(`C (Playwright): ${metrics.result.error}`);
    }
  } catch (err) {
    metrics.success = false;
    metrics.errors.push(`C (Playwright runner): ${err.message}`);
  }

  if (diff) metrics.patch = diff.patch;

  validateExpectations(metrics, caseDef.expect || {});
  return metrics;
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtDelta(before, after, unit = '', invert = false) {
  if (before == null) return after.toFixed ? after.toFixed(2) + unit : after + unit;
  const pct = ((after - before) / before) * 100;
  const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '=';
  const good = invert ? pct > 0 : pct < 0;
  const color = Math.abs(pct) < 5 ? '' : (good ? '\x1b[32m' : '\x1b[31m');
  const reset = '\x1b[0m';
  return `${color}${arrow}${Math.abs(pct).toFixed(0)}%${reset}`;
}

function compareWithBaseline(run, baseline) {
  if (!baseline) {
    console.log('\nNo baseline yet. Run with --update-baseline to create one.\n');
    return;
  }

  console.log(`\nComparison vs baseline (${baseline.ts}):\n`);
  const header = 'Case'.padEnd(28) + 'Duration'.padEnd(18) + 'Cost'.padEnd(18) + 'Tokens in'.padEnd(18) + 'Result'.padEnd(10);
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const current of run.cases) {
    const prev = baseline.cases.find((c) => c.caseId === current.caseId);
    const name = current.caseId.padEnd(26);
    if (!prev) {
      console.log(`${name}  (new)`);
      continue;
    }
    if (prev.durationMs == null || current.durationMs == null) {
      const status = current.success ? 'OK' : 'FAIL';
      console.log(`${name}  (incomplete data — current ${status})`);
      continue;
    }
    const dur = `${(prev.durationMs / 1000).toFixed(1)}s → ${(current.durationMs / 1000).toFixed(1)}s ${fmtDelta(prev.durationMs, current.durationMs)}`;
    const cost = `$${prev.costUsd.toFixed(3)} → $${current.costUsd.toFixed(3)} ${fmtDelta(prev.costUsd, current.costUsd)}`;
    const tks = `${formatTokens(prev.tokensIn)} → ${formatTokens(current.tokensIn)} ${fmtDelta(prev.tokensIn, current.tokensIn)}`;
    const resultCol = current.result?.ran
      ? (current.result.success ? 'OK' : 'FAIL')
      : '–';
    console.log(`${name}  ${dur.padEnd(26)}${cost.padEnd(26)}${tks.padEnd(26)}${resultCol}`);
  }
  console.log();
}

async function main() {
  const cases = JSON.parse(await readFile(CASES_PATH, 'utf8'));
  const toRun = flags.caseId ? cases.filter((c) => c.id === flags.caseId) : cases;
  if (toRun.length === 0) {
    console.error(`No cases to run (id: ${flags.caseId})`);
    process.exit(1);
  }
  if (flags.fromSession && !flags.caseId) {
    console.error('--from-session requires --case <id>');
    process.exit(1);
  }

  const mode = flags.fromSession ? `replaying session ${flags.fromSession}` : `against ${WS_URL}`;
  console.log(`Running ${toRun.length} case(s) ${mode}...\n`);

  const results = [];
  for (let i = 0; i < toRun.length; i++) {
    const c = toRun[i];
    process.stdout.write(`[${i + 1}/${toRun.length}] ${c.id.padEnd(30)} `);
    if (!flags.noReset && !flags.fromSession) resetCrmSource();
    try {
      const m = flags.fromSession
        ? await runCaseFromSession(c, flags.fromSession)
        : await runCase(c);
      results.push(m);
      const status = m.success ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`${status} (${(m.durationMs / 1000).toFixed(1)}s, $${m.costUsd.toFixed(3)}, ${formatTokens(m.tokensIn)} in, agents: ${m.agents.join(',') || '-'})`);
      const resultLabel = m.result?.ran
        ? (m.result.success ? '\x1b[32mOK\x1b[0m (Playwright)' : `\x1b[31mFAIL\x1b[0m — ${m.result.error}`)
        : '–';
      console.log(`      result: ${resultLabel}`);
      if (!m.success) m.errors.forEach((e) => console.log(`      - ${e}`));
      if (m.warnings?.length) m.warnings.forEach((w) => console.log(`      \x1b[33mWARN\x1b[0m ${w}`));
    } catch (err) {
      console.log(`\x1b[31mERROR\x1b[0m: ${err.message}`);
      results.push({ caseId: c.id, success: false, errors: [err.message] });
    }
  }

  const run = { ts: new Date().toISOString(), cases: results };

  await mkdir(RESULTS_DIR, { recursive: true });
  const runPath = join(RESULTS_DIR, `run-${run.ts.replace(/[:.]/g, '-')}.json`);
  await writeFile(runPath, JSON.stringify(run, null, 2));
  console.log(`\nResults saved: ${runPath}`);

  const patchDir = join(RESULTS_DIR, run.ts.replace(/[:.]/g, '-'));
  await mkdir(patchDir, { recursive: true });
  for (const c of results) {
    if (c.patch) {
      await writeFile(join(patchDir, `${c.caseId}.patch`), c.patch);
      delete c.patch;
    }
  }

  let baseline = null;
  if (existsSync(BASELINE_PATH)) {
    baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  }

  compareWithBaseline(run, baseline);

  if (flags.updateBaseline) {
    await writeFile(BASELINE_PATH, JSON.stringify(run, null, 2));
    console.log(`Baseline updated: ${BASELINE_PATH}\n`);
  }

  const failed = results.filter((r) => !r.success);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
