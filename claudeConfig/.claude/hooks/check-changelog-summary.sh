#!/bin/bash
# PreToolUse / Write hook. Enforces the 20-word maximum on `summary` fields
# inside /chat-service/logs/changelog.json. Pass-through for any other file.

set -euo pipefail

ENVELOPE=$(cat)

node -e '
const MAX_WORDS = 20;
const TARGET = "/chat-service/logs/changelog.json";

let envelope;
try {
  envelope = JSON.parse(process.argv[1]);
} catch {
  process.exit(0);
}

const filePath = envelope?.tool_input?.file_path || "";
if (filePath !== TARGET) process.exit(0);

const content = envelope?.tool_input?.content;
if (typeof content !== "string") process.exit(0);

let parsed;
try {
  parsed = JSON.parse(content);
} catch (e) {
  console.error(`changelog.json is not valid JSON: ${e.message}`);
  process.exit(2);
}

const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
const offenders = [];
for (const s of sessions) {
  const summary = typeof s?.summary === "string" ? s.summary : "";
  const words = summary.trim().split(/\s+/).filter(Boolean);
  if (words.length > MAX_WORDS) {
    offenders.push({ id: s?.session_id || "(no id)", count: words.length });
  }
}

if (offenders.length > 0) {
  const lines = offenders.map(
    (o) => `  - session ${o.id}: ${o.count} words (max ${MAX_WORDS})`
  );
  console.error(
    `changelog.json rejected: ${offenders.length} summary field(s) exceed ${MAX_WORDS} words.\n` +
    lines.join("\n") +
    `\nRewrite the offending summary to one short sentence (<= ${MAX_WORDS} words).`
  );
  process.exit(2);
}

process.exit(0);
' "$ENVELOPE"
