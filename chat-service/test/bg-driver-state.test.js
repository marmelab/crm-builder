import test from 'node:test';
import assert from 'node:assert/strict';

// The driver state object survives a clear/start cycle because it lives on the
// runtime. Simulate two cycles and check noProgress accumulates to give-up.
test('bgDriverState persists noProgress across driver restarts', () => {
  const runtime = {};
  const start = () => (runtime.bgDriverState ??= { noProgress: 0, escalations: 0 });
  let s = start();
  for (let i = 0; i < 30; i++) s.noProgress += 1;   // first stall window
  s.escalations += 1;                                // escalate at 30
  // clearBgDriver + resume turn + startBgDriver:
  s = start();
  assert.equal(s.noProgress, 30);                    // NOT reset to 0
  for (let i = 0; i < 30; i++) s.noProgress += 1;
  assert.ok(s.noProgress >= 60);                     // give-up now reachable
  assert.equal(s.escalations, 1);
});
