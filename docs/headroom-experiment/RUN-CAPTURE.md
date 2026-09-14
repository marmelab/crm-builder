# Definitive cache-mode study — capture real request payloads

**Question this closes:** is Headroom *cache mode* incompatible with the Claude SDK for **every** turn, because the SDK moves its `cache_control` breakpoints inside the prompt prefix each turn (so Headroom's byte-exact guard always bails to passthrough)?

We already proved, from billing alone, that cache mode is a passthrough on our workload (no per-turn cacheCreate spikes; cc/cr unchanged across 12 developer instances). The **one** link we infer rather than observe is the per-turn marker movement, because the session transcripts do **not** record request-side `cache_control`. This run captures the actual requests the Claude SDK sends and confirms it directly.

> Note: this study does **not** require Headroom to be running. We only need the **client → Anthropic** request stream. The capture proxy forwards straight to `api.anthropic.com`.

> **Result (run 2026-06-26, `claude-vscode` entrypoint):** guard = `None` on **4/4** consecutive turns; the `cache_control` marker advanced 0 → 3 → 5 → 7 → 9 (one step every turn), each turn stripping the ~48-byte annotation off the prior marker-bearing message and breaking the byte-exact prefix. Mechanism confirmed on live traffic — cache mode passes through every turn, even for a solo conversation.

## Minimal variant (no builder, ~2 min)

You don't need the full Docker stack — any `claude` run that makes a few tool calls produces the same incremental-caching request stream. In a neutral directory:

```bash
cd docs/headroom-experiment
CAPTURE_OUT=$PWD/cap.jsonl node capture-proxy.mjs &          # terminal A (or backgrounded)
ANTHROPIC_BASE_URL=http://localhost:9000 \
  claude -p "List the *.mjs files here, read each, and summarise it in one line." \
  --dangerously-skip-permissions                            # terminal B — a few Read turns
node analyze-capture.mjs cap.jsonl                          # the verdict
```

(The capture proxy passes your OAuth bearer straight through to `api.anthropic.com`, so it works on the flat-rate subscription — no API-key budget spent. An assistant cannot launch this `claude -p … --dangerously-skip-permissions` step for you: the Claude Code safety classifier blocks nested autonomous agents, so this one command is yours to run.)

## Steps (full builder)

1. **Start the capture proxy** (host or inside the instance container — wherever the `claude` processes can reach it):

   ```bash
   cd docs/headroom-experiment
   CAPTURE_OUT=$PWD/captured-requests.jsonl CAPTURE_PORT=9000 node capture-proxy.mjs
   ```

2. **Point the builder's `claude` processes at the proxy.** `pty-session.js` already spreads `process.env` into every spawn, so exporting it for the chat-service is enough:

   ```bash
   ANTHROPIC_BASE_URL=http://<host-reachable-ip>:9000   # e.g. http://host.docker.internal:9000
   ```

   (OAuth bearer / `x-api-key` headers are passed through unchanged.)

3. **Run a SHORT workload** so the capture stays small — a single small ticket is enough to see the marker move across a dozen turns. Reuse the replay driver with `simple-test-messages.json`, or just send one request in the UI and answer "No" to the satisfaction ask.

4. **Analyse:**

   ```bash
   node analyze-capture.mjs captured-requests.jsonl
   ```

## What to expect

For each consecutive pair of requests within the same session key, the analyser prints whether the `cache_control` marker moved inside the prefix and whether the guard returns `None` (passthrough) or a `DELTA` (compression). If the hypothesis holds:

- **prefix marker moved ≈ all pairs** — confirms the SDK advances the breakpoint every turn, and
- **guard=None ≈ all pairs** — confirms cache mode passes through every turn.

That turns the last inferred link into a measured one, and makes the "design-level incompatibility with the Claude SDK" claim airtight.

## Optional: end-to-end (Headroom in the loop)

To also observe Headroom's own decision, chain `client → capture-proxy → Headroom → api.anthropic.com` by setting the proxy's `CAPTURE_UPSTREAM` to the Headroom host and running Headroom with `HEADROOM_DEBUG` (if available) to log its `_extract_cache_stable_delta` verdicts. Not needed for the core result above.
