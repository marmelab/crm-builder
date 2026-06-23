# Headroom & RTK benchmark — design

**Date:** 2026-06-23
**Branch:** `feat/headroom`
**Status:** design

## Goal

Measure the real cost impact of two context-compression tools — Headroom and RTK — on a
representative AtomicCRM feature-build workload, and explain *why* each tool wins or loses against
the Anthropic prompt-cache economics.

Prior work (`docs/headroom-experiment.md`) showed Headroom token mode costs **+25% more** on a
full from-scratch session. This study goes further:

1. **4-arm comparison** on a controlled, repeatable workload (not a divergent from-scratch build).
2. **3 repetitions per arm** to quantify variance.
3. **Per-session causal analysis** — ticket count, reviewer cycles, op count, per-agent token
   breakdown — to explain *why* costs differ, not just by how much.
4. **RTK** as a new arm, with its own claimed savings compared to reality.

Deliverable: a technical blog post (marmelab.com) with raw numbers, causal breakdowns, and a
verdict on when (if ever) each tool pays off.

## Background — why the cache economics matter

Anthropic prompt caching bills at three rates (per million tokens):

| Token type | Opus | Sonnet |
|---|--:|--:|
| input | $5 | $3 |
| cacheCreate (×1.25 input) | $6.25 | $3.75 |
| cacheRead (×0.1 input) | $0.50 | $0.30 |
| output | $25 | $15 |

A mature AtomicCRM session is ~90% cacheRead by volume. The key ratio is
`cacheCreate / cacheRead` — call it the **cache preservation ratio**. Baseline is ~4%; anything
that rewrites the prompt prefix inflates it.

Token-mode compression rewrites every turn → new prefix → Anthropic re-bills context as
cacheCreate (×1.25) instead of cacheRead (×0.1). A 12.5× price multiplier on the same tokens.

## Arms

| # | Bras | Tool | Integration |
|---|---|---|---|
| 1 | **Baseline** | None | Direct Anthropic |
| 2 | **Headroom cache** | `ghcr.io/chopratejas/headroom:latest` `--mode cache` | `ANTHROPIC_BASE_URL=http://headroom:8787` |
| 3 | **Headroom token** | same, `--mode token` | `ANTHROPIC_BASE_URL=http://headroom:8787` |
| 4 | **RTK** | `github.com/rtk-ai/rtk` standalone | spawn `rtk claude` instead of `claude` in `pty-session.js` |

Arms 1-3 are transparent to the codebase (env var only). Arm 4 requires a one-line change to
`chat-service/lib/server/pty-session.js`: replace the `claude` binary with `rtk claude` when
`RTK_ENABLED=1` is set in the environment.

## Workload

**CRM state:** AtomicCRM base (default, no prior customization). `make wipe` before every run.

**Feature request (verbatim, identical across all 12 runs):**

> "I need to track equipment rentals. Add a rental entity linked to contacts, with a start date,
> end date, and status (pending/active/returned)."

Expected: planner generates 2-3 tickets (entity + list/show views + form). One reviewer wave.
Merger integrates into main.

**Satisfaction ask:** always reply "No" — session stops before the migration/deploy flow.

**Replay mechanism:** adapt `docs/headroom-experiment/ws-replay-driver.mjs` with the single
feature message + automated "No" reply on the satisfaction ask event.

## Protocol

```
for arm in baseline headroom-cache headroom-token rtk; do
  for rep in 1 2 3; do
    make wipe
    [start proxy if needed]
    node ws-replay-driver.mjs feature-messages.json
    curl /api/stats?sessionId=<id> > results/${arm}-${rep}.json
    [rtk gain --json > results/rtk-${rep}-gain.json  # arm 4 only]
  done
done
```

Each result snapshot saved to `docs/headroom-experiment/results/`.

## Metrics captured

### Cost breakdown (per run, from `/api/stats`)

- `input_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `output_tokens`
- `synthetic_cost_usd` (computed from MODEL_RATES in `chat-service/lib/stats/io.js`)

Reported as median ± [min, max] across 3 repetitions.

### Session quality signals (per run, from session files)

| Signal | Source | Purpose |
|---|---|---|
| Tickets completed | `TASK-*.json` status | Nondeterminism in planner decomposition |
| Total ops | `log.jsonl` op count | Proxy for total work done |
| Reviewer verdict breakdown | `hooks.log` / `record-review-verdict` outputs | Blocked reviews → retry loops → extra tokens |
| Output tokens per agent type | subagent transcripts | Does compression make models more verbose? |
| Input tokens per agent type | subagent transcripts | Is context actually smaller under compression? |
| Wall-clock time | `meta.json` createdAt/lastMessageAt | Proxy latency overhead |

### Tool-specific metrics

- **Headroom** (`/stats` on `:8787`): `tokens_removed`, `avg_compression`, `cost_without` vs
  `cost_with`. Compare `cost_without` against real baseline to expose the cache-blind gap.
- **RTK** (`rtk gain --json`): claimed tokens saved, actual cost from `/api/stats`.

## Analysis plan

### 1. Cost comparison table

Full token breakdown (input / cacheCreate / cacheRead / output / $/run / $/ticket) per arm,
median ± spread. Normalize by tickets completed.

### 2. Cache preservation ratio

`cacheCreate / cacheRead` per arm. This is the single most diagnostic number:
- ~4% = cache intact (baseline, expected for Headroom cache mode)
- >8% = cache disrupted (expected for token mode)

### 3. Causal breakdown — where does the cost difference come from?

For each arm vs baseline, decompose the Δ cost:

```
Δ cost = Δ(input × r_input) + Δ(cacheCreate × r_cc) + Δ(cacheRead × r_cr) + Δ(output × r_out)
```

Attribution in dollars: which token type drives the difference?

### 4. Tool savings vs claimed savings

For Headroom: `cost_without` (their stat) vs real baseline cost → quantify the cache-blind
overstatement.
For RTK: `rtk gain` claimed saving vs Δ real cost vs baseline.

### 5. Session-level divergence check

If two runs of the same arm show >15% cost difference, inspect:
- Did the planner create a different number of tickets?
- Did any reviewer block and force a retry?
- Did output tokens spike on a specific agent?

This is the causal narrative for the blog post: "run X cost 20% more because the reviewer blocked
twice on the rental form validation, adding two full developer retry loops."

### 6. Per-agent-type breakdown

Aggregate tokens by agent role (orchestrator / planner / developer / reviewer / merger) per arm.
Key question: does compression disproportionately affect one role?

## Expected findings (hypotheses to test)

| Hypothesis | Basis |
|---|---|
| Headroom token mode costs more (+20-30%) | Prior experiment: +25% on full setup |
| Headroom cache mode is roughly neutral (±10%) | cc/cr ratio preserved in ed3d run |
| RTK may show real savings on output tokens | CLI output filter; doesn't touch prompt cache |
| All tools add wall-clock latency | Proxy/wrapper overhead |
| Headroom's own stats overstate savings by 15-20% | Cache-blind `cost_without` |

## RTK integration detail

File to modify: `chat-service/lib/server/pty-session.js` (~line 69, the `claude` spawn).

```js
// Before:
const cmd = 'claude';
// After (opt-in via env):
const cmd = process.env.RTK_ENABLED === '1' ? 'rtk claude' : 'claude';
```

RTK must be installed in the container image (`feat/headroom` Dockerfile).

```dockerfile
RUN curl -fsSL https://rtk.ai/install.sh | sh   # or cargo install rtk
```

`rtk init -g` may be needed once inside the container to configure the Claude Code integration.
Stats: `rtk gain --json` after each run.

## Compose setup

Reuse `docker-compose.headroom.yml` for arms 2-3 (Headroom proxy service).
For arm 4, add `RTK_ENABLED=1` to the `crm-app` service environment — no proxy needed.

Instances can share the same image; differentiate via `.env` overrides per arm.

## Out of scope

- Migration / deploy flow (stopped at satisfaction ask).
- Full from-scratch session comparison (covered by prior `headroom-experiment.md`).
- Headroom passthrough mode (already validated in prior experiment).
- Production integration recommendation (flat-rate OAuth billing; synthetic USD is informational).
