#!/bin/bash
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

MODE=${MODE:-demo}

echo ""
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║   Atomic CRM + Claude Code                           ║${NC}"

if [ "$MODE" = "demo" ]; then
echo -e "${BOLD}${BLUE}║   Mode: DEMO  (FakeRest — no database required)      ║${NC}"
else
echo -e "${BOLD}${BLUE}║   Mode: FULL  (local Supabase)                       ║${NC}"
fi

echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ── API key check ─────────────────────────────────────────────
if [ -z "${ANTHROPIC_API_KEY}" ]; then
  echo -e "${RED}❌  ANTHROPIC_API_KEY is missing!${NC}"
  echo "    Add: -e ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi
echo -e "${GREEN}✓  Anthropic API key found${NC}"

cd ${APP_DIR}

# ── Select App.tsx variant based on mode ─────────────────────
if [ "$MODE" = "demo" ]; then
  cp /app-variants/App.fakerest.tsx src/App.tsx
  echo -e "${GREEN}✓  Data provider: FakeRest${NC}"
  SUPERVISOR_CONF=/etc/supervisor/conf.d/demo.conf
else
  # MODE=full
  cp /app-variants/App.supabase.tsx src/App.tsx
  echo -e "${GREEN}✓  Data provider: Supabase${NC}"

  # Check Docker socket (required for Supabase)
  if [ ! -S /var/run/docker.sock ]; then
    echo ""
    echo -e "${RED}❌  Docker socket not found!${NC}"
    echo "    In full mode, Supabase requires the Docker daemon."
    echo "    Add: -v /var/run/docker.sock:/var/run/docker.sock"
    echo ""
    echo "    Or switch to demo mode: -e MODE=demo"
    exit 1
  fi
  echo -e "${GREEN}✓  Docker socket available${NC}"

  # Add developer to the Docker socket group (GID varies per host)
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
  if ! getent group "$DOCKER_GID" > /dev/null 2>&1; then
    groupadd --gid "$DOCKER_GID" docker-host
  fi
  usermod -aG "$DOCKER_GID" developer
  echo -e "${GREEN}✓  developer added to Docker group (GID=${DOCKER_GID})${NC}"

  # Start Supabase
  echo ""
  echo -e "${BOLD}Starting Supabase...${NC}"
  echo -e "${YELLOW}(First run: ~2 min to pull images)${NC}"
  npx supabase start 2>&1 | grep -E "✓|✗|Error|Started|API URL" || true

  # Wait for Supabase API to actually be ready
  echo -e "${BOLD}Waiting for Supabase API (localhost:54321)...${NC}"
  RETRIES=60
  until curl -s --max-time 2 -o /dev/null http://localhost:54321; do
    RETRIES=$((RETRIES - 1))
    if [ $RETRIES -le 0 ]; then
      echo -e "${RED}❌  Supabase did not respond after 60s${NC}"
      echo "    Check: docker logs atomic-crm-full"
      exit 1
    fi
    sleep 1
  done
  echo -e "${GREEN}✓  Supabase ready (localhost:54321)${NC}"

  SUPERVISOR_CONF=/etc/supervisor/conf.d/full.conf
fi

# ── URL summary ───────────────────────────────────────────────
echo ""
echo -e "  ${BLUE}🌐  CRM              →  http://localhost:5173${NC}"
if [ "$MODE" = "full" ]; then
echo -e "  ${BLUE}🗄️   Supabase          →  http://localhost:54323${NC}"
fi
echo -e "  ${BLUE}🤖  Claude terminal   →  http://localhost:7681${NC}"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Open http://localhost:7681 and type:                 ${NC}"
echo -e "${YELLOW}  claude --dangerously-skip-permissions                ${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

exec /usr/bin/supervisord -n -c "$SUPERVISOR_CONF"
