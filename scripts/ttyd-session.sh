#!/bin/bash
# ttyd session script — displayed on every web terminal connection
# Called by Supervisor via ttyd

cd "${APP_DIR:-/app}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"

clear

if [ "${MODE:-demo}" = "full" ]; then
    echo '┌─────────────────────────────────────────────────────┐'
    echo '│  Claude Code — Atomic CRM                           │'
    echo '│  Mode: FULL (local Supabase)                        │'
    echo '├─────────────────────────────────────────────────────┤'
    echo '│                                                     │'
    echo '│  CRM         →  http://localhost:5173               │'
    echo '│  Supabase    →  http://localhost:54323              │'
    echo '│                                                     │'
    echo '│  Start Claude:                                      │'
    echo '│  claude --dangerously-skip-permissions              │'
    echo '│                                                     │'
    echo '│  Switch to demo mode:                               │'
    echo '│  switch-mode demo                                   │'
    echo '│                                                     │'
    echo '│  Apply a Supabase migration:                        │'
    echo '│  npx supabase db push                               │'
    echo '│                                                     │'
    echo '└─────────────────────────────────────────────────────┘'
else
    echo '┌─────────────────────────────────────────────────────┐'
    echo '│  Claude Code — Atomic CRM                           │'
    echo '│  Mode: DEMO (FakeRest — simulated data)             │'
    echo '├─────────────────────────────────────────────────────┤'
    echo '│                                                     │'
    echo '│  CRM         →  http://localhost:5173               │'
    echo '│                                                     │'
    echo '│  Start Claude:                                      │'
    echo '│  claude --dangerously-skip-permissions              │'
    echo '│                                                     │'
    echo '│  Switch to Supabase mode (after validation):        │'
    echo '│  switch-mode full                                   │'
    echo '│                                                     │'
    echo '└─────────────────────────────────────────────────────┘'
fi

echo ''
exec /bin/bash
