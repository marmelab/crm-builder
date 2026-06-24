import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAskState } from '../lib/server/turn.js';

// The orchestrator drops <session_dir>/ask-state.json when it enters STATE
// PD-ASK (satisfaction) or STATE PD-LIVE-ASK (offer to switch to real data).
// parseAskState validates + normalizes that file's contents.

test('satisfaction payload parses with localized labels', () => {
  const r = parseAskState(JSON.stringify({
    kind: 'satisfaction', header: 'Aperçu prêt', body: 'Tout te convient ?', yes: 'Oui', no: 'Non',
  }));
  assert.deepEqual(r, { kind: 'satisfaction', header: 'Aperçu prêt', body: 'Tout te convient ?', yes: 'Oui', no: 'Non' });
});

test('live-switch payload parses', () => {
  const r = parseAskState(JSON.stringify({ kind: 'live-switch', yes: 'Bascule', no: 'Garde la démo' }));
  assert.ok(r);
  assert.equal(r.kind, 'live-switch');
  assert.equal(r.yes, 'Bascule');
  // Optional fields absent → undefined (client fills its localized defaults).
  assert.equal(r.header, undefined);
  assert.equal(r.body, undefined);
});

test('missing/blank optional fields normalize to undefined', () => {
  const r = parseAskState(JSON.stringify({ kind: 'satisfaction', header: '   ', yes: 'Oui' }));
  assert.equal(r.header, undefined);
  assert.equal(r.yes, 'Oui');
  assert.equal(r.no, undefined);
});

test('unknown kind is rejected', () => {
  assert.equal(parseAskState(JSON.stringify({ kind: 'something-else', yes: 'x' })), null);
  assert.equal(parseAskState(JSON.stringify({ yes: 'x' })), null);
});

test('malformed JSON is rejected (consumed silently upstream)', () => {
  assert.equal(parseAskState('not json'), null);
  assert.equal(parseAskState(''), null);
  assert.equal(parseAskState('[1,2,3]'), null);
});
