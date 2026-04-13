#!/bin/bash
# PreCommit hook — runs typecheck before every commit.
# Blocks the commit if TypeScript errors are found.

echo "Running typecheck…"
OUTPUT=$(npm run typecheck 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ typecheck failed — commit blocked:"
  echo "$OUTPUT" | tail -20
  echo ""
  echo "Fix TypeScript errors before committing."
  echo "To bypass in an emergency: git commit --no-verify (use sparingly)"
  exit 1
fi

echo "✅ typecheck OK"
exit 0