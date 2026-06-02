#!/bin/bash
# SubagentStop hook for quality-reviewer / test-validator (no-team flow).
#
# Records each reviewer's verdict as a per-ticket flag so the merger gate
# (block-merger-without-review.sh) can enforce dev -> reviewers -> merger.
# SubagentStop cannot block — it only records.
#
# Flag layout (presence == APPROVED):
#   /tmp/review-<SESSION_SHORT>-<TASK>-<role>
# Cleared on REJECTED here, and when a developer (re)starts the ticket
# (setup-worktree.sh) so a changed diff invalidates stale approvals.
#
# The verdict is read from the reviewer's transcript (final line is exactly
# `APPROVED` or `REJECTED: ...`). The transcript is located robustly because
# the SubagentStop stdin `transcript_path` is not always populated in the
# experimental teams runtime:
#   1. stdin.transcript_path (if it exists on disk)
#   2. $HOME/.claude/projects/*/*/subagents/agent-<agent_id>.jsonl
#   3. the session's claudeSessionId (from CHAT_SESSION_DIR/meta.json) →
#      its subagents dir, matched by agentType + TASK in the sibling .meta.json
# role + TASK come from `agent_type` (instance name, e.g. quality-reviewer-TASK-001).
set -u

LOG="${CHAT_SESSION_DIR:-/chat-service/logs}/hooks.log"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
SESSION_SHORT=$(basename "${CHAT_SESSION_DIR:-}" | cut -d'-' -f1)
[ -z "$SESSION_SHORT" ] && exit 0

STDIN=$(cat)

OUT=$(CHAT_SESSION_DIR="${CHAT_SESSION_DIR:-}" node -e '
const fs = require("fs");
const path = require("path");
const US = "\x1f";
function emit(role, task, verdict, used, dbg) {
  process.stdout.write([role || "", task || "", verdict || "", used || "", dbg || ""].join(US));
}
try {
  const i = JSON.parse(process.argv[1] || "{}");
  const at = i.agent_type || i.agentType || "";
  const role = (at.match(/quality-reviewer|test-validator/) || [""])[0];
  let task = (at.match(/TASK-\d+/) || [""])[0];
  const agentId = i.agent_id || i.agentId || "";
  const dbg = "keys=" + Object.keys(i).join(",") + " at=" + at + " aid=" + agentId + " tp=" + (i.transcript_path ? "y" : "n");
  if (!role) { emit("", "", "", "", dbg); process.exit(0); }

  const home = process.env.HOME || "/home/developer";
  const projects = path.join(home, ".claude", "projects");

  // Candidate transcript paths, most-authoritative first.
  const cands = [];
  if (i.transcript_path) cands.push(i.transcript_path);

  const listSubagentDirs = () => {
    const dirs = [];
    let slugs = []; try { slugs = fs.readdirSync(projects); } catch { return dirs; }
    for (const slug of slugs) {
      const sd = path.join(projects, slug);
      let csids = []; try { csids = fs.readdirSync(sd); } catch { continue; }
      for (const csid of csids) {
        const d = path.join(sd, csid, "subagents");
        try { if (fs.statSync(d).isDirectory()) dirs.push(d); } catch {}
      }
    }
    return dirs;
  };

  // 2. by agent_id
  if (agentId) {
    for (const d of listSubagentDirs()) {
      const f = path.join(d, "agent-" + agentId + ".jsonl");
      if (fs.existsSync(f)) cands.push(f);
    }
  }

  // 3. by claudeSessionId (from CHAT_SESSION_DIR/meta.json) + agentType/TASK match
  try {
    const csd = process.env.CHAT_SESSION_DIR;
    let csid = "";
    if (csd) { try { csid = JSON.parse(fs.readFileSync(path.join(csd, "meta.json"), "utf8")).claudeSessionId || ""; } catch {} }
    const dirs = listSubagentDirs().filter((d) => !csid || d.includes(csid));
    const matches = [];
    for (const d of dirs) {
      let files = []; try { files = fs.readdirSync(d); } catch { continue; }
      for (const f of files) {
        if (!/^agent-.*\.jsonl$/.test(f)) continue;
        const meta = f.replace(/\.jsonl$/, ".meta.json");
        let ok = false;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(d, meta), "utf8"));
          const aType = m.agentType || m.agent_type || "";
          const desc = m.description || "";
          if (aType === role && (!task || desc.includes(task))) ok = true;
        } catch {}
        if (ok) {
          const full = path.join(d, f);
          let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch {}
          matches.push({ full, mtime });
        }
      }
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    for (const m of matches) cands.push(m.full);
  } catch {}

  // Parse the first candidate that yields a decisive verdict.
  let verdict = "", used = "";
  for (const tp of cands) {
    if (!tp || !fs.existsSync(tp)) continue;
    let lastText = "";
    let body; try { body = fs.readFileSync(tp, "utf8"); } catch { continue; }
    for (const ln of body.split("\n")) {
      if (!ln.trim()) continue;
      let e; try { e = JSON.parse(ln); } catch { continue; }
      const msg = e.message || e;
      const content = msg && msg.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) lastText = b.text;
        }
      } else if (typeof content === "string" && content.trim()) {
        lastText = content;
      }
      if (!task) { const m = ln.match(/TASK-\d+/); if (m) task = m[0]; }
    }
    const tail = (lastText.trim().split("\n").map((s) => s.trim()).filter(Boolean).pop() || "");
    if (/^APPROVED\b/.test(tail)) { verdict = "APPROVED"; used = tp; break; }
    if (/^REJECTED\b/.test(tail)) { verdict = "REJECTED"; used = tp; break; }
  }
  emit(role, task, verdict, used, dbg);
} catch (e) { emit("", "", "", "", "err=" + (e && e.message)); }
' "$STDIN" 2>/dev/null || printf '\x1f\x1f\x1f\x1f')

US=$'\x1f'
IFS="$US" read -r ROLE TASK VERDICT USED DBG <<< "$OUT"

# Always log what we received — diagnostic for the experimental teams runtime.
echo "[$(date -Iseconds)] record-review role=${ROLE:-?} task=${TASK:-?} verdict=${VERDICT:-UNKNOWN} ${DBG}" >> "$LOG" 2>/dev/null || true

[ -z "$ROLE" ] && exit 0
[ -z "$TASK" ] && exit 0

FLAG="/tmp/review-${SESSION_SHORT}-${TASK}-${ROLE}"
if [ "$VERDICT" = "APPROVED" ]; then
  : > "$FLAG"
elif [ "$VERDICT" = "REJECTED" ]; then
  rm -f "$FLAG"
fi
# UNKNOWN: leave the flag untouched (don't wrongly clear a real prior APPROVED;
# a dev (re)start is what invalidates stale verdicts, via setup-worktree.sh).
exit 0
