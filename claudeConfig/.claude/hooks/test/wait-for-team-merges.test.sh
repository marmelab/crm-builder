#!/bin/bash
# Tests for wait-for-team-merges.sh
# The script polls a team-lead inbox for merger reports and returns a JSON
# summary. It must:
#  - Return immediately when the current count >= expected (done=true).
#  - Return immediately when the current count > last_count (new progress).
#  - Time out after ~60s when nothing is observable, with timeout=true.
#  - Treat missing/malformed inbox as zero merger reports.
#  - Always exit 0 (the orchestrator interprets the JSON output).

set -u

HOOK="$(cd "$(dirname "$0")" && cd .. && pwd)/wait-for-team-merges.sh"

PASS=0
FAIL=0

# Each test runs in its own HOME so the script's inbox path is isolated.
make_inbox() {
  local home_dir="$1"
  local team="${2:-tickets}"
  local content="$3"
  mkdir -p "$home_dir/.claude/teams/$team/inboxes"
  printf '%s' "$content" > "$home_dir/.claude/teams/$team/inboxes/team-lead.json"
}

run_case() {
  local label="$1"; shift
  local expected_field="$1"; shift   # e.g. '"done":true'
  local expected_exit="$1"; shift
  # remaining args = passed to the hook
  local home_dir
  home_dir=$(mktemp -d)

  # Optional inbox setup via env vars: $INBOX_JSON, $INBOX_TEAM
  if [ -n "${INBOX_JSON:-}" ]; then
    make_inbox "$home_dir" "${INBOX_TEAM:-tickets}" "$INBOX_JSON"
  fi

  local out actual_exit
  out=$(HOME="$home_dir" "$HOOK" "$@" 2>&1)
  actual_exit=$?
  rm -rf "$home_dir"

  local ok=1
  if [ "$actual_exit" != "$expected_exit" ]; then ok=0; fi
  if ! echo "$out" | grep -qF "$expected_field"; then ok=0; fi

  if [ $ok = 1 ]; then
    echo "PASS — $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL — $label"
    echo "       expected exit=$expected_exit field=$expected_field"
    echo "       got exit=$actual_exit output=$out"
    FAIL=$((FAIL + 1))
  fi
}

# 1. No inbox file — count is 0, expected 1 → must wait (don't return early).
#    We can't sit through the full 60s timeout in tests; smoke-check just that
#    the script outputs `"timeout":true` IF we shorten the deadline. The script
#    has its 60s budget hardcoded, so instead we drive expected=0: target hit
#    immediately, no waiting.
INBOX_JSON="" run_case "missing inbox, expected=0 → done immediately" \
  '"done":true' 0 0 0 tickets

# 2. Empty inbox file → 0 reports, expected=0 → done.
INBOX_JSON='[]' run_case "empty inbox, expected=0 → done" \
  '"count_received":0' 0 0 0 tickets

# 3. Inbox has 1 merger report, expected=1 → done.
INBOX_JSON='[{"from":"merger","text":"merged TASK-001, commit=abc123"}]' \
  run_case "one merge report, expected=1 → done" \
  '"done":true' 0 1 0 tickets

# 4. Inbox has 1 report, expected=2 → not done yet, but new progress → return now.
INBOX_JSON='[{"from":"merger","text":"merged TASK-001, commit=abc"}]' \
  run_case "one new report, expected=2, last=0 → new_reports populated" \
  '"new_reports":["merged TASK-001, commit=abc"]' 0 2 0 tickets

# 5. Inbox has 2 reports, expected=3, last=1 → return new slice (only the 2nd).
INBOX_JSON='[{"from":"merger","text":"merged TASK-001, commit=a"},{"from":"merger","text":"merged TASK-002, commit=b"}]' \
  run_case "two reports, last=1 → only second report returned" \
  '"new_reports":["merged TASK-002, commit=b"]' 0 3 1 tickets

# 6. Non-merger sender ignored.
INBOX_JSON='[{"from":"developer-TASK-001","text":"hello"},{"from":"merger","text":"merged TASK-001, commit=x"}]' \
  run_case "non-merger sender filtered out" \
  '"count_received":1' 0 1 0 tickets

# 7. Merger report with merge failed → counted.
INBOX_JSON='[{"from":"merger","text":"TASK-001 merge failed: conflict in src/a.ts"}]' \
  run_case "merge failed counted as report" \
  '"count_received":1' 0 1 0 tickets

# 8. Malformed inbox (not JSON) → 0 reports, no crash.
INBOX_JSON='not valid json' run_case "malformed inbox → 0 reports, no crash" \
  '"count_received":0' 0 0 0 tickets

# 9. Inbox is a non-array JSON value → 0 reports.
INBOX_JSON='{"oops":"object"}' run_case "non-array inbox → 0 reports" \
  '"count_received":0' 0 0 0 tickets

# 10. Custom team name → script looks in the right path.
INBOX_JSON='[{"from":"merger","text":"merged TASK-001, commit=z"}]' \
  INBOX_TEAM="my-team" \
  run_case "custom team name routes inbox path" \
  '"done":true' 0 1 0 my-team

# 11. Random `message` field instead of `text` (Claude Code variant) → still parsed.
INBOX_JSON='[{"from":"merger","message":"merged TASK-007, commit=zzz"}]' \
  run_case "inbox entry with `message` field instead of `text`" \
  '"count_received":1' 0 1 0 tickets

# 12. Two merger entries that don't match the merge regex → 0 reports.
INBOX_JSON='[{"from":"merger","text":"I am ready"},{"from":"merger","text":"checking branch"}]' \
  run_case "merger sender but non-merge text → 0 reports" \
  '"count_received":0' 0 0 0 tickets

echo
echo "=========================================="
echo "Tests passed: $PASS"
echo "Tests failed: $FAIL"
[ "$FAIL" = "0" ]
