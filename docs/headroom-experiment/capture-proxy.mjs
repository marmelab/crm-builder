#!/usr/bin/env node
// capture-proxy.mjs — transparent logging reverse proxy for Anthropic traffic.
//
// Purpose: prove on REAL Claude-SDK traffic that (a) the SDK moves its
// `cache_control` breakpoints within the prompt prefix every turn, and that
// (b) Headroom cache mode's byte-exact guard would therefore bail to
// passthrough every turn. This proxy only needs to capture what the Claude
// process SENDS — it forwards straight to api.anthropic.com (Headroom does not
// need to be in the loop for this study).
//
// Usage:
//   CAPTURE_OUT=captured-requests.jsonl CAPTURE_PORT=9000 node capture-proxy.mjs
// then point the builder at it:
//   ANTHROPIC_BASE_URL=http://<host>:9000
// Auth headers (OAuth bearer / x-api-key) are passed through unchanged.

import http from 'node:http';
import https from 'node:https';
import { appendFileSync } from 'node:fs';

const PORT = Number(process.env.CAPTURE_PORT || 9000);
const UPSTREAM = process.env.CAPTURE_UPSTREAM || 'api.anthropic.com';
const OUT = process.env.CAPTURE_OUT || 'captured-requests.jsonl';

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    // Log only the JSON /v1/messages requests — that's the prompt we analyse.
    if (req.url.includes('/v1/messages') && body.length) {
      try {
        const json = JSON.parse(body.toString('utf8'));
        appendFileSync(
          OUT,
          JSON.stringify({ ts: Date.now(), path: req.url, body: json }) + '\n',
        );
      } catch {
        /* non-JSON body — skip logging, still forward */
      }
    }

    const headers = { ...req.headers, host: UPSTREAM };
    if (body.length) headers['content-length'] = String(body.length);
    else delete headers['content-length'];

    const up = https.request(
      { host: UPSTREAM, path: req.url, method: req.method, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res); // stream the (possibly SSE) response back verbatim
      },
    );
    up.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('capture-proxy upstream error: ' + e.message);
    });
    if (body.length) up.write(body);
    up.end();
  });
}).listen(PORT, () => {
  console.log(`capture-proxy on :${PORT} → https://${UPSTREAM}  (logging → ${OUT})`);
});
