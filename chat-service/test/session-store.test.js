import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestLog } from '../lib/server/session-store.js';

// Helpers — keep fixtures inline so each test is self-describing.
const userMessage = (content, ts = '2026-04-30T12:00:00.000Z') =>
  JSON.stringify({ ts, dir: 'in', type: 'user_message', content });

const assistantMessage = (content, ts = '2026-04-30T12:00:01.000Z') =>
  JSON.stringify({ ts, dir: 'out', type: 'message', role: 'assistant', content });

const resultEvent = (usage, totalCost, ts = '2026-04-30T12:00:02.000Z') => JSON.stringify({
  ts, dir: 'out', type: 'debug_raw',
  event: { type: 'result', usage, total_cost_usd: totalCost },
});

test('digestLog: tokensUsed sums input + cache_creation + output, EXCLUDES cache_read', () => {
  const log = [
    resultEvent({
      input_tokens: 100,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 5000, // must be ignored
      output_tokens: 50,
    }, 0.01),
  ].join('\n');

  const { stats } = digestLog(log);
  assert.equal(stats.tokensUsed, 350);
  assert.equal(stats.costUsd, 0.01);
});

test('digestLog: single spawn — costUsd is the spawn max (cumulative grows monotonically)', () => {
  // total_cost_usd is cumulative WITHIN a spawn. Multiple result events
  // within the same spawn report a monotonically growing running total.
  // Use the spawn's final max — summing each event would over-count by N×.
  const log = [
    resultEvent({ input_tokens: 10, cache_creation_input_tokens: 20, output_tokens: 5 }, 0.001),
    resultEvent({ input_tokens: 30, cache_creation_input_tokens: 40, output_tokens: 15 }, 0.005),
    resultEvent({ input_tokens: 0,  cache_creation_input_tokens: 0,  output_tokens: 100 }, 0.007),
  ].join('\n');

  const { stats } = digestLog(log);
  // No modelUsage in fixtures → falls back to summing per-turn result.usage.
  assert.equal(stats.tokensUsed, 10 + 20 + 5 + 30 + 40 + 15 + 100);
  assert.ok(Math.abs(stats.costUsd - 0.007) < 1e-9);
});

test('digestLog: multi-spawn — costUsd is the SUM of per-spawn maxes (decrease = new spawn)', () => {
  // Each --resume creates a new claude -p process; total_cost_usd resets to 0.
  // A decrease in total_cost_usd signals a new spawn. Three spawns ending at
  // 0.5, 0.3, 0.8 → total $1.60 (not $0.80, which would be the global max).
  const log = [
    resultEvent({ input_tokens: 1, output_tokens: 1 }, 0.2),
    resultEvent({ input_tokens: 1, output_tokens: 1 }, 0.5),  // spawn 1 max
    resultEvent({ input_tokens: 1, output_tokens: 1 }, 0.1),  // ← decrease → new spawn
    resultEvent({ input_tokens: 1, output_tokens: 1 }, 0.3),  // spawn 2 max
    resultEvent({ input_tokens: 1, output_tokens: 1 }, 0.05), // ← decrease → new spawn
    resultEvent({ input_tokens: 1, output_tokens: 1 }, 0.8),  // spawn 3 max
  ].join('\n');

  const { stats } = digestLog(log);
  assert.ok(Math.abs(stats.costUsd - (0.5 + 0.3 + 0.8)) < 1e-9, `expected $1.60, got $${stats.costUsd}`);
});

test('digestLog: tokens come from modelUsage (cumulative, includes sub-agents) when present', () => {
  // modelUsage is the cumulative-within-spawn token breakdown; result.usage
  // alone misses sub-agent activations. Prefer modelUsage when present.
  const resultWithModelUsage = (modelUsage, totalCost) => JSON.stringify({
    ts: '2026-04-30T12:00:02.000Z', dir: 'out', type: 'debug_raw',
    event: { type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, modelUsage, total_cost_usd: totalCost },
  });
  const log = [
    resultWithModelUsage({
      'claude-sonnet-4-6': { inputTokens: 100, cacheCreationInputTokens: 200, cacheReadInputTokens: 9999, outputTokens: 50 },
      'claude-opus-4-6':   { inputTokens: 10,  cacheCreationInputTokens: 20,  cacheReadInputTokens: 9999, outputTokens: 5 },
    }, 0.1),
  ].join('\n');

  const { stats } = digestLog(log);
  // 100+200+50 + 10+20+5 = 385. cache_read excluded by design.
  assert.equal(stats.tokensUsed, 385);
});

test('digestLog: user_message events are the primary spawn boundary (regression: cost-decrease heuristic absorbed small spawns when successor cost > predecessor max)', () => {
  // Observed on session d0ebd234: 4 user turns with spawn maxes
  // [$11.5753, $0.1973, $0.0522, $11.4629]. The pre-fix cost-decrease
  // heuristic missed the spawn 3 → spawn 4 boundary because spawn 4's first
  // result ($3.27) landed above spawn 3's max ($0.05), so spawn 3 was
  // silently absorbed and its $0.052 disappeared from the total. With
  // user_message-driven boundaries the missing $0.052 is recovered.
  const um = (ts) => JSON.stringify({ ts, dir: 'in', type: 'user_message', content: 'x' });
  const r  = (ts, cost) => JSON.stringify({
    ts, dir: 'out', type: 'debug_raw',
    event: { type: 'result', total_cost_usd: cost, usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const log = [
    um('2026-05-11T13:48:20Z'),
    r('2026-05-11T13:50:00Z', 11.5753),
    um('2026-05-11T14:19:21Z'),
    r('2026-05-11T14:19:54Z', 0.1973),
    um('2026-05-11T14:20:09Z'),
    r('2026-05-11T14:20:34Z', 0.0522),
    um('2026-05-11T14:24:46Z'),
    r('2026-05-11T14:32:58Z', 3.2753),  // intra-spawn growth, NOT a new spawn
    r('2026-05-11T14:47:21Z', 11.4629),
  ].join('\n');

  const expected = 11.5753 + 0.1973 + 0.0522 + 11.4629;
  const { stats } = digestLog(log);
  assert.ok(
    Math.abs(stats.costUsd - expected) < 1e-9,
    `expected $${expected.toFixed(4)}, got $${stats.costUsd.toFixed(4)} — spawn 3 was likely absorbed`,
  );
});

test('digestLog: stats.tokensBreakdown carries the 4-way per-component split', () => {
  const log = JSON.stringify({
    ts: '2026-04-30T12:00:00Z', dir: 'out', type: 'debug_raw',
    event: {
      type: 'result',
      total_cost_usd: 0.5,
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 100, cacheCreationInputTokens: 200, cacheReadInputTokens: 5000, outputTokens: 50 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const { stats } = digestLog(log);
  assert.deepEqual(stats.tokensBreakdown, { input: 100, cacheCreate: 200, output: 50, cacheRead: 5000 });
  // tokensUsed remains the legacy figure (cache_read excluded).
  assert.equal(stats.tokensUsed, 350);
});

test('digestLog: skips malformed JSON lines without crashing', () => {
  const log = [
    userMessage('Hello'),
    'not-valid-json',
    '{ "broken": ',
    '',
    assistantMessage('Hi there'),
  ].join('\n');

  const { messages, stats } = digestLog(log);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'Hello');
  assert.equal(messages[1].content, 'Hi there');
  assert.equal(stats.tokensUsed, 0);
  assert.equal(stats.costUsd, 0);
});

test('digestLog: extracts user/assistant messages and returns zeroed stats when no result events', () => {
  const log = [
    userMessage('First question'),
    assistantMessage('First answer'),
    userMessage('Second question', '2026-04-30T12:01:00.000Z'),
  ].join('\n');

  const { messages, stats } = digestLog(log);
  assert.deepEqual(
    messages.map((m) => ({ role: m.role, content: m.content })),
    [
      { role: 'user',      content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user',      content: 'Second question' },
    ],
  );
  assert.equal(stats.tokensUsed, 0);
  assert.equal(stats.costUsd, 0);
});

test('digestLog: prefers user_message.display over .content (choice button label)', () => {
  // Choice clicks send `content: 'FULL_SETUP'` for the orchestrator and
  // `display: '🗺️ Set up...'` for the chat bubble — the digest must surface
  // the human-readable label, not the routing token.
  const log = JSON.stringify({
    ts: '2026-04-30T12:00:00.000Z', dir: 'in', type: 'user_message',
    content: 'FULL_SETUP', display: '🗺️  Set up my CRM from scratch',
  });

  const { messages } = digestLog(log);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '🗺️  Set up my CRM from scratch');
});

test('digestLog: recentDebug accumulates across turns (no reset on user_message)', () => {
  const debugRaw = (event, ts = '2026-04-30T12:00:00.000Z') =>
    JSON.stringify({ ts, dir: 'out', type: 'debug_raw', event });
  const debugTool = (tool, input, agent, ts = '2026-04-30T12:00:00.000Z') =>
    JSON.stringify({ ts, dir: 'out', type: 'debug', tool, input, agent });

  const log = [
    userMessage('Q1'),
    debugRaw({ type: 'assistant', content: 'thinking' }),
    debugTool('Bash', { command: 'ls' }, 'developer'),
    assistantMessage('A1'),
    userMessage('Q2', '2026-04-30T12:01:00.000Z'),
    debugRaw({ type: 'assistant', content: 'thinking again' }),
  ].join('\n');

  const { recentDebug } = digestLog(log);
  // All three debug events from both turns should be kept (cap is per-session,
  // not per-turn), in chronological order.
  assert.equal(recentDebug.length, 3);
  assert.equal(recentDebug[0].type, 'debug_raw');
  assert.deepEqual(recentDebug[0].event, { type: 'assistant', content: 'thinking' });
  assert.equal(recentDebug[1].type, 'debug');
  assert.equal(recentDebug[1].tool, 'Bash');
  assert.equal(recentDebug[2].type, 'debug_raw');
  assert.deepEqual(recentDebug[2].event, { type: 'assistant', content: 'thinking again' });
});

test('digestLog: recentDebug is capped (sliding window keeps the most recent)', () => {
  const debugRaw = (i) => JSON.stringify({
    ts: `2026-04-30T12:00:${String(i).padStart(2, '0')}.000Z`,
    dir: 'out', type: 'debug_raw', event: { type: 'assistant', i },
  });
  const lines = [];
  // Emit 1100 events → cap should drop the first 100.
  for (let i = 0; i < 1100; i++) lines.push(debugRaw(i));
  const { recentDebug } = digestLog(lines.join('\n'));
  assert.equal(recentDebug.length, 1000);
  assert.equal(recentDebug[0].event.i, 100);
  assert.equal(recentDebug[recentDebug.length - 1].event.i, 1099);
});

test('digestLog: timeline preserves chronological order of messages and debug events', () => {
  const log = [
    JSON.stringify({ ts: '2026-04-30T12:00:00.000Z', dir: 'in', type: 'user_message', content: 'Q1' }),
    JSON.stringify({ ts: '2026-04-30T12:00:01.000Z', dir: 'out', type: 'debug_raw', event: { type: 'assistant', i: 1 } }),
    JSON.stringify({ ts: '2026-04-30T12:00:02.000Z', dir: 'out', type: 'debug', tool: 'Bash', input: { command: 'ls' }, agent: 'developer' }),
    JSON.stringify({ ts: '2026-04-30T12:00:03.000Z', dir: 'out', type: 'message', role: 'assistant', content: 'A1' }),
    JSON.stringify({ ts: '2026-04-30T12:00:04.000Z', dir: 'in', type: 'user_message', content: 'Q2' }),
    JSON.stringify({ ts: '2026-04-30T12:00:05.000Z', dir: 'out', type: 'debug_raw', event: { type: 'assistant', i: 2 } }),
  ].join('\n');

  const { timeline } = digestLog(log);
  assert.deepEqual(
    timeline.map((it) => it.kind === 'message' ? `msg:${it.role}:${it.content}` : `dbg:${it.type}`),
    ['msg:user:Q1', 'dbg:debug_raw', 'dbg:debug', 'msg:assistant:A1', 'msg:user:Q2', 'dbg:debug_raw'],
  );
});

test('digestLog: timeline cap drops oldest debugs but keeps all messages in order', () => {
  const lines = [
    JSON.stringify({ ts: '2026-04-30T12:00:00.000Z', dir: 'in', type: 'user_message', content: 'Q1' }),
  ];
  // 1100 debug events → 100 oldest are dropped from the timeline.
  for (let i = 0; i < 1100; i++) {
    lines.push(JSON.stringify({
      ts: `2026-04-30T13:00:${String(i % 60).padStart(2, '0')}.000Z`,
      dir: 'out', type: 'debug_raw', event: { type: 'assistant', i },
    }));
  }
  lines.push(JSON.stringify({ ts: '2026-04-30T14:00:00.000Z', dir: 'out', type: 'message', role: 'assistant', content: 'A1' }));

  const { timeline } = digestLog(lines.join('\n'));
  const messages = timeline.filter((it) => it.kind === 'message');
  const debugs = timeline.filter((it) => it.kind === 'debug');
  assert.equal(messages.length, 2, 'both messages survive the cap');
  assert.equal(messages[0].content, 'Q1');
  assert.equal(messages[1].content, 'A1');
  assert.equal(debugs.length, 1000, 'cap holds at DEBUG_REPLAY_MAX');
  assert.equal(debugs[0].event.i, 100, 'oldest 100 debugs dropped');
  assert.equal(debugs[debugs.length - 1].event.i, 1099);
  // Q1 must come before any debug; A1 must come after every debug.
  const firstDebugIdx = timeline.findIndex((it) => it.kind === 'debug');
  const lastDebugIdx = timeline.length - 1 - [...timeline].reverse().findIndex((it) => it.kind === 'debug');
  assert.ok(timeline.indexOf(messages[0]) < firstDebugIdx);
  assert.ok(timeline.indexOf(messages[1]) > lastDebugIdx);
});

test('digestLog: recentDebug preserves both debug and debug_raw shapes', () => {
  const log = [
    JSON.stringify({ ts: '2026-04-30T12:00:00.000Z', dir: 'out', type: 'debug', tool: 'Edit', input: { file_path: '/x' }, agent: 'developer' }),
    JSON.stringify({ ts: '2026-04-30T12:00:01.000Z', dir: 'out', type: 'debug_raw', event: { type: 'system', subtype: 'task_started' } }),
  ].join('\n');

  const { recentDebug } = digestLog(log);
  assert.equal(recentDebug.length, 2);
  assert.deepEqual(recentDebug[0], { type: 'debug', tool: 'Edit', input: { file_path: '/x' }, agent: 'developer' });
  assert.deepEqual(recentDebug[1], { type: 'debug_raw', event: { type: 'system', subtype: 'task_started' } });
});
