import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTicketStatuses } from '../lib/server/auto-continue.js';

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
