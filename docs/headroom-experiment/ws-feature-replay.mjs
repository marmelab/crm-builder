// ws-feature-replay.mjs
// Replay a single feature-request message and stop when the satisfaction ask
// appears (before migration). Prints SESSION_ID=<uuid> to stdout.
//
//   node ws-feature-replay.mjs [messages.json]
//
// Env: WS_URL (default ws://127.0.0.1:8080), TURN_TIMEOUT_MS (default 2700000)

import { readFileSync } from 'node:fs';

const msgFile = process.argv[2] || new URL('./feature-messages.json', import.meta.url).pathname;
const MSGS = JSON.parse(readFileSync(msgFile, 'utf8'));
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8080';
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 2_700_000);

let idx = 0;
let sessionId = null;
let workingSeen = false;
let sent = false;
let turnTimer = null;
let done = false;

const log = (...a) => console.log(new Date().toISOString(), ...a);

const ws = new WebSocket(WS_URL);

function armTurnTimer() {
  clearTimeout(turnTimer);
  turnTimer = setTimeout(() => {
    log(`!! TURN TIMEOUT after ${TURN_TIMEOUT_MS}ms — aborting`);
    finish(2);
  }, TURN_TIMEOUT_MS);
}

function sendNext() {
  if (idx >= MSGS.length) {
    log('all messages sent — waiting for satisfaction_ask');
    return;
  }
  const m = MSGS[idx];
  idx++;
  sent = true;
  workingSeen = false;
  const payload = { content: m.content, display: m.display || m.content };
  log(`>> send #${idx}/${MSGS.length}: ${JSON.stringify(m.content).slice(0, 120)}`);
  ws.send(JSON.stringify(payload));
  armTurnTimer();
}

function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(turnTimer);
  log(`SESSION_ID=${sessionId}`);
  log(`DONE exit=${code}`);
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(code), 500);
}

ws.addEventListener('open', () => log('ws open'));
ws.addEventListener('error', (e) => { log('ws error', e.message || e); finish(3); });
ws.addEventListener('close', () => { if (!done) log('ws closed by server'); });

ws.addEventListener('message', (ev) => {
  let o;
  try { o = JSON.parse(ev.data); } catch { return; }

  switch (o.type) {
    case 'init':
      sessionId = o.sessionId;
      log(`init sessionId=${sessionId}`);
      setTimeout(sendNext, 250);
      break;

    case 'status':
      if (o.working === true) { workingSeen = true; }
      else if (o.working === false && sent && workingSeen) {
        if (idx >= MSGS.length) {
          // All messages sent and turn finished — keep waiting for satisfaction_ask
          log('turn complete — waiting for satisfaction_ask');
          armTurnTimer();
        } else {
          setTimeout(sendNext, 400);
        }
      }
      break;

    case 'satisfaction_ask':
      log(`<< satisfaction_ask received: "${o.header}" — stopping (no reply)`);
      finish(0);
      break;

    case 'state':
      log(`<< state=${o.state}`);
      if (o.state === 'error') { log('ERROR state — aborting'); finish(4); }
      if (o.state === 'rate_limited') { log('RATE LIMITED — aborting'); finish(5); }
      break;

    case 'message':
      if (o.role === 'assistant' && o.content) {
        log(`<< assistant: ${o.content.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      break;

    case 'stats':
      log(`-- tokens=${o.tokensTotal} cost=$${(o.costUsd ?? 0).toFixed?.(2)} agents=${o.activeAgents}`);
      break;
  }
});
