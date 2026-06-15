import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureBgDriverState } from '../lib/server/bg-driver.js';

// The driver state object survives a clear/start cycle because it lives on the
// runtime (ensureBgDriverState is what startBgDriver calls on every (re)start).
// Simulate two cycles and check noProgress accumulates toward give-up.
test('bgDriverState persists noProgress across driver restarts', () => {
  const runtime = {};
  let s = ensureBgDriverState(runtime);
  for (let i = 0; i < 30; i++) s.noProgress += 1;   // first stall window
  s.escalations += 1;                                // escalate at 30
  s.resumed = true;                                  // escalation marks the cycle
  // clearBgDriver + resume turn + startBgDriver:
  s = ensureBgDriverState(runtime);
  assert.equal(s, runtime.bgDriverState);            // same object, not a fresh one
  assert.equal(s.noProgress, 30);                    // NOT reset to 0
  assert.equal(s.resumed, false);                    // each restart allows one new escalation
  for (let i = 0; i < 30; i++) s.noProgress += 1;
  assert.ok(s.noProgress >= 60);                     // give-up now reachable
  assert.equal(s.escalations, 1);
});

test('seenBgCount seeds from the runtime bgResultCount on first init only', () => {
  const runtime = { bgResultCount: 7 };
  const s = ensureBgDriverState(runtime);
  assert.equal(s.seenBgCount, 7);
  runtime.bgResultCount = 12;
  assert.equal(ensureBgDriverState(runtime).seenBgCount, 7); // existing state wins
});
