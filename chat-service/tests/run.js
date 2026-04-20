#!/usr/bin/env node
// Test runner — connects to chat-service WS, runs cases, compares to baseline.
// Usage:
//   node run.js                       # run all cases, compare to baseline
//   node run.js --update-baseline     # run all cases, overwrite baseline
//   node run.js --case <id>           # run a single case by id

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_PATH = join(__dirname, 'cases.json');
const RESULTS_DIR = join(__dirname, 'results');
const BASELINE_PATH = join(RESULTS_DIR, 'baseline.json');
const WS_URL = process.env.CHAT_WS_URL || 'ws://localhost:8080';

const args = process.argv.slice(2);
const caseIdx = args.indexOf('--case');
const flags = {
  updateBaseline: args.includes('--update-baseline'),
  caseId: caseIdx >= 0 ? args[caseIdx + 1] : null,
  noReset: args.includes('--no-reset'),
};

function resetCrmSource() {
  try {
    execSync('docker exec -u developer atomic-crm-demo git -C /app checkout -- src/', { stdio: 'pipe' });
  } catch {
    console.warn('  (warning: could not reset /app/src in container — continuing)');
  }
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

    if (msg.type === 'debug_raw') {
      const ev = msg.event;
      if (ev.type === 'assistant') {
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
      if (ev.type === 'result') {
        metrics.turns += ev.num_turns || 0;
        metrics.costUsd += ev.total_cost_usd || 0;
        const u = ev.usage || {};
        metrics.tokensIn += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        metrics.tokensOut += u.output_tokens || 0;
      }
    }

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

  // Validate expectations
  const exp = caseDef.expect || {};
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
  const header = 'Case'.padEnd(28) + 'Duration'.padEnd(18) + 'Cost'.padEnd(18) + 'Tokens in'.padEnd(18);
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
    console.log(`${name}  ${dur.padEnd(26)}${cost.padEnd(26)}${tks}`);
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

  console.log(`Running ${toRun.length} case(s) against ${WS_URL}...\n`);

  const results = [];
  for (let i = 0; i < toRun.length; i++) {
    const c = toRun[i];
    process.stdout.write(`[${i + 1}/${toRun.length}] ${c.id.padEnd(30)} `);
    if (!flags.noReset) resetCrmSource();
    try {
      const m = await runCase(c);
      results.push(m);
      const status = m.success ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`${status} (${(m.durationMs / 1000).toFixed(1)}s, $${m.costUsd.toFixed(3)}, ${formatTokens(m.tokensIn)} in, agents: ${m.agents.join(',') || '-'})`);
      if (!m.success) m.errors.forEach((e) => console.log(`      - ${e}`));
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
