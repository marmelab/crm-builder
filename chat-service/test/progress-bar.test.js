import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateProgressBar, flowExpectedForTickets, predictedFlowExpected } from '../lib/server/progress-bar.ts';

// updateProgressBar broadcasts/sends a payload; capture it through a fake ws.
function payloadFor(stats) {
  let captured = null;
  const fakeWs = { readyState: 1, OPEN: 1, send: (s) => { captured = JSON.parse(s); } };
  updateProgressBar({ stats: { durationScale: 1, ...stats } }, fakeWs);
  return captured;
}
const stepsFor = (stats) => payloadFor(stats).steps;

// The gap-free invariant: a progress bar reads left→right as a single advancing
// frontier — every `done` segment precedes every non-done one, and at most ONE
// segment is `in_progress` at a time. Anything else paints a visible hole.
function assertGapFree(steps, label) {
  const statuses = steps.map((s) => s.status);
  const inProgress = statuses.filter((s) => s === 'in_progress').length;
  assert.ok(inProgress <= 1, `${label}: expected ≤1 in_progress, got ${inProgress} — ${statuses.join(',')}`);

  let seenNonDone = false;
  let seenPending = false;
  for (const status of statuses) {
    if (status === 'done') {
      assert.ok(!seenNonDone, `${label}: a 'done' segment follows a non-done one — gap — ${statuses.join(',')}`);
    } else if (status === 'in_progress') {
      seenNonDone = true;
      assert.ok(!seenPending, `${label}: 'in_progress' follows a 'pending' one — gap — ${statuses.join(',')}`);
    } else {
      seenNonDone = true;
      seenPending = true;
    }
  }
}

// A real COMPLEX wave dispatches interleaved by ticket (agent-team SKILL.md):
// developer-TASK-001, quality-reviewer-TASK-001, test-validator-TASK-001,
// developer-TASK-002, ... — NOT grouped by role.
const interleavedWave = (tickets) => {
  const out = [];
  for (let i = 0; i < tickets; i++) out.push('developer', 'quality-reviewer', 'test-validator');
  return out;
};

test('interleaved 3-ticket wave, planner done, full wave in flight — no gaps', () => {
  const steps = stepsFor({
    dispatchedSubagentTypes: ['planner', ...interleavedWave(3)],
    agentsCompleted: 1,
    flowExpected: flowExpectedForTickets(3, 1),
    waveSizes: [3],
  });
  assertGapFree(steps, 'interleaved full wave');
});

test('interleaved wave, 3 developers completed out of order — no gaps', () => {
  const steps = stepsFor({
    dispatchedSubagentTypes: ['planner', ...interleavedWave(3)],
    agentsCompleted: 4, // planner + 3 devs
    flowExpected: flowExpectedForTickets(3, 1),
    waveSizes: [3],
  });
  assertGapFree(steps, 'interleaved 3 devs done');
});

test('multi-wave COMPLEX (3 waves) mid-flight — no gaps', () => {
  const dispatched = [
    'planner',
    'developer', 'quality-reviewer', 'test-validator', 'merger',
    'developer', 'quality-reviewer', 'test-validator', 'developer', 'quality-reviewer', 'test-validator',
  ];
  const steps = stepsFor({
    dispatchedSubagentTypes: dispatched,
    agentsCompleted: 5,
    flowExpected: flowExpectedForTickets(4, 3),
    waveSizes: [1, 2, 1],
  });
  assertGapFree(steps, 'multi-wave mid-flight');
});

test('SIMPLE flow (simple-developer → merger) — no gaps', () => {
  const expected = predictedFlowExpected('simple-developer'); // 2
  for (let completed = 0; completed <= 1; completed++) {
    const steps = stepsFor({ dispatchedSubagentTypes: ['simple-developer'], agentsCompleted: completed, flowExpected: expected });
    assertGapFree(steps, `simple completed=${completed}`);
  }
});

test('total unknown → indeterminate (no determinate fill that would recede)', () => {
  // Nothing dispatched yet (flow undecided).
  let p = payloadFor({ dispatchedSubagentTypes: [], agentsCompleted: 0, flowExpected: 0 });
  assert.equal(p.indeterminate, true, 'turn start should be indeterminate');
  assert.equal(p.done, 0);

  // COMPLEX planner running but waves not yet revealed.
  p = payloadFor({ dispatchedSubagentTypes: ['planner'], agentsCompleted: 0, flowExpected: predictedFlowExpected('planner') });
  assert.equal(p.indeterminate, true, 'planner-before-waveSizes should be indeterminate');
});

test('topology known → determinate (not indeterminate)', () => {
  // SIMPLE flow is known from the first dispatch.
  let p = payloadFor({ dispatchedSubagentTypes: ['simple-developer'], agentsCompleted: 0, flowExpected: predictedFlowExpected('simple-developer') });
  assert.ok(!p.indeterminate, 'SIMPLE should be determinate');
  assert.ok(p.steps.length >= 1);

  // COMPLEX once waveSizes is set.
  p = payloadFor({ dispatchedSubagentTypes: ['planner'], agentsCompleted: 1, flowExpected: flowExpectedForTickets(3, 1), waveSizes: [3] });
  assert.ok(!p.indeterminate, 'COMPLEX with waveSizes should be determinate');
});

// Regression guard for the "gros retour en arrière" report: once the wave
// topology is known, the segment layout must stay byte-for-byte stable as agents
// dispatch and complete — only statuses advance. A changing segment COUNT forces
// the client to recreate elements and re-animate done segments from empty
// (whole-bar backward flash); changing block SIZES makes the frontier recede.
function fullCompletionFrames(waveSizes) {
  const flowExpected = flowExpectedForTickets(waveSizes.reduce((a, b) => a + b, 0), waveSizes.length);
  const dispatched = ['planner'];
  for (const size of waveSizes) {
    for (let i = 0; i < size; i++) dispatched.push('developer', 'quality-reviewer', 'test-validator');
    dispatched.push('merger');
  }
  const frames = [];
  for (let completed = 1; completed <= dispatched.length; completed++) {
    frames.push(payloadFor({
      dispatchedSubagentTypes: dispatched.slice(0, /* all known up front */ dispatched.length),
      agentsCompleted: completed,
      flowExpected,
      waveSizes,
    }));
  }
  return frames;
}

for (const waveSizes of [[3], [1, 2, 1], [2, 2]]) {
  test(`stable topology across full run — waveSizes=${JSON.stringify(waveSizes)}`, () => {
    const frames = fullCompletionFrames(waveSizes);
    const shape = (p) => p.steps.map((s) => `${s.role}:${s.durationMs}`).join('|');
    const baseShape = shape(frames[0]);
    let prevDone = -1;
    for (const p of frames) {
      assertGapFree(p.steps, `waveSizes=${JSON.stringify(waveSizes)}`);
      // Segment count + per-segment role/duration never change — only statuses.
      assert.equal(p.steps.length, frames[0].steps.length, 'segment count changed mid-run');
      assert.equal(shape(p), baseShape, 'segment roles/sizes changed mid-run');
      // `done` is monotonic non-decreasing — the frontier never recedes.
      assert.ok(p.done >= prevDone, `done went backward: ${prevDone} → ${p.done}`);
      prevDone = p.done;
    }
  });
}

test('first wave block is sized to its own tickets, not the whole flow', () => {
  // waveSizes=[1,2,1]: the developer block of wave 1 must represent 1 developer,
  // not all 4 — otherwise it over-fills then recedes when later waves appear.
  const steps = stepsFor({
    dispatchedSubagentTypes: ['planner'],
    agentsCompleted: 1,
    flowExpected: flowExpectedForTickets(4, 3),
    waveSizes: [1, 2, 1],
  });
  const devBlocks = steps.filter((s) => s.role === 'developer');
  assert.equal(devBlocks.length, 3, 'expected one developer block per wave');
  // wave2 has 2 tickets so its developer block must be wider than wave1's (1 ticket).
  assert.ok(devBlocks[1].durationMs > devBlocks[0].durationMs, 'wave2 dev block should be wider than wave1');
});
