---
title: "We benchmarked two context-compression proxies against prompt caching. Caching won."
date: 2026-06-26
# TODO: adjust author / tags / hero image to the marmelab blog schema before publishing
author: "Jerome"
tags: ["llm", "claude", "ai-agents", "cost-optimization", "prompt-caching"]
---

We run [Atomic CRM Builder](https://marmelab.com/atomic-crm/): a sandbox where a non-technical user describes a change to their CRM in plain language, and a team of Claude agents ships it. A planner breaks the request into tickets; developer agents implement them in isolated git worktrees; reviewers check the work; a merger integrates it into `main`. It works — and it burns tokens. A single request fans out into a planner, two or three developers, a couple of reviewers per ticket, and a merger, each one a separate Claude process that reads large slices of the codebase to do its job.

So when we came across two tools that promise to cut LLM costs by compressing the context sent to the model, we wanted to know if they'd help. We wired both into the builder and ran a controlled benchmark — twelve full runs.

None of them made the work cheaper. The most aggressive one made **every operation ~32% more expensive**.

The robust finding, stated carefully: **token-mode compression roughly doubles the rate at which context is re-written to the cache, and that makes each unit of agent work ~32% pricier.** Cache mode and RTK leave that rate untouched — they neither help nor hurt. And the reason generalizes to any agentic LLM workload: **once your session rides Anthropic's prompt cache, the cache has already done the cost optimization. Anything that rewrites the context to "save tokens" fights the cache and loses.**

Getting to a number we'd defend took as much care in *how we measured* as in *what we measured* — so we'll start there.

## The measurement trap: this system is non-deterministic

You cannot benchmark an agent team the way you benchmark a function. Two things vary from run to run, independently of any tool:

- **The planner** decomposes the same feature into either 2 or 3 tickets, and a 3-ticket run includes a whole extra wave of work.
- **The developers and reviewers** are non-deterministic too: a ticket can take 40 or 70 turns, a reviewer can bounce work back and trigger a retry loop.

This means a **whole-session total is the wrong unit of comparison** — it conflates *what the tool did* with *how much work happened to occur*, and the second part is just noise. Every confusing, contradictory-looking number we hit during this study turned out to be a session total read as if it were a measurement.

So we never compare session totals. We anchor every claim on units where the work volume cancels out:

1. **The cc/cr ratio** — cacheCreate ÷ cacheRead. Because it's a ratio of two quantities from the *same* session, the amount of work appears in both numerator and denominator and cancels. A 2-ticket run and a 3-ticket run yield the same cc/cr if the tool behaves the same way. It is a pure, dimensionless rate.
2. **Cost per operation** — the finest comparable unit. An "operation" is one logged agent action (a tool call, a message) from the builder's own counter. Cost-per-op asks "what does one unit of agent work cost?", which is exactly the question a tool should move — and it's immune to how many tickets the planner happened to invent.

Keep these two in mind; they're the spine of everything below.

## How Anthropic prompt caching is priced

You can't read the results without this. Anthropic's prompt cache bills at three tiers, and the spread between them is the whole story. Per million tokens, for the two models in play:

| Token type | Sonnet | Opus | Multiplier |
|---|--:|--:|--:|
| input (uncached) | $3.00 | $5.00 | ×1.0 |
| cache **write** (`cacheCreate`, 5-min TTL) | $3.75 | $6.25 | ×1.25 |
| cache **read** (`cacheRead`) | $0.30 | $0.50 | ×0.10 |
| output | $15.00 | $25.00 | — |

The number to hold onto: **a cache read costs one-tenth of a normal input token, and a cache write costs 1.25× — so reading a cached token is 12.5× cheaper than (re)writing it.** (The ×1.25 write rate is the 5-minute TTL, Claude Code's default; the 1-hour TTL is ×2.)

Once a prefix is written to the cache, every later request that begins with that *byte-identical* prefix reads it back at the cheap rate. A multi-turn agent that reads 40 files and then makes 50 more tool calls re-sends that accumulated prefix on every turn — and the cache bills each re-send at 10% of list price. That's why our `cc/cr` ratio matters: it's the fraction of context that had to be freshly written versus cheaply re-read. **At baseline our sessions run at 4.6% cc/cr — a ~95% cache hit rate.** And the trap is right there in the pricing:

> Any tool that rewrites the context — *even to make it shorter* — produces a byte sequence the cache has never seen. The prefix no longer matches. The cheap cacheRead becomes an expensive cacheCreate, and the 12.5× multiplier fires in the wrong direction.

## The result, on units that survive the noise

Here are the two robust metrics, four arms, three repetitions each:

| Arm | cc/cr | ¢ / operation | Δ vs baseline |
|---|--:|--:|--:|
| Baseline | 4.6% | 2.09¢ | — |
| Headroom cache | 5.6% | 2.00¢ | −4% |
| RTK | 5.0% | 2.22¢ | +6% |
| Headroom token | **10.8%** | **2.76¢** | **+32%** |

And here is why per-operation is worth the trouble. The per-rep figures separate **cleanly**:

| Arm | ¢/op rep 1 | rep 2 | rep 3 |
|---|--:|--:|--:|
| Baseline | 2.07 | 2.09 | 2.33 |
| Headroom token | 2.65 | 2.80 | 2.76 |

**All three token-mode runs sit above all three baseline runs.** No overlap, no ambiguity — even though each pair of runs built a different number of tickets in a different number of turns. That is what a real effect looks like through the noise.

Compare that to the unit everyone reaches for first — cost per ticket. There, token mode reads 2.33 / 3.12 / **2.12** against a baseline of 2.03 / 1.94 / **2.29**: the distributions overlap, and the signal nearly vanishes. Cost-per-ticket is doubly biased — by the variable size of a ticket, and by economies of scale (a 3-ticket run amortizes the fixed orchestrator and planner cost over three tickets, dragging $/ticket down). Per-operation has neither bias, which is why it reveals a +32% penalty where $/ticket showed only +15% and the raw session median showed a misleading +39%.

So, the conclusion, stated on robust ground:

- **Headroom token mode is a real, ~32%-per-operation loss**, driven by a cc/cr ratio that more than doubles (4.6% → 10.8%).
- **Headroom cache mode (−4%, cc/cr 5.6%) and RTK (+6%, cc/cr 5.0%) are noise** — both interleave with baseline on both metrics. They neither save nor cost.

The session medians (+39% for token mode) and per-ticket figures (+15%) point the same direction but are confounded by ticket count and economies of scale. We report them for completeness, not as measurements. The rest of this post explains the mechanism — and why the only tool *designed* to win quietly does nothing.

## Token mode: why compressing the context raises the per-operation cost

The developer is the agent that takes the damage (the next section shows why), so we zoom into it on the same unit as the headline — **cost per developer operation** (one tool call). Isolated, the worst-hit agent shows a steeper penalty than the +32% system-wide average, which dilutes it with less-affected agents:

| Per developer operation | Baseline | Token mode | Effect |
|---|--:|--:|---|
| cacheRead tokens (×0.10) | 45,609 | 41,248 | **−10%** → −0.13¢ |
| cacheCreate tokens (×1.25) | 1,098 | 3,613 | **+229%** → +0.94¢ |
| output tokens | 72 | 70 | −3% → ~0¢ |
| cc/cr | 2.4% | 8.8% | — |
| **cost / operation** | **1.89¢** | **2.70¢** | **+43%** |

So per operation, compression *does* trim the cached reads — by 10%, on the cheap ×0.10 line — but it nearly **quadruples** the cache writes on the expensive ×1.25 line. Net: +0.8¢ per operation, a +43% penalty.

This also clears up the most natural objection: *"if it compresses, shouldn't the `input` shrink?"* It does shrink the context — but **that reduction never shows up on the `input` line.** In a cached session the SDK marks nearly the entire prompt with `cache_control`, so every request is billed almost entirely as cacheRead (the cached part) plus cacheCreate (the newly written part); genuinely-uncached `input` is a definitional leftover of ~100 tokens. The compression's saving therefore lands on **cacheRead** (−10% per op, the cheap ×0.10 line). Its cost lands on **cacheCreate** (+229% per op, the expensive ×1.25 line), because rewriting the history into a summary produces a string the cache has never seen — the prefix check fails, and a write fires where a read would have.

That asymmetry is fatal, and the break-even makes it concrete: a surviving token flips from a read (0.10 units) to a create (1.25), so breaking even requires `1.25 × (1 − c) ≤ 0.10`, i.e. **c ≥ 92%** — you'd have to delete 92% of the tokens just to come out even. The compression removed 10%. Shrinking the *size* of each cached read by a tenth is no match for tripling the *number* of expensive writes.

## Why the developer agent takes all the damage

Every agent runs through the proxy, but only one is hurt. Per-agent cache behaviour on robust units — the cc/cr rate, and cacheCreate **per operation**:

| Agent | cc/cr (base → token) | cacheCreate / op (base → token) |
|---|--:|--:|
| **developer** | **2.4% → 8.8%** | **1,098 → 3,613 (×3.3)** |
| orchestrator | 7.6% → 7.4% | 2,780 → 2,710 (×1.0) |
| quality-reviewer | 11.7% → 13.0% | 3,362 → 3,475 (×1.0) |
| merger | 15.0% → 27.2% | 2,478 → 4,031 (×1.6) |
| planner | 16.0% → 31.2% | 2,027 → 3,096 (×1.5) |

Notice the developer creates the *fewest* cache tokens per operation at baseline (1,098 — it's the best-cached agent), and token mode inflates it the *most* (×3.3). The orchestrator and reviewer are flat (×1.0); the merger and planner rise (×1.5–1.6) but already cached poorly, so they had little caching to break. The developer is singled out because it starts at a 97.6% hit rate — the most to lose when the prefix breaks. And it does the most work: ~50 tool calls per instance (against ~13 for the orchestrator) on a large, stable context. Multiply per-operation damage by operation count and the developer alone accounts for **78% of every cache read in the session**:

| Agent | Instances | cacheRead (3 baseline reps) | Share |
|---|--:|--:|--:|
| **developer** | 9 | **20,341,553** | **78.4%** |
| quality-reviewer | 9 | 2,712,445 | 10.4% |
| orchestrator | 3 | 1,429,918 | 5.5% |
| merger | 10 | 994,069 | 3.8% |
| planner | 3 | 480,085 | 1.8% |

The reason is architectural: the developer reads 30–80 source files per task, almost all via the native `Read` tool. Each read appends to the conversation and is re-sent on every later turn — written to cache once, then read back at one-tenth the price forever after. Token mode destroys exactly this. The agent with the most to gain from caching has the most to lose when caching breaks.

## Cache mode: the right design that never fires

Headroom's **cache mode** is the smarter idea, built precisely to avoid token mode's prefix destruction: instead of rewriting everything, it compresses only the *delta* — the messages added since the previous turn — and forwards the established prefix byte-for-byte. The prefix stays identical, the cache hit fires, only the small tail is reduced. In principle, the correct way to layer compression on top of prompt caching.

In principle. On our workload it compressed **nothing** — a passthrough that neither helps nor hurts. Per developer operation it sits right on top of baseline:

| Per developer operation | Baseline | Cache mode |
|---|--:|--:|
| cacheRead tokens (×0.10) | 45,609 | 40,613 |
| cacheCreate tokens (×1.25) | 1,098 | 1,169 |
| **cost / operation** | **1.89¢** | **1.77¢** (−6%, noise) |

The −6% is within run-to-run noise — and tellingly the cc/cr edges *up* (2.4% → 2.9%), the opposite of what a working compressor would do. Where token mode tripled cacheCreate per op (+229%), cache mode's barely moves (+6%): it doesn't break the cache, but it doesn't compress either. Three more checks, none relying on a session total, confirm the passthrough:

1. **Per-developer cc/cr distributions overlap** — 2.4% baseline vs 2.9% cache mode, statistically indistinguishable. A delta compressor would shift them down.
2. **The same task, turn for turn, doesn't shrink.** The largest developer task wrote 90,318 cacheCreate over 62 baseline turns versus 95,064 over 78 cache-mode turns — *more*, not fewer.
3. **Per-turn, cacheCreate never spikes.** If cache mode had re-written a compressed prefix on a turn, that turn would spike into the tens of thousands, the way token mode does. Across the whole task the maximum is ~9.9k — identical to baseline — with not one turn over 10k. It never breaks the prefix.

Why does the cache-friendly mode do nothing? We read Headroom's source: it can never find the "unchanged prefix" it is supposed to reuse.

To compress only the new messages, cache mode must first work out which part of the request it already saw last turn. It uses a strict test — *are the leading messages byte-for-byte identical to the copy I stored last turn?* — and if the answer is no, it gives up and forwards the whole request unchanged. On a Claude-SDK workload that test never passes, for two reasons:

- **The cache markers move.** The SDK tags a few messages with `cache_control` to tell Anthropic where the cached region ends, and it slides those tags further down the conversation as it grows. So even when the *text* of the early messages is unchanged, their JSON shape changes every turn — and the byte-for-byte test fails.
- **Sessions collide.** Headroom remembers "last turn's messages" under a key built from the model name plus the first 500 characters of the system prompt. Every developer agent has the same model and the same system prompt, so they all share one key and overwrite each other's stored state. When a new developer starts, the "previous messages" it compares against belong to a different task entirely.

We confirmed the first failure two ways. In isolation: feed Headroom's guard two requests whose prefix is *textually identical* but whose `cache_control` marker has shifted by one message, and it bails to passthrough every time — only a genuinely byte-stable prefix yields a delta. And on live traffic: routing a real Claude conversation through a logging proxy, the `cache_control` marker advances by one message every turn — it rides the latest user message (positions 0 → 3 → 5 → 7 → 9), and each turn the message that carried it last turn loses its ~48-byte annotation, breaking the byte-exact prefix. The guard returns `None` on **all four** consecutive turns. The marker moves *every* turn, not occasionally. Either failure alone is decisive; together they guarantee it — cache mode forwards everything and compresses nothing, exactly the passthrough we measured.

The conclusion is therefore broader than our workload: **this is a design-level incompatibility between Headroom's byte-exact guard and the Claude SDK's moving cache breakpoints.** A client that places *fixed* breakpoints and never reuses a session key — a hand-rolled API integration — would pass the test and could benefit; we didn't test that. But any standard Claude-SDK agent, which is what most people now mean by "an LLM agent," lands squarely in the passthrough case.

## RTK: compressing the wrong tool

RTK never hits the API — it wraps the `claude` CLI and rewrites *shell-command output* before it enters the context. The problem on our workload isn't that Bash output is too long; it's that, per operation, a Bash result barely weighs anything. Tool-result size by tool, across all 9 baseline developer instances:

| Tool | calls / instance | tokens **per call** | % of all tool tokens |
|---|--:|--:|--:|
| `Read` | 19.6 | 958 | **90.6%** |
| `Bash` | 17.2 | 77 | 6.4% |
| Edit / Write / other | ~13 | ~50 | 3.0% |

Read and Bash fire at nearly the same rate — yet **each Read result weighs ~958 tokens against Bash's ~77, a ~12× difference per operation.** That's the whole story. RTK's hook registers with the matcher `"Bash"` and compresses only shell output, so it trims the light, frequent calls and never sees the heavy `Read` results that make up 91% of the footprint; the native `Read` tool is never intercepted. (RTK ships an `rtk read` shell command that *could* route reads through the hook, but our agents used the native tool throughout, so that path was never exercised.) Even halving every Bash result would save ~650 tokens against a ~2,260k-token cacheRead footprint: 0.03%. The robust metrics agree — developer cc/cr is 2.41% baseline versus 2.43% RTK. RTK adds no overhead and breaks nothing; it simply has no material to work with here.

## Don't trust the proxy's own savings number

Headroom exposes a `/stats` endpoint reporting `cost_without` (what it claims you'd have paid without it) next to `cost_with`. In an earlier full-session experiment we ran, it reported `cost_without = $93.07` against an actual baseline session cost of **$61.56** — a **+51% overstatement**.

The reason: Headroom prices every context token at the full *uncached input* rate, assuming no caching would have happened without it. On a real session where ~95% of context tokens are cacheRead at $0.30/M (not input at $3.00/M), that counterfactual is a fiction — a worst case that never existed. Evaluated against its own stats endpoint, Headroom looks like it saves 30–50%. Measured against an actual baseline, token mode cost us money. **A compression tool's self-reported savings are measured against a no-cache hypothetical — always compare against a real baseline run.**

This blind spot is visible in Headroom's own community, and it's worth being fair about. Headroom is a popular, actively-developed tool (50k+ GitHub stars), and its README is candid that the reported savings are *counterfactual*. The result is a gap exactly where we landed: the one independent, reproducible benchmark its users have posted measures ~51% savings on **local backends (Ollama, LM Studio)** — which have no prompt cache, the very case where compression genuinely wins. Meanwhile the handful who reported the opposite against Claude — "negative savings," "context usage spikes, Claude Code consumes fewer tokens without it," "is the cache-aligner even tested with Claude's prompt caching?" — sit unanswered, a vote or two each. A silent failure plus a counterfactual savings number keeps the cache-heavy case invisible. Headroom is a capable tool aimed at the workload it fits; ours simply wasn't it.

## The principle: caching is the cost structure

What makes all of this unintuitive is how large cacheRead looks in the billing data. The developer task we dissected read **4,399,699 cacheRead tokens** over its life — while its context never exceeded **99,029 tokens**. How do you read 4.4M tokens from a 99k context?

Because **cacheRead is the integral of context over turns, not the context size.** That developer ran 62 turns; its context grew from ~9k tokens (turn 1) to ~99k (turn 62), adding ~1,475 per turn. Each turn re-reads the entire prefix so far. Sum across all 62 turns and you get 4.4M — the area under the growth curve. That isn't waste; it's the cache doing its job, charging each token's one write once and billing every re-read at a tenth of the price. It also explains where compression *would* have leverage, if it worked: a block removed on turn 5 saves 57 re-reads; a block removed on turn 60 saves almost nothing. The value is entirely front-loaded — and cache mode, the one tool positioned to exploit that, never compressed a single turn.

So, when do these tools pay off?

**They help when** the cache hit rate is low — short, isolated, one-shot requests with no stable prefix to reuse — or when the context genuinely approaches the model's window limit and you'd otherwise overflow.

**They hurt when** the hit rate is already high (>90%), the context is large and stable, and agents read many files across many turns — because any rewrite of the prefix pays the 12.5× write-over-read penalty on every subsequent turn. An agentic code workflow is the textbook worst case.

The tools we tested aren't bad products; they solve a real problem for a different workload. On ours, Anthropic's prompt cache had already captured the savings they were reaching for. Beyond "don't compress a cache-heavy agent," the durable lessons are about measurement:

1. **On a non-deterministic system, measure per comparable unit — per operation is finest — never a session total.** A session total mixes the tool's effect with how much work happened to occur.
2. **Anchor on intrinsic rates** like cc/cr, where the work volume cancels out, and look for *clean separation* across repetitions before believing an effect.
3. **Deduplicate streaming chunks by message id** when reading raw transcripts, or you'll double-count every token.
4. **Measure against a real baseline run**, never the proxy's own counterfactual estimator.

---

*All data from Atomic CRM Builder, June 2026. Methodology, the raw `/api/stats` JSON for all twelve runs, and the analysis scripts are in [`docs/headroom-experiment/`](https://github.com/marmelab/atomic-crm).*
