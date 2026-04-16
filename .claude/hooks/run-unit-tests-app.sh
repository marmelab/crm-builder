#!/bin/bash
# Hook: run unit tests (app) after file edits
# asyncRewake: exits 0 on success, 2 on failure (wakes Claude with stderr)

cd "$CLAUDE_PROJECT_DIR" || exit 0

if CI=true npm run test:unit:app 2>&1; then
    exit 0
else
    CI=true npm run test:unit:app 2>&1 | tail -50 >&2
    exit 2
fi
