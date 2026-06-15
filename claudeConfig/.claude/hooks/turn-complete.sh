#!/bin/sh
# Stop hook: create a sentinel file so PtySession knows the turn is complete.
# PtySession watches /tmp/pty-sentinels/ for this file and emits its result
# event only after the JSONL transcript has been fully written (Stop fires
# after transcript flush). Dedicated subdir: watching all of /tmp would wake
# every session's watcher on every file any process creates in /tmp.
#
# Uses the `node -e` stdin idiom shared by the other hooks (readFileSync(0))
# rather than python3 — a slim image without python3 would otherwise leave the
# Stop sentinel uncreated and every turn would block on the 120 s silence
# timeout instead of completing promptly.
node -e '
const fs = require("fs");
let sid = "";
try { sid = (JSON.parse(fs.readFileSync(0, "utf8")).session_id) || ""; } catch {}
if (sid) {
  fs.mkdirSync("/tmp/pty-sentinels", { recursive: true });
  fs.closeSync(fs.openSync("/tmp/pty-sentinels/pty-turn-done-" + sid, "w"));
}
'
