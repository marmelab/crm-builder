#!/bin/sh
# Stop hook: create a sentinel file so PtySession knows the turn is complete.
# PtySession watches /tmp for this file and emits its result event only after
# the JSONL transcript has been fully written (Stop fires after transcript flush).
python3 -c "
import sys, json
data = json.load(sys.stdin)
session_id = data.get('session_id', '')
if session_id:
    open('/tmp/pty-turn-done-' + session_id, 'w').close()
"
