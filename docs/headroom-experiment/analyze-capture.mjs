#!/usr/bin/env node
// analyze-capture.mjs — replay Headroom's cache-mode guard against captured
// Claude-SDK requests, and check, per consecutive same-session pair:
//   1. did the `cache_control` marker move within the prefix?
//   2. would `_extract_cache_stable_delta` return None (passthrough) or a delta?
//
// Usage: node analyze-capture.mjs captured-requests.jsonl
//
// The guard below is a faithful replica of
// AnthropicHandlerMixin._extract_cache_stable_delta (headroom/proxy/handlers/anthropic.py),
// and the session key mirrors SessionTrackerStore.compute_session_id
// (headroom/cache/prefix_tracker.py): md5(`${model}:${system[:500]}`)[:16].

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = process.argv[2] || 'captured-requests.jsonl';
const reqs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).body);

const sysText = (s) =>
  typeof s === 'string' ? s : Array.isArray(s) ? s.map((b) => b?.text || '').join('') : '';
const sessionKey = (b) =>
  createHash('md5').update(`${b.model}:${sysText(b.system).slice(0, 500)}`).digest('hex').slice(0, 16);

// indices of messages whose content carries a cache_control breakpoint
const markers = (messages = []) =>
  messages.flatMap((m, i) =>
    Array.isArray(m.content) && m.content.some((c) => c && c.cache_control) ? [i] : [],
  );

// faithful replica of the guard: exact prefix equality of the leading messages
function guard(cur = [], prev = []) {
  if (!prev.length) return 'no-prev';
  if (cur.length < prev.length) return 'None';
  return JSON.stringify(cur.slice(0, prev.length)) === JSON.stringify(prev) ? 'DELTA' : 'None';
}

const groups = {};
for (const b of reqs) (groups[sessionKey(b)] ||= []).push(b);

let pairs = 0, passthrough = 0, moved = 0;
for (const [k, seq] of Object.entries(groups)) {
  console.log(`\nsession ${k} — ${seq.length} requests (model=${seq[0].model})`);
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1].messages || [];
    const cur = seq[i].messages || [];
    const mp = markers(prev);
    const mc = markers(cur);
    const g = guard(cur, prev);
    const prefixMarkersBefore = JSON.stringify(mp);
    const prefixMarkersAfter = JSON.stringify(mc.filter((x) => x < prev.length));
    const mv = prefixMarkersBefore !== prefixMarkersAfter;
    pairs++; if (g === 'None') passthrough++; if (mv) moved++;
    console.log(
      `  turn ${i}: msgs ${prev.length}→${cur.length} | markers prev=${prefixMarkersBefore} cur=${JSON.stringify(mc)}` +
      ` | prefix marker moved=${mv} | guard=${g}`,
    );
  }
}
console.log(
  `\n=== SUMMARY: guard=None (passthrough) on ${passthrough}/${pairs} consecutive pairs;` +
  ` prefix marker moved on ${moved}/${pairs}. ===`,
);
console.log('Expectation if the hypothesis holds: both ratios ≈ all pairs.');
