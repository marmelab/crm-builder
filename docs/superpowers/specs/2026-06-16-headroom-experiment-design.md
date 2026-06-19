# Headroom experiment — measuring context-compression gain

**Date:** 2026-06-16
**Branch:** `feat/headroom`
**Status:** design (throwaway experiment — not necessarily merged)

## Goal

Measure whether [Headroom](https://headroom-docs.vercel.app/docs/installation) — an LLM
context-compression tool — reduces the token volume this project sends to Claude, on a
**representative replayed session**. The deliverable is a measurement report and a verdict,
not a production integration.

## Context (how Claude is invoked here)

- Claude runs via the **`claude` CLI inside a PTY** (`chat-service/lib/server/pty-session.js:69`),
  not via the SDK. The CLI inherits `process.env`, so it can be routed through a proxy with
  `ANTHROPIC_BASE_URL` — **no change to the invocation logic itself**.
- This instance authenticates via **OAuth subscription** (`claude-auth` volume), not an API key.
  Two consequences:
  1. **No direct dollar cost to optimize** — billing is flat-rate. `chat-service/lib/stats/io.js`
     computes USD from hard-coded API rates; those figures are **synthetic** (what it *would* cost
     on the API). They remain a good proxy for **token volume** and **rate-limit pressure**, but
     they are not the real bill. Headline metric = **reduction in tokens processed**.
  2. **Auth-passthrough risk** — the CLI sends an OAuth **Bearer** token, not `x-api-key`. For the
     proxy to work, Headroom must relay the `Authorization` header verbatim to `api.anthropic.com`.
     Headroom's docs confirm an Anthropic-format endpoint (`POST /v1/messages`, usable via
     `ANTHROPIC_BASE_URL`) but document neither auth-passthrough nor streaming. Unverified.
- **The central tension this experiment tests:** the project lives on **prompt caching**
  (cache reads billed at 0.1×; CLAUDE.md notes cold cache is expensive). Headroom compresses the
  context → **changes the prompt prefix → breaks the cache**. On an already-cached workload,
  compressing cached tokens (0.1×) into fewer uncached tokens (1× input, 1.25× cache-creation) can
  cost **more**, not less. Headroom's "CacheAligner" claims to address this. Whether the net is
  positive is exactly what we measure.

## Feasibility (confirmed)

Headroom's proxy explicitly documents our case: `ANTHROPIC_BASE_URL=http://localhost:8787 claude`.
`POST /v1/messages` accepts Anthropic format, compresses, forwards to Anthropic, returns the
response. Compression is automatic; bypassable per-request via `x-headroom-bypass: true` or
globally via `--no-optimize`.

## Approach — two-phase plan

### Network topology (non-trivial)

The `claude` CLI runs **inside the `crm-app` container**. For `ANTHROPIC_BASE_URL` to reach
Headroom, the proxy must be reachable from that container. Plan: a throwaway compose override
**`docker-compose.headroom.yml`** adding a `headroom` service
(`ghcr.io/chopratejas/headroom:latest`) on the same network → URL becomes `http://headroom:8787`.
No host port mapping, no Dockerfile change, removed at the end.

### Phase 0 — OAuth smoke test (decision gate)

1. Start the `headroom` service via the override.
2. Inside the container (`make shell`), test **pure passthrough first** (compression bypassed,
   `--no-optimize` / `x-headroom-bypass: true`) to isolate the auth question from the compression
   question: `ANTHROPIC_BASE_URL=http://headroom:8787 claude --print "Hi"`.
3. **Gate:**
   - Authenticates + replies → **Phase A** (live A/B).
   - 401/403 (OAuth Bearer not relayed) → **Phase C** (offline compression).

### Phase A — live A/B *(if smoke test passes)*

- **Only code change:** in `pty-session.js` where the spawn env is built (~line 74), if
  `process.env.HEADROOM_PROXY_URL` is set, add `ANTHROPIC_BASE_URL: process.env.HEADROOM_PROXY_URL`
  to the spawn env. Opt-in, reversible, one branch.
- **Workload — replay existing sessions.** Two fixed bases, both from `crm-builder/sessions/`:
  - **FULL_SETUP:** `1fd0124b-68ec-41a7-b244-481e0bd8d6ff` — "Business setup interview", 76 messages,
    8 tickets, 1.28 MB `log.jsonl`. Large from-scratch interview context.
  - **COMPLEX:** `b96229ae-2713-47db-b345-f2f9731a8991` — "Add task priority and sorting", 53 messages,
    3 tickets. A feature-add change request on an existing CRM.

  Replay each base's initial user prompt(s) through a **fresh session** on each arm (direct vs
  proxied). True deterministic replay of an interactive agent is impossible (LLM nondeterminism),
  so run **N runs per arm** (e.g. 3) and compare aggregates. Fresh sessions each time keep cache
  state comparable across arms.
- **Compare** via `GET /api/stats`: input tokens, **cache_read**, **cache_creation**, output,
  synthetic USD, wall-clock. Key signal: does `cache_creation` balloon (cache broken)?

### Phase C — offline compression *(if smoke test fails)*

- Extract **real contexts** from the chosen session's CLI transcript
  (`~/.claude/projects/**/*.jsonl`, full message content).
- Feed them to Headroom's `POST /v1/compress` → original vs compressed token counts + ratio.
- Aggregate (median, distribution). **Caveat to state loudly:** this is the **raw compression
  ratio**; it ignores the cache interaction, so it is an **upper bound** on the real gain under
  caching, which is likely lower.

## Where to get the sessions to replay

Both chosen sessions exist under `crm-builder/sessions/` (the main checkout, not the empty
`feat-headroom` worktree). Each carries its CLI transcript at `claude/transcript.jsonl` plus
`claude/tool-results/*.txt` — this is the captured real context that **Phase C** feeds to
Headroom's `/v1/compress`. For **Phase A**, the initial user prompt(s) are extracted from the
session's `log.jsonl` and replayed in fresh sessions.

## Deliverable & metrics

A report at **`docs/headroom-experiment.md`**: methodology, raw numbers, a gain table, and a
**verdict** answering "does prompt caching cancel the compression gain?". Headline metric =
**reduction in tokens processed** (USD is synthetic under OAuth).

## Testing

No business logic to unit-test — the "test" is the measurement methodology itself. The single code
change (env gate) is trivial and reversible. **No automated tests added** (YAGNI for a throwaway
experiment).

## Cleanup

At the end: remove `docker-compose.headroom.yml` and the `pty-session.js` env gate (or leave the
gate behind the opt-in flag, inert). `feat/headroom` is a test bench, not necessarily merged.

## Out of scope

- Production integration / always-on proxy.
- Optimizing the real subscription bill (flat-rate; not token-metered).
- Network-level interception (rejected: TLS/OAuth/toggle friction).
