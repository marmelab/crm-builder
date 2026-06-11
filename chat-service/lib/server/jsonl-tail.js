// Incremental tail of an append-mostly JSONL file by byte offset.
//
// Shared by the per-subagent transcript feed (subagent-tail.js) and the
// orchestrator main-transcript watcher (transcript-watcher.js). Both tail a
// file that Claude CLI writes progressively; reading by byte offset bounds the
// work per tick to the newly-appended bytes and never re-parses history.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

// Cap the in-memory buffer for one slice. A single multi-MB assistant event
// (big Bash output, large Read, base64 image) shouldn't balloon the heap and
// shouldn't trigger an O(N²) re-read while its writer is still flushing.
export const MAX_SLICE_BYTES = 1_048_576; // 1 MiB

// Read newly-appended bytes from `path` starting at `fromOffset`, returning
// `{ lines, newOffset }`. Only complete (\n-terminated) lines are returned;
// a trailing partial line is left for the next tick so we never JSON.parse a
// half-written event.
export async function readAppendedLines(path, fromOffset, lastMtimeMs) {
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  const currentSize = st.size;
  const currentMtimeMs = st.mtimeMs;
  // Same byte count + same mtime → genuinely unchanged. Same size but newer
  // mtime → activation rewrote the file in place; re-read from start.
  if (currentSize === fromOffset && currentMtimeMs === lastMtimeMs) {
    return { lines: [], newOffset: currentSize, mtimeMs: currentMtimeMs };
  }
  // File truncated to 0 while we held a non-zero offset: nothing readable now,
  // but capture the mtime so the next non-empty rewrite is detected.
  if (currentSize === 0) {
    return { lines: [], newOffset: 0, mtimeMs: currentMtimeMs };
  }
  // File rewritten / shrunk by a new activation → re-read from start.
  // uuid dedup prevents re-emitting events we've already seen.
  const start = currentSize < fromOffset ? 0 : fromOffset;
  if (currentSize - start > MAX_SLICE_BYTES) {
    // Slice exceeds the cap: skip to currentSize to avoid OOM and avoid
    // re-reading a huge partial line every tick. We may miss events from a
    // truly massive cumulative rewrite, but uuid dedup catches the common
    // case of an oversized SINGLE event followed by smaller ones.
    return { lines: [], newOffset: currentSize, mtimeMs: currentMtimeMs };
  }
  const stream = createReadStream(path, {
    start,
    end: currentSize - 1,
    encoding: "utf8",
  });
  let buf = "";
  for await (const chunk of stream) buf += chunk;
  const lastNL = buf.lastIndexOf("\n");
  if (lastNL === -1) {
    // No complete line in this slice. Don't advance the offset, but if the
    // partial-line tail is approaching the cap, jump past it next tick — we
    // can't usefully buffer multi-MB partials. The 90% threshold gives the
    // writer some room to finish on a normal-sized line.
    const next = (currentSize - start) > MAX_SLICE_BYTES * 0.9 ? currentSize : start;
    return { lines: [], newOffset: next, mtimeMs: currentMtimeMs };
  }
  return {
    lines: buf
      .slice(0, lastNL)
      .split("\n")
      .filter((l) => l.trim()),
    newOffset: start + lastNL + 1,
    mtimeMs: currentMtimeMs,
  };
}
