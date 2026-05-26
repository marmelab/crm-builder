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

import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { claudeSubagentsDir } from "./config.js";
import { broadcast } from "./ws-bus.js";

const POLL_INTERVAL_MS = 2500;

async function agentNameFor(metaPath, cache) {
  if (cache.has(metaPath)) return cache.get(metaPath);
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    const name = meta.agentType || null;
    if (name) cache.set(metaPath, name);
    return name;
  } catch {
    return null;
  }
}

// Read newly-appended bytes from `path` starting at `fromOffset`, returning
// `{ lines, newOffset }`. Only complete (\n-terminated) lines are returned;
// a trailing partial line is left for the next tick so we never JSON.parse a
// half-written event.
async function readAppendedLines(path, fromOffset) {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  const currentSize = st.size;
  if (currentSize === fromOffset) return { lines: [], newOffset: currentSize };
  // File rewritten / truncated by a new activation → re-read from start.
  // uuid dedup prevents re-emitting events we've already seen.
  const start = currentSize < fromOffset ? 0 : fromOffset;
  const stream = createReadStream(path, {
    start,
    end: currentSize - 1,
    encoding: "utf8",
  });
  let buf = "";
  for await (const chunk of stream) buf += chunk;
  const lastNL = buf.lastIndexOf("\n");
  if (lastNL === -1) return { lines: [], newOffset: start };
  return {
    lines: buf
      .slice(0, lastNL)
      .split("\n")
      .filter((l) => l.trim()),
    newOffset: start + lastNL + 1,
  };
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
      input: { to: block.input?.to, content: block.input?.content },
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
  const result = await readAppendedLines(jsonlPath, fromOffset);
  if (!result) return;
  runtime.subagentFileOffsets.set(jsonlPath, result.newOffset);
  if (!emit) return;
  for (const line of result.lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev.uuid || runtime.subagentSeenUuids.has(ev.uuid)) continue;
    runtime.subagentSeenUuids.add(ev.uuid);
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
  const baseDir = claudeSubagentsDir(runtime.claudeSessionId);

  if (runtime.subagentSeenUuids.size === 0) {
    await scanDir(runtime, baseDir, { emit: false });
  }

  let stopped = false;
  let scanning = false;
  const tick = async () => {
    if (stopped || scanning) return;
    scanning = true;
    try {
      await scanDir(runtime, baseDir, { emit: true });
    } finally {
      scanning = false;
    }
  };
  const interval = setInterval(tick, POLL_INTERVAL_MS);
  tick();

  runtime.subagentTailerStop = async () => {
    stopped = true;
    clearInterval(interval);
    // Final scan to catch subagent writes between the last interval tick and
    // the CLI exit — bounded to newly-appended bytes by the offset map.
    await scanDir(runtime, baseDir, { emit: true });
    runtime.subagentTailerStop = null;
  };
}

export async function stopSubagentTailer(runtime) {
  await runtime?.subagentTailerStop?.();
}
