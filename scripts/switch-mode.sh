#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  switch-mode — Toggle the CRM data provider
#
#  Usage:
#    switch-mode demo   → FakeRest (no Supabase required)
#    switch-mode full   → Supabase (real backend)
#
#  Vite detects the file change and automatically reloads
#  the browser.
# ─────────────────────────────────────────────────────────────
set -e

APP_DIR=${APP_DIR:-/app}
TARGET=${1:-}

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

if [ -z "$TARGET" ]; then
  echo "Usage: switch-mode [demo|full]"
  echo ""
  echo "  demo → FakeRest (in-memory data, no Supabase)"
  echo "  full → Supabase (local Postgres)"
  exit 1
fi

case "$TARGET" in
  demo)
    cp /app-variants/App.fakerest.tsx "${APP_DIR}/src/App.tsx"
    echo -e "${GREEN}✓  DEMO mode enabled — FakeRest${NC}"
    echo -e "${YELLOW}→  Reload localhost:5173 in your browser${NC}"
    echo ""
    echo "  Data is simulated in the browser."
    echo "  It resets on every page reload."
    ;;
  full)
    cp /app-variants/App.supabase.tsx "${APP_DIR}/src/App.tsx"
    echo -e "${GREEN}✓  FULL mode enabled — Supabase${NC}"
    echo -e "${YELLOW}→  Reload localhost:5173 in your browser${NC}"
    echo ""
    echo "  The CRM now points to local Supabase."
    echo "  If Supabase is not running: supabase start"
    ;;
  *)
    echo -e "${RED}Unknown mode: ${TARGET}${NC}"
    echo "Valid values: demo, full"
    exit 1
    ;;
esac
