# Headroom experiment — results

**Date:** 2026-06-16 · **Branch:** `feat/headroom` · **Verdict: token mode costs ~25% MORE on this workload.**

See the design in [superpowers/specs/2026-06-16-headroom-experiment-design.md](superpowers/specs/2026-06-16-headroom-experiment-design.md).

## TL;DR

[Headroom](https://headroom-docs.vercel.app) is an LLM context-compression proxy. We routed the
project's `claude` traffic through it (`ANTHROPIC_BASE_URL`) in **token mode** (max compression) and
replayed a full "from scratch" CRM build, comparing against the same build run without the proxy.

**On a workload that already lives on Anthropic prompt caching, token-mode compression is
counterproductive: it broke the cache and cost ~25% more.** Headroom's own `/stats` reports a
+17% "saving" — but that figure is measured against a cache-blind hypothetical and is wrong here.

## Setup

- Dedicated instance `atomic-crm-headroom` (CRM 5177 / chat 8087), built from `feat/headroom`,
  DEMO mode, **OAuth subscription** auth (shared `claude-auth` volume). The main `atomic-crm`
  instance was untouched.
- Headroom proxy: `ghcr.io/chopratejas/headroom:latest`, `--mode token --no-telemetry
  --no-subscription-tracking`, published on the host `:8787`, reached from the instance via
  `host.docker.internal` (see `docker-compose.headroom.yml`).
- **No code change needed**: `pty-session.js` already spreads `process.env` into every `claude`
  spawn, so setting `ANTHROPIC_BASE_URL` transparently routes the orchestrator *and* all subagents
  (planner, opus developers, reviewers, merger) through the proxy.
- Feasibility gate (OAuth Bearer passthrough): **PASS** — `claude --print` through the proxy in
  passthrough mode authenticated and replied. Headroom relays the OAuth `Authorization` header.
- Workload replayed via WebSocket (`ws-replay-driver.mjs`): the 13 exact user messages of baseline
  session `1fd0124b` ("Business setup interview", LocaForce equipment-rental CRM).
- Baseline = `1fd0124b` (no proxy). Proxy run = `839e7680-4110-44fa-a096-148f119c28c5`.

## Results — `/api/stats` (the real Anthropic billing view)

| Metric | Baseline (no proxy) | Proxy (token) | Δ |
|---|--:|--:|--:|
| input | 155,074 | 162,076 | +4.5% |
| **cacheCreate** (billed ×1.25) | 3,175,757 | **7,700,654** | **+142%** |
| cacheRead (billed ×0.1) | 97,227,298 | 80,462,757 | −17.2% |
| output | 211,693 | 162,862 | −23.1% |
| **synthetic cost** | **$61.56** | **$76.82** | **+24.8%** |
| agents / ops | 66 / 2,138 | 66 / 2,048 | ≈ |

Cost attribution of the +$15.26:
- cacheCreate **+4.52M tokens** ≈ **+$24** (opus +3.0M×$6.25, sonnet +1.42M×$3.75)
- cacheRead −16.8M tokens ≈ **−$8** (mostly opus, ×$0.5)
- output −49k ≈ −$1

The cache-creation explosion is the whole story: rewriting the context to save ~5% of tokens
invalidated the prompt prefix, so Anthropic re-billed the context as fresh cache-creation (×1.25)
instead of cache-read (×0.1).

## Headroom's own `/stats` (token mode) — and why it misleads

| Field | Value |
|---|--:|
| api_requests | 1,667 |
| requests_compressed | 1,249 |
| avg compression | 5.4% (best 44%) |
| tokens_removed | 3,842,109 |
| cost_without → cost_with | $93.07 → $77.17 |
| **claimed saved** | **$15.9 (17.1%)** |
| claimed cache_savings_usd | $249.06 |

Headroom's `cost_with` ($77.17) ≈ the real instance cost ($76.82) — so it routes and counts tokens
correctly. But its `cost_without` ($93.07) is a **fiction**: it prices the un-compressed context at
list rates *as if there were no caching*. The real cached baseline was **$61.56**. Measured against
reality, the "+17% saving" is a **−25% loss**.

## Verdict

- **token mode: do not use here.** −25% (it costs more), because the project's cost is ~⅔ cheap
  cache-reads (×0.1) and compression converts them into expensive cache-creation (×1.25).
- **Headroom's savings metric is cache-blind** — it compares against a no-cache hypothetical, so it
  will always look positive even when it is losing money on a cache-optimized client.
- The right knob for a cache-heavy client is Headroom's **`--mode cache`** (freezes prior turns to
  preserve the prefix-cache). Not yet measured here; expected to be roughly neutral (little
  compression, no cache penalty). A follow-up run would confirm.

## Caveats

- **Nondeterminism**: baseline built 8 tickets, the proxy run 9 tasks; output differs −23%. The
  magnitude of "+25%" is therefore approximate — but the **direction and the cacheCreate +142%** are
  decisive and attributable to cache-breaking, not to one extra ticket (agents 66=66, ops ≈).
- USD is **synthetic** (API list prices); under OAuth subscription the real cost is flat-rate. The
  honest headline metric is **token volume / cache behavior**, which is unambiguous.
- A single run per arm. The effect is large enough that repetition is unlikely to flip the sign.

## Reproduce

```bash
# proxy (host)
docker run -d --name headroom-proxy -p 8787:8787 -e HEADROOM_TELEMETRY=off \
  ghcr.io/chopratejas/headroom:latest --host 0.0.0.0 --port 8787 \
  --mode token --no-telemetry --no-subscription-tracking
# instance (from worktree)
INSTANCE=headroom PORT_CRM=5177 PORT_CHAT=8087 IMAGE=atomic-crm-dev:headroom \
  docker compose -p headroom -f docker-compose.yml -f docker-compose.multi.yml \
    -f docker-compose.headroom.yml up -d
# replay (inside the instance container) — harness lives in docs/headroom-experiment/
docker cp docs/headroom-experiment/ws-replay-driver.mjs atomic-crm-headroom:/tmp/
docker cp docs/headroom-experiment/baseline-user-messages.json atomic-crm-headroom:/tmp/
docker exec -e TURN_TIMEOUT_MS=5400000 atomic-crm-headroom \
  node /tmp/ws-replay-driver.mjs /tmp/baseline-user-messages.json
# compare
curl ".../api/stats?sessionId=<id>"   # instance
curl "http://127.0.0.1:8787/stats"     # proxy
```
