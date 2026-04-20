#!/bin/bash
# Hook: run e2e tests after file edits
# asyncRewake: exits 0 on success, 2 on failure (wakes Claude with stderr)

cd "$CLAUDE_PROJECT_DIR" || exit 0

# Skip in demo mode — Supabase (localhost:54341) is not running
if [ "${MODE:-demo}" = "demo" ]; then
  exit 0
fi

if npx playwright test 2>&1; then
    exit 0
else
    npx playwright test 2>&1 | tail -50 >&2
    exit 2
fi
