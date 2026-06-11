// Real-time tail of per-subagent transcripts.
//
// Subagent text + SendMessage content live in `agent-<task_id>.jsonl` files
// written progressively by Claude CLI under `claudeSubagentsDir(csid)` — they
// are never streamed into the orchestrator's main stdout. Without tailing them
// the chat UI cannot show what a developer/reviewer actually said when they
// roundtripped a SendMessage.
//
// Per-file byte offsets + uuid dedup: offset bounds the work per tick to the
// newly-appended bytes; uuid dedup is the safety net when an activation
// rewrites a file (each SendMessage wake-up of a subagent writes a new
// cumulative transcript snapshot).

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { claudeSubagentsDir } from "./config.js";
import { broadcast } from "./ws-bus.js";
import { noteRateLimit } from "./runtime.js";
import { readAppendedLines } from "./jsonl-tail.js";

const POLL_INTERVAL_MS = 2500;
// Cache a "no agentType available" verdict for a short window so a transcript
// whose meta.json is missing/incomplete doesn't burn a readFile every tick.
const NEGATIVE_META_TTL_MS = 30_000;

async function agentNameFor(metaPath, cache) {
  const cached = cache.get(metaPath);
  if (cached) {
    if (typeof cached === "string") return cached;
    if (cached.until > Date.now()) return null;
  }
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    const name = meta.agentType || null;
    if (name) cache.set(metaPath, name);
    else cache.set(metaPath, { until: Date.now() + NEGATIVE_META_TTL_MS });
    return name;
  } catch {
    cache.set(metaPath, { until: Date.now() + NEGATIVE_META_TTL_MS });
    return null;
  }
}

function stringifyContent(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  try { return JSON.stringify(raw); } catch { return String(raw); }
}

function emitFromBlock(runtime, agentName, block) {
  if (block.type === "text") {
    if (!block.text?.trim()) return;
    broadcast(runtime, {
      type: "debug",
      tool: "agent_output",
      input: { agent: agentName, text: block.text },
      agent: agentName,
    });
  } else if (block.type === "tool_use" && block.name === "SendMessage") {
    broadcast(runtime, {
      type: "debug",
      tool: "SendMessage",
      input: {
        to: block.input?.to,
        content: stringifyContent(block.input?.message ?? block.input?.content),
      },
      agent: agentName,
    });
  }
}

async function processFile(runtime, jsonlPath, { emit }) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  const agentName = await agentNameFor(
    metaPath,
    runtime.subagentAgentTypeCache,
  );
  if (!agentName) return;
  const fromOffset = runtime.subagentFileOffsets.get(jsonlPath) ?? 0;
  const lastMtimeMs = runtime.subagentFileMtimes.get(jsonlPath) ?? 0;
  const result = await readAppendedLines(jsonlPath, fromOffset, lastMtimeMs);
  if (!result) return;
  runtime.subagentFileOffsets.set(jsonlPath, result.newOffset);
  runtime.subagentFileMtimes.set(jsonlPath, result.mtimeMs);
  // Subagent transcript growth = the team is still working. Feed turn.js's
  // inactivity watchdog so it never kills a live COMPLEX team whose progress
  // shows up here rather than on the orchestrator's (idle) main stream.
  if (emit && result.lines.length > 0) runtime.lastStreamActivityMs = Date.now();
  // Always seed uuid dedup, even in the dry pass. Skipping the loop here would
  // leave subagentSeenUuids empty, so a later truncation/rewrite (start=0)
  // would re-broadcast every prior event.
  for (const line of result.lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev.uuid || runtime.subagentSeenUuids.has(ev.uuid)) continue;
    runtime.subagentSeenUuids.add(ev.uuid);
    if (!emit) continue;
    // A subagent that hits the 5h limit logs a blocked rate_limit_event here —
    // it never reaches the orchestrator's main stdout, so without this the
    // spawn hangs forever. Flag it + kill the spawn; turn.js folds the pending
    // limit into the turn outcome and settles on `rate_limited`.
    if (ev.type === "rate_limit_event" && ev.rate_limit_info?.status === "blocked") {
      noteRateLimit(runtime, ev.rate_limit_info);
      continue;
    }
    if (ev.type !== "assistant") continue;
    const blocks = ev.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) emitFromBlock(runtime, agentName, b);
  }
}

async function scanDir(runtime, baseDir, { emit }) {
  let entries;
  try {
    entries = await readdir(baseDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    try {
      await processFile(runtime, join(baseDir, entry), { emit });
    } catch {}
  }
}

// Start polling the subagents directory for `runtime.claudeSessionId`. The
// dry-pass is skipped when the runtime has already seen events from prior
// turns — those uuids are still in the dedup set, so the regular polling
// loop will naturally skip them.
export async function startSubagentTailer(runtime) {
  if (!runtime || runtime.subagentTailerStop) return;
  if (!runtime.claudeSessionId) return;

  // Claim the stop slot synchronously, before any await. turn.js fires
  // startSubagentTailer un-awaited on every event carrying a session_id, AND
  // calls stopSubagentTailer in its finally block once the spawn exits — so
  // two races both have to be handled here:
  //   (a) concurrent starts: the early-return on subagentTailerStop must
  //       reject the second caller before it can also create a setInterval.
  //   (b) stop arriving during startup: stopSubagentTailer must find a real
  //       callback (not null) so it can signal the in-flight start to abort.
  // Both are satisfied by assigning subagentTailerStop before the dry-pass
  // await, with a shared `stopped` flag the dry pass checks afterward.
  const baseDir = claudeSubagentsDir(runtime.claudeSessionId);
  let stopped = false;
  let scanning = false;
  let interval = null;

  runtime.subagentTailerStop = async () => {
    stopped = true;
    if (interval) {
      clearInterval(interval);
      // Final scan to catch subagent writes between the last interval tick and
      // the CLI exit — bounded to newly-appended bytes by the offset map.
      // Skipped when stop fires before startup completes (no interval to flush).
      await scanDir(runtime, baseDir, { emit: true });
    }
    runtime.subagentTailerStop = null;
  };

  if (runtime.subagentSeenUuids.size === 0) {
    await scanDir(runtime, baseDir, { emit: false });
  }
  if (stopped) return;

  const tick = async () => {
    if (stopped || scanning) return;
    scanning = true;
    try {
      await scanDir(runtime, baseDir, { emit: true });
    } finally {
      scanning = false;
    }
  };
  interval = setInterval(tick, POLL_INTERVAL_MS);
  tick();
}

export async function stopSubagentTailer(runtime) {
  await runtime?.subagentTailerStop?.();
}
