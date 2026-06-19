// Headroom experiment — WS replay driver.
// Runs INSIDE the instance container (Node 24, global WebSocket).
// Connects to the chat-service, replays an ordered list of user messages
// (one per turn, advancing on each working:false), and prints the sessionId.
//
//   node ws-replay-driver.mjs <messages.json>
//
// Env: WS_URL (default ws://127.0.0.1:8080), TURN_TIMEOUT_MS (default 2700000 = 45min)

import { readFileSync } from 'node:fs';

const MSGS = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8080';
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 2_700_000);

let idx = 0;
let sessionId = null;
let workingSeen = false;   // saw working:true since last send
let sent = false;          // we have sent at least one message
let turnTimer = null;
let done = false;

const log = (...a) => console.log(new Date().toISOString(), ...a);

const ws = new WebSocket(WS_URL);

function armTurnTimer() {
  clearTimeout(turnTimer);
  turnTimer = setTimeout(() => {
    log(`!! TURN TIMEOUT after ${TURN_TIMEOUT_MS}ms on message #${idx} — aborting`);
    finish(2);
  }, TURN_TIMEOUT_MS);
}

function sendNext() {
  if (idx >= MSGS.length) {
    log(`all ${MSGS.length} messages sent — waiting for final completion`);
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
  log(`DONE (sent ${idx}/${MSGS.length} messages) exit=${code}`);
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
      log(`init sessionId=${sessionId} state=${o.state} isNew=${o.isNew}`);
      // kick off the replay
      setTimeout(sendNext, 250);
      break;

    case 'status':
      if (o.working === true) { workingSeen = true; }
      else if (o.working === false && sent && workingSeen) {
        // turn finished -> ready for next input
        if (idx >= MSGS.length) {
          log('last turn finished');
          setTimeout(() => finish(0), 3000);
        } else {
          setTimeout(sendNext, 400);
        }
      }
      break;

    case 'message':
      if (o.role === 'assistant' && o.content) {
        log(`<< assistant: ${o.content.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      break;

    case 'choices':
      log(`<< choices: ${o.options?.map(x => x.label).join(' | ')}`);
      break;

    case 'satisfaction_ask':
      log(`<< satisfaction_ask: ${o.header}`);
      break;

    case 'stats':
      log(`-- stats tokens=${o.tokensTotal} cost=$${(o.costUsd ?? 0).toFixed?.(2)} agents=${o.activeAgents}`);
      break;

    case 'state':
      log(`<< state=${o.state}`);
      if (o.state === 'error') { log('ERROR state — aborting'); finish(4); }
      if (o.state === 'rate_limited') { log('RATE LIMITED — aborting'); finish(5); }
      if (o.state === 'completed' && idx >= MSGS.length) { setTimeout(() => finish(0), 2000); }
      break;
  }
});
