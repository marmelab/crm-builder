#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  switch-mode — Toggle the CRM data provider at runtime
#
#  Usage:
#    switch-mode demo   → FakeRest (no Supabase required)
#    switch-mode full   → Supabase (starts it if not running)
#
#  Vite detects the App.tsx change and hot-reloads the browser.
# ─────────────────────────────────────────────────────────────
set -e

APP_DIR=${APP_DIR:-/app}
TARGET=${1:-}

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

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
    echo -e "${GREEN}✓  Demo mode — FakeRest${NC}"
    echo "  Data is simulated in the browser and resets on page reload."
    ;;

  full)
    if [ ! -S /var/run/docker.sock ]; then
      echo -e "${RED}❌  Docker socket not found${NC}"
      echo "    Full mode requires the Docker daemon."
      exit 1
    fi

    cp /app-variants/App.supabase.tsx "${APP_DIR}/src/App.tsx"
    echo -e "${GREEN}✓  Full mode — Supabase${NC}"

    # Start Supabase only if not already listening
    if curl -s --max-time 2 -o /dev/null http://localhost:54321; then
      echo -e "${GREEN}✓  Supabase already running${NC}"
    else
      echo ""
      echo -e "${BOLD}Starting Supabase...${NC}"
      echo -e "${YELLOW}(First run: ~2 min to pull images)${NC}"
      (cd "${APP_DIR}" && npx supabase start 2>&1 | grep -E "✓|✗|Error|Started|API URL") || true

      echo -e "${BOLD}Waiting for Supabase API (localhost:54321)...${NC}"
      RETRIES=120
      until curl -s --max-time 2 -o /dev/null http://localhost:54321; do
        RETRIES=$((RETRIES - 1))
        if [ $RETRIES -le 0 ]; then
          echo -e "${RED}❌  Supabase did not respond after 120s${NC}"
          exit 1
        fi
        sleep 1
      done
      echo -e "${GREEN}✓  Supabase ready (localhost:54321)${NC}"
    fi
    ;;

  *)
    echo -e "${RED}Unknown mode: ${TARGET}${NC}"
    echo "Valid values: demo, full"
    exit 1
    ;;
esac
