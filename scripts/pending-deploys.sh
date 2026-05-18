#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  pending-deploys — List ticket ids that still need a
#  Supabase deploy, by combining the per-ticket
#  `requires_supabase_migration` + `status` fields with the
#  orchestrator's `.deploy-applied` ledger.
#
#  Usage:
#    pending-deploys <TICKETS_DIR>
#
#  Prints one TASK-XXX id per line, on stdout. Prints nothing
#  when there are no pending tickets. Exit code is always 0
#  (an empty list is a valid result, not an error).
# ─────────────────────────────────────────────────────────────
set -e

DIR="${1:?TICKETS_DIR argument required}"

if [ ! -d "$DIR" ]; then
  exit 0
fi

node -e '
const fs = require("fs");
const path = require("path");
const dir = process.argv[1];
const applied = new Set();
try {
  fs.readFileSync(path.join(dir, ".deploy-applied"), "utf8")
    .split("\n").filter(Boolean).forEach(t => applied.add(t.trim()));
} catch {}
const pending = [];
for (const f of fs.readdirSync(dir).filter(x => /^TASK-\d+\.json$/.test(x))) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (j.status === "merged"
        && j.requires_supabase_migration === true
        && !applied.has(j.ticket_id)) {
      pending.push(j.ticket_id);
    }
  } catch {}
}
console.log(pending.join("\n"));
' "$DIR"
