#!/bin/bash
# PreCommit hook — runs typecheck before every commit.
# Blocks the commit if TypeScript errors are found.

echo "Running typecheck…"
OUTPUT=$(npm run typecheck 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ typecheck failed — commit blocked:" >&2
  echo "$OUTPUT" | tail -20 >&2
  echo "" >&2
  echo "Fix TypeScript errors before committing." >&2
  exit 2
fi

echo "✅ typecheck OK"
exit 0
