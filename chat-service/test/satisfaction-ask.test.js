import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSatisfactionMarker } from '../lib/server/turn.js';

test('percent sign inside a field does not break the match', () => {
  const text = 'Done!\n%%ASK_SATISFACTION|Preview ready|Vos changements sont prets a 100 %|Oui|Non%%';
  const r = parseSatisfactionMarker(text);
  assert.ok(r);
  assert.equal(r.payload.body, 'Vos changements sont prets a 100 %');
  assert.equal(r.cleanText, 'Done!');
});

test('extra pipes fold into the last field instead of shifting', () => {
  const text = '%%ASK_SATISFACTION|H|B|Yes|No | rather not%%';
  const r = parseSatisfactionMarker(text);
  assert.equal(r.payload.no, 'No | rather not');
});

test('bare marker still parses with defaults', () => {
  const r = parseSatisfactionMarker('ok %%ASK_SATISFACTION%%');
  assert.ok(r);
  assert.equal(r.payload.yes, 'Yes, save the changes');
});
