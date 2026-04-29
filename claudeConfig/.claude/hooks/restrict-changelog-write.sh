#!/bin/bash
# PreToolUse / Write|Edit hook. The `changelog` agent may only modify the
# cross-session changelog at /chat-service/logs/changelog.json. Any other
# Write/Edit target is blocked. Pass-through for every other agent.

set -euo pipefail

ALLOWED="/chat-service/logs/changelog.json"

INPUT=$(cat)

node -e '
const ALLOWED = process.argv[1];
let env;
try {
  env = JSON.parse(process.argv[2]);
} catch {
  process.exit(0);
}

const agentType = env?.agent_type || "";
if (agentType !== "changelog") process.exit(0);

const filePath = env?.tool_input?.file_path || "";
if (filePath === ALLOWED) process.exit(0);

const reason = `Write/Edit blocked for changelog agent: only ${ALLOWED} may be modified. Attempted: ${filePath || "(empty path)"}`;
console.log(JSON.stringify({ decision: "block", reason }));
process.exit(0);
' "$ALLOWED" "$INPUT"
