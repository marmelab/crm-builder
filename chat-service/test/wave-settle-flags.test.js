import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWaveFlagsOnTurnSettle, progressBarLive } from '../lib/server/bg-driver.js';

// Both branches of the active-turn `finally` settle path must go through this
// helper so the wave flags can never desync from the settle decision.

test('REGRESSION: a wave that finished on an AUTO_CONTINUE turn clears waveActive on settle', () => {
  // Session 94bbf581: the wave's last turn was a heartbeat AUTO_CONTINUE
  // (processMessage only clears waveActive on non-auto turns), so the flag was
  // still true when the turn's finally found pending=0 and settled `completed`.
  // The old code never cleared it on that path → every later user message hit
  // the `r.busy || r.waveActive` guard in server.js and queued forever.
  const runtime = { waveActive: true, bgDriverState: { noProgress: 3 }, session: { id: 's-1' } };
  applyWaveFlagsOnTurnSettle(runtime, false);
  assert.equal(runtime.waveActive, false, 'settled wave must release the queue guard');
  assert.equal(runtime.bgDriverState, null);
});

test('a wave still in flight keeps (or sets) waveActive so the bg driver owns it', () => {
  const runtime = { waveActive: false, bgDriverState: null, session: { id: 's-2' } };
  applyWaveFlagsOnTurnSettle(runtime, true);
  assert.equal(runtime.waveActive, true);
});

// Progress re-renders from PTY events are gated on a live turn or wave: a
// background_result landing after the session settled (e.g. the documentator
// dispatched at PD-RESPOND finishing a minute later) must NOT resurrect a
// stale progress bar in the UI.
test('REGRESSION: progress bar is not re-rendered by post-settle background results', () => {
  const settled = { busy: false, waveActive: false };
  assert.equal(progressBarLive(settled), false);
});

test('progress bar stays live during an active turn and during a background wave', () => {
  assert.equal(progressBarLive({ busy: true, waveActive: false }), true);
  assert.equal(progressBarLive({ busy: false, waveActive: true }), true);
});
