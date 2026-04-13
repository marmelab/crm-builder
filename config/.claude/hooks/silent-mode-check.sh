#!/bin/bash
# PreToolUse hook — blocks commands that open browser windows.
# Rules: Playwright without --headless, Vite with --open, Vitest with browser.ui.

input=$(cat)
command=$(node -e "const i=JSON.parse(process.argv[1]);console.log((i.tool_input&&i.tool_input.command)||'')" "$input" 2>/dev/null)

if [ -z "$command" ]; then
  exit 0
fi

# Playwright: must always use --headless
if echo "$command" | grep -qE 'playwright'; then
  if echo "$command" | grep -qE '(screenshot|test|codegen)' && ! echo "$command" | grep -q '\-\-headless'; then
    echo '{"decision":"block","reason":"Playwright must always use --headless. Add --headless to the command."}'
    exit 0
  fi
fi

# Vite: forbid --open
if echo "$command" | grep -qE 'vite|npm run (dev|start|start-demo)'; then
  if echo "$command" | grep -q '\-\-open'; then
    echo '{"decision":"block","reason":"Vite must not use --open (opens a browser window). Remove the --open flag."}'
    exit 0
  fi
fi

exit 0