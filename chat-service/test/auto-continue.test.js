import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideAutoContinue, readTicketStatuses, MAX_AUTO_CONTINUE, MAX_NO_PROGRESS,
} from '../lib/server/auto-continue.js';

const base = {
  nextState: 'completed',
  turnErrored: false,
  totalTickets: 5,
  pendingCount: 2,
  pendingSig: 'TASK-004:in_progress,TASK-005:pending',
  prevPendingSig: null,
  autoContinueCount: 0,
  noProgressCount: 0,
};

test('continues when tickets are still pending after a clean turn', () => {
  const d = decideAutoContinue(base);
  assert.equal(d.go, true);
  assert.equal(d.waveDone, false);
});

test('does not continue when the turn did not cleanly complete', () => {
  assert.equal(decideAutoContinue({ ...base, nextState: 'waiting' }).go, false);
  assert.equal(decideAutoContinue({ ...base, nextState: 'error' }).go, false);
  assert.equal(decideAutoContinue({ ...base, turnErrored: true }).go, false);
});

test('not a COMPLEX wave (no tickets) → no continue, not waveDone', () => {
  const d = decideAutoContinue({ ...base, totalTickets: 0, pendingCount: 0, pendingSig: '' });
  assert.equal(d.go, false);
  assert.equal(d.waveDone, false);
});

test('all tickets terminal → waveDone (caller runs documentator), no continue', () => {
  const d = decideAutoContinue({ ...base, pendingCount: 0, pendingSig: '' });
  assert.equal(d.go, false);
  assert.equal(d.waveDone, true);
});

test('hard cap stops the loop', () => {
  const d = decideAutoContinue({ ...base, autoContinueCount: MAX_AUTO_CONTINUE });
  assert.equal(d.go, false);
  assert.equal(d.stalled, 'cap');
});

test('resets no-progress counter when the pending set advanced', () => {
  // prev sig differs from current → progress was made
  const d = decideAutoContinue({
    ...base,
    prevPendingSig: 'TASK-003:in_progress,TASK-004:in_progress,TASK-005:pending',
    noProgressCount: 2,
  });
  assert.equal(d.go, true);
  assert.equal(d.noProgressCount, 0);
});

test('stops after MAX_NO_PROGRESS unchanged resumes', () => {
  const sig = base.pendingSig;
  // already at the threshold-1; an unchanged sig pushes it over
  const d = decideAutoContinue({
    ...base,
    prevPendingSig: sig,
    noProgressCount: MAX_NO_PROGRESS - 1,
  });
  assert.equal(d.go, false);
  assert.equal(d.stalled, 'no-progress');
});

test('one unchanged resume still continues (below the no-progress threshold)', () => {
  const sig = base.pendingSig;
  const d = decideAutoContinue({ ...base, prevPendingSig: sig, noProgressCount: 0 });
  assert.equal(d.go, true);
  assert.equal(d.noProgressCount, 1);
});

test('readTicketStatuses classifies merged/failed as terminal, rest as pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-'));
  try {
    writeFileSync(join(dir, 'TASK-001.json'), JSON.stringify({ status: 'merged' }));
    writeFileSync(join(dir, 'TASK-002.json'), JSON.stringify({ status: 'failed' }));
    writeFileSync(join(dir, 'TASK-003.json'), JSON.stringify({ status: 'in_progress' }));
    writeFileSync(join(dir, 'TASK-004.json'), JSON.stringify({ status: 'pending' }));
    // non-ticket files and SIMPLE pseudo-tickets are ignored
    writeFileSync(join(dir, 'TASK-SIMPLE-1.json'), JSON.stringify({ status: 'pending' }));
    writeFileSync(join(dir, 'meta.json'), '{}');

    const { total, pendingCount, pendingSig } = await readTicketStatuses(dir);
    assert.equal(total, 4);
    assert.equal(pendingCount, 2);
    assert.equal(pendingSig, 'TASK-003:in_progress,TASK-004:pending');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTicketStatuses on a missing dir is empty', async () => {
  const { total, pendingCount } = await readTicketStatuses('/no/such/dir/xyz');
  assert.equal(total, 0);
  assert.equal(pendingCount, 0);
});
