# Headroom & RTK benchmark — analysis
**Date:** 2026-06-25  
**Branch:** `feat/headroom`  
**Runs:** 12 (4 arms × 3 reps), each on fresh AtomicCRM base  
**Workload:** "Add a rental entity linked to contacts with start/end date and status"

---

## 1. Top-level results

| Arm | Cost median | Min | Max | Δ baseline | cc/cr ratio |
|---|--:|--:|--:|--:|--:|
| **Baseline** | $4.59 | $3.88 | $6.09 | — | 4.6% |
| **RTK** | $4.96 | $4.70 | $5.93 | +8% | 5.0% |
| **Headroom cache** | $5.49 | $5.15 | $5.96 | +20% | 5.6% |
| **Headroom token** | $6.36 | $6.24 | $7.00 | +39% | 10.8% |

**The cc/cr ratio is the key diagnostic number.** It measures what fraction of the context
is being re-created vs read from cache. At Anthropic pricing, cacheCreate costs 12.5× more
than cacheRead ($3.75/M vs $0.30/M for Sonnet). A healthy session has ~3–5% cc/cr.

---

## 2. The main confound: planner nondeterminism

The planner doesn't always decompose the rental feature the same way:

| Arm | Rep 1 | Rep 2 | Rep 3 |
|---|---|---|---|
| Baseline | 3 tickets | 2 tickets | 2 tickets |
| Headroom cache | 2 tickets | 3 tickets | 3 tickets |
| Headroom token | 3 tickets | 2 tickets | 3 tickets |
| RTK | 2 tickets | 3 tickets | 3 tickets |

3-ticket runs cost more simply because they add a wave (typically "add rentals tab to
contact detail page"). This creates misleading arm-level comparisons.

**Normalized by ticket count:**

| Arm | $/ticket (reps) | Median |
|---|---|---|
| Baseline | $2.03 / $1.94 / $2.29 | **$2.03** |
| Headroom cache | $2.58 / $1.83 / $1.99 | **$1.99** |
| Headroom token | $2.33 / $3.12 / $2.12 | **$2.33** |
| RTK | $2.48 / $1.98 / $1.57 | **$1.98** |

**Key finding:** Headroom cache mode costs **the same as baseline per ticket** ($1.99 vs
$2.03). The raw +20% was entirely a sampling artifact — the planner happened to generate
3-ticket runs in 2/3 headroom-cache sessions. Once normalized, the proxy adds zero cost.

---

## 3. Token mode cost attribution (the +$2.36 explained)

Comparing 2-ticket baseline rep2 ($3.88) vs 2-ticket htoken rep2 ($6.24):

| Token type | Baseline | Headroom token | Δ tokens | Δ cost (Sonnet rate) |
|---|--:|--:|--:|--:|
| input | 11,225 | 11,291 | +66 | +$0.000 |
| **cacheCreate** | 376,088 | 742,512 | **+366,424** | **+$1.374** |
| cacheRead | 6,171,278 | 9,056,772 | +2,885,494 | +$0.866 |
| output | 16,996 | 20,800 | +3,804 | +$0.057 |

**The cacheCreate inflation accounts for 58% of the extra cost.** But paradoxically,
cacheRead also increases (+47%). Why?

Headroom compresses the context, creating a new cache entry (cacheCreate). On subsequent
turns within the same agent session, the compressed version is read back (cacheRead), but
then the context grows again → another compression → another cacheCreate. The net result
is both more create and more read, but the creates are 12.5× more expensive per token.

---

## 4. Headroom cache mode: confirmed passthrough

The deeper per-phase analysis answers the question directly.

**Developer cc/cr per phase (all phases across 3 reps, sorted):**

| Arm | cc/cr values (per developer phase) | Median |
|---|---|--:|
| baseline | 1.5% 2.1% 2.1% 2.5% 3.7% 4.7% 5.2% 5.7% 8.5% | **3.7%** |
| headroom-cache | 1.6% 2.4% 2.4% 2.5% 3.7% 3.7% 5.4% 5.5% 5.6% 5.8% 7.0% 8.8% | **4.6%** |
| headroom-token | 5.9% 6.2% 8.8% 9.2% 10.2% 11.2% 11.8% 12.2% 16.5% 20.5% | **10.7%** |

Headroom cache mode and baseline overlap completely. The individual developer phases
have the same range and the same distribution. The proxy is not compressing anything.

**Confirmed by input tokens:** fresh (non-cached) input per developer phase:
- Baseline median: 30 tokens
- Headroom cache median: 26 tokens

Identical — the uncached portion of the context is also unchanged. In cache mode,
Headroom routes the request through itself, preserves the prefix byte-for-byte, and
forwards it to Anthropic unchanged.

**What cache mode actually does:** it forwards HTTP requests without modification. The
only difference vs a direct connection is the proxy round-trip. Our data shows this adds
no measurable overhead at the session cost level.

---

## 5. RTK: a shell wrapper that doesn't reach the API

RTK wraps the `claude` CLI subprocess. It intercepts stdin/stdout, not HTTP. The Anthropic
API calls are made by the Claude SDK inside the `claude` process, with `ANTHROPIC_BASE_URL`
pointing directly to `api.anthropic.com`. RTK never sees those requests.

**Per-agent output tokens (baseline vs RTK, all instances):**

| Agent | Baseline median | RTK median | Δ |
|---|--:|--:|--:|
| orchestrator | 4,296 | 3,664 | −15% |
| planner | 977 | 1,150 | +18% |
| developer | 2,424 | 2,165 | −11% |
| quality-reviewer | 919 | 1,066 | +16% |
| merger | 29 | 52 | +76% |

No consistent directional pattern. The quality-reviewer is *higher* under RTK (+16%).
The developer is lower (−11%) but the planner is higher (+18%). These are noise — with
only 9–11 instances per agent type, the variance swamps any real signal.

**Session structure (duration, agents, ops) is identical** between RTK and baseline.
RTK does not change how many agent calls are made, how many tool calls fire per agent,
or how long sessions run.

**RTK's `rtk gain` tracker was not initialized** (`rtk init` was not run before the
sessions). Without initialization, RTK's own tracking produces "No tracking data yet."
Even with tracking enabled, `rtk gain` measures CLI-level I/O, not Anthropic API
token consumption — the two are not the same thing in an agentic multi-subagent system.

---

## 6. The developer agent is the exclusive victim of token mode

Comparing 2-ticket runs (same ticket count, same task scope):

| Agent type | Baseline cc/inst | htoken cc/inst | Multiplier | cc/cr baseline → htoken |
|---|--:|--:|--:|--:|
| orchestrator | 75,190 | 69,184 | **0.9×** | 14.3% → 16.4% |
| planner | 25,325 | 23,664 | **0.9×** | 24.5% → 23.9% |
| **developer** | 43,275 | 150,532 | **3.5×** | 3.0% → 6.5% |
| quality-reviewer | 32,989 | 40,706 | **1.2×** | 11.9% → 9.9% |
| merger | 15,593 | 25,315 | **1.6×** | 14.9% → 25.2% |

Orchestrator and quality-reviewer are essentially **unaffected**. The developer agent
takes a **3.5× hit on cacheCreate**.

### Why the developer specifically?

The developer's context is 7–20× larger than any other agent:

| Agent | cacheRead/instance (context size proxy) |
|---|--:|
| orchestrator | ~527k tokens |
| planner | ~182k tokens |
| quality-reviewer | ~302k tokens |
| merger | ~104k tokens |
| **developer** | **~2,139k tokens** |

The developer reads 30–80 files per task (codebase scan, schema files, existing
components). This builds a massive, stable cache prefix — the same files are re-read on
every Bash/Read tool call within the session. In baseline, this achieves a cc/cr ratio
of 2.5%: for every 100 tokens read from cache, only 2.5 needed to be newly created.

When Headroom token mode intercepts this, it compresses the accumulated messages into a
summary. This summary is a *new, different* string — Anthropic's cache infrastructure
doesn't recognize it as the same prefix → cacheCreate fires instead of cacheRead.

**The economics break down:** Headroom does reduce the developer's context by ~20%
(2,139k → 1,718k cacheRead). But:
- Saving 421k cacheRead tokens: −$0.13/developer-instance
- Extra 97k cacheCreate tokens: +$0.36/developer-instance
- **Net: −$0.13 + $0.36 = +$0.23 more expensive per developer call**, despite smaller context

The 12.5× ratio between cacheCreate and cacheRead makes any compression that breaks the
prefix prefix fatal.

---

## 5. Why orchestrator and quality-reviewer are immune

Both agents have cc/cr ratios of **11–14% at baseline** — already much higher than the
developer's 2.5%. This means they benefit less from caching to begin with. Their contexts
are short and don't accumulate file contents across many turns. Headroom may compress them,
but the cache disruption has proportionally less impact because there wasn't much caching
to lose.

The quality-reviewer's cc/cr actually improves slightly under token mode (11.9% → 9.9%),
likely because Headroom's compression occasionally shortens the context enough that the
prefix stabilizes — noise-level variance at these scales.

---

## 6. RTK: completely transparent on cache

RTK wraps the `claude` CLI subprocess at the shell level. It does **not** intercept HTTP
requests to Anthropic's API. The `ANTHROPIC_BASE_URL` remains unchanged. Cache prefixes
are built and managed by the Claude SDK directly.

Developer metrics under RTK vs baseline:

| Metric | Baseline | RTK |
|---|--:|--:|
| cc/instance | 53,836 | 46,233 |
| cc/cr ratio | 2.5% | 2.5% |
| $/ticket | $2.03 | $1.98 |

RTK is indistinguishable from baseline at the cache level. Its "savings" (per its own
`rtk gain` CLI) could not be confirmed because `rtk gain` requires `rtk init` — the
session tracking was not initialized. What we can say: RTK adds zero measurable overhead
and does not break prompt caching.

---

## 7. Why neither tool helps: the cache hit rate floor

Our sessions run at **95–98% cache hit rate** (cacheRead / (cacheCreate + cacheRead)):

| Session | Cache hit rate | Total context |
|---|--:|--:|
| Baseline rep1 | 95.6% | 11,471k tokens |
| Baseline rep2 | 94.3% | 6,559k tokens |
| Baseline rep3 | 96.0% | 9,214k tokens |

The Anthropic prompt cache is already doing its job nearly perfectly. There is almost
nothing to compress. The 2–5% that is being created (cacheCreate) is:
- Tool results from the current turn (Bash outputs, file contents just read)
- New planning messages
- First-turn prefix establishment

These are *not* repetitive context — they cannot be compressed without losing information
that the agent needs to do its work correctly.

**Compression tools add value when:** hit rate is low (<50%), context approaches the
window limit, or sessions are short and independent (no stable prefix).

**Compression tools hurt when:** hit rate is high (>90%), context is large and stable,
agents read many files. An agentic code workflow maximizes exactly this second profile.

The developer agent reads 30–80 files per task. Each file read adds to a stable cache
prefix that is re-used on every subsequent tool call in that session. This is the
*ideal* use case for Anthropic prompt caching — and the worst possible use case for
any tool that rewrites or compresses that prefix.

---

## 8. Headroom's own stats vs reality

Headroom exposes a `/stats` endpoint with `cost_without` (what it claims you would have
paid without the proxy) and `cost_with` (what you actually paid through it).

From our prior LocaForce experiment (full setup, not this benchmark):
- Headroom reported `cost_without = $93.07`
- Actual baseline session: $61.56
- Gap: **$31.51 overstatement (+51%)**

The reason: Headroom assumes *no caching* when computing `cost_without`. It applies full
input rates to all context tokens. On a real session where ~90% of tokens are cacheRead,
this makes its "savings" calculation completely unreliable. It is comparing against a
hypothetical worst-case baseline that doesn't exist.

In our short-session benchmark, Headroom token mode would have claimed savings. Our data
shows it **costs +39% more**.

---

## 8. Output tokens: compression reduces model verbosity

| Arm | Output tokens / agent |
|---|--:|
| Baseline | 1,944 |
| Headroom cache | 1,748 |
| **Headroom token** | **1,535** |
| RTK | 1,632 |

Token mode reduces output tokens by 21% per agent. This is a real effect: with a
compressed, lower-information context, the model produces shorter responses. Whether
this represents "good compression" (removing padding) or "information loss" (the agent
does less thorough work) requires qualitative review — but the output token savings
($0.06/run at most) are negligible compared to the cacheCreate overhead (+$2.25/run).

---

## 9. Summary narrative

### What Headroom token mode does

Token mode compresses agent context to reduce the number of tokens sent per request.
On short, isolated queries this might save cost. On an agentic codebase workflow:

1. Developer agents accumulate large, stable context (file reads) across many turns
2. This context achieves extremely high cache hit rates (97.5% — cc/cr = 2.5%)
3. Headroom rewrites this context → new cache prefix → cache miss
4. The re-creation cost (×1.25) is 12.5× the read cost (×0.1)
5. Even though context shrinks 20%, the per-token savings are swamped by the cache disruption

**Net: +39% cost on median, +$2.36 on a 2-ticket run.**

### What Headroom cache mode does

Cache mode preserves the context prefix. Our data confirms: per ticket, it costs
identically to baseline ($1.99 vs $2.03). There is no measurable penalty or benefit.
The proxy adds a round-trip but the caching economics are unchanged.

### What RTK does (in our measurement)

RTK is a shell wrapper. It has zero impact on Anthropic prompt caching. Our $/ticket
numbers ($1.98 vs $2.03 baseline) are within measurement variance. Without `rtk init`,
we cannot assess its own tracking claims.

### The core principle

Anthropic's prompt caching is a tiered pricing scheme where cache hits are 12.5× cheaper
than creates. Any tool that breaks or rewrites the prefix — even to produce a shorter
context — will pay more unless the context reduction exceeds 12.5× the original size.
That threshold is almost never achievable in a multi-turn agentic session.

---

## Raw data location

`docs/headroom-experiment/results/{arm}-{rep}.json` — full `/api/stats` snapshot per run.
