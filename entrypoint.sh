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

# ── Auth check — API key or OAuth token ───────────────────────
CLAUDE_DIR="/home/developer/.claude"
if [ -n "${ANTHROPIC_API_KEY}" ]; then
  echo -e "${GREEN}✓  Auth: API key${NC}"
elif [ -f "${CLAUDE_DIR}/.credentials.json" ] || [ -f "${CLAUDE_DIR}/credentials.json" ]; then
  echo -e "${GREEN}✓  Auth: OAuth token (claude login)${NC}"
else
  echo -e "${YELLOW}⚠️   No authentication found — starting terminal for claude login${NC}"
  echo ""
  echo -e "${BOLD}  → Open http://localhost:7681 in your browser${NC}"
  echo -e "  → Run: ${YELLOW}claude login${NC}"
  echo -e "  → Then restart this container (Ctrl+C, then docker compose up again)"
  echo ""
  export HOME=/home/developer
  exec /usr/local/bin/ttyd --port 7681 --writable --interface 0.0.0.0 /usr/local/bin/ttyd-session.sh
fi

# Always use the image's .claude config (volume may have stale copy)
cp -f /root/.claude/settings.json /home/developer/.claude/settings.json 2>/dev/null || true
for d in agents skills hooks rules; do
  if [ -d "/root/.claude/$d" ]; then
    rm -rf "/home/developer/.claude/$d" 2>/dev/null || true
    mkdir -p "/home/developer/.claude/$d"
    cp -rf "/root/.claude/$d/." "/home/developer/.claude/$d/" 2>/dev/null || true
  fi
done

# Fix ownership — credentials written during bootstrap run as root
chown -R developer:developer /home/developer/.claude 2>/dev/null || true

# Chat-service logs dir (bind-mounted in dev, needs developer write access)
mkdir -p /chat-service/logs 2>/dev/null || true
chmod 777 /chat-service/logs 2>/dev/null || true

# Runtime-generated docs (reflections, learnings) — bind-mounted from host ./crm-docs.
# On a fresh host, the directory may be empty and owned by root (if Docker runs as
# root on Linux) or by a host UID that doesn't match developer's UID. Without this
# chown the developer cannot write reflections and Mode 2 silently fails.
# Note: ticket files (TASK-XXX.json) live in /chat-service/logs/<sessionId>/ now,
# alongside log.jsonl and meta.json — chown'd via the chat-service logs block above.
mkdir -p /app/docs/reflections /app/docs/learnings/runs 2>/dev/null || true

if [ ! -f /app/docs/learnings/patterns.md ]; then
  cat > /app/docs/learnings/patterns.md <<'PATTERNS_EOF'
# Patterns ledger

This file is maintained by the `documentator` agent. Each entry below is a recurring friction pattern detected across reflections, hook failures, agent retries, stats, and user-side signals.

In phase 1 the entries are **read-only for humans**: only the documentator itself reads this file (to amend its own entries) — no other agent loads it as part of their working context, and no automatic action is taken. The maintainer reviews entries to validate the documentator's detection quality and the applicability of its proposed actions.

See the design spec at https://github.com/marmelab/crm-builder/blob/main/docs/superpowers/specs/2026-04-27-documentator-design.md for the full design.

---

<!-- Patterns appear below this line. Documentator preserves the file header verbatim. -->
PATTERNS_EOF
fi

chown -R developer:developer /app/docs 2>/dev/null || true

# Worktrees root — same reasoning. Bind-mounted from host, needs developer write
# access for `git worktree add /worktrees/TASK-XXX`.
mkdir -p /worktrees 2>/dev/null || true
chown -R developer:developer /worktrees 2>/dev/null || true

# Disable atomic-crm project's PostToolUse format-file.sh hook — replaced by a
# SubagentStop prettier hook in our crm-builder config. The PostToolUse variant
# caused an edit/prettier loop (developer edits → hook reformats → developer
# re-reads different bytes → confusion). The Stop-time hook checks cleanly
# once, fails loudly if not clean, and lets the developer batch-fix with
# `npm run prettier:apply` if needed.
if [ -f /app/.claude/settings.json ]; then
  printf '{\n  "hooks": {}\n}\n' > /app/.claude/settings.json
fi

cd ${APP_DIR}

# ── App.tsx variant helper (called here AND by merger after git reset) ─────
# Extracted to a standalone script so the merger can re-apply it after
# `git reset --hard HEAD` in /app (the reset silently reverts src/App.tsx to
# the tracked upstream form, which has no data provider wiring).
mkdir -p /entrypoint-helpers
cat > /entrypoint-helpers/apply-app-variant.sh <<'HELPER'
#!/bin/bash
# Copy the mode-appropriate App.tsx variant into /app/src/App.tsx.
# Reads MODE from env (default: demo). Idempotent.
set -e
MODE="${MODE:-demo}"
if [ "$MODE" = "full" ]; then
  cp /app-variants/App.supabase.tsx /app/src/App.tsx
else
  cp /app-variants/App.fakerest.tsx /app/src/App.tsx
fi
HELPER
chmod +x /entrypoint-helpers/apply-app-variant.sh

# ── Select App.tsx variant based on mode ─────────────────────
if [ "$MODE" = "demo" ]; then
  /entrypoint-helpers/apply-app-variant.sh
  echo -e "${GREEN}✓  Data provider: FakeRest${NC}"
  SUPERVISOR_CONF=/etc/supervisor/conf.d/demo.conf
else
  # MODE=full
  /entrypoint-helpers/apply-app-variant.sh
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
echo -e "  ${BLUE}💬  Chat assistant    →  http://localhost:8080${NC}"
echo -e "  ${BLUE}🤖  Claude terminal   →  http://localhost:7681${NC}"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  Open http://localhost:7681 and type:                 ${NC}"
echo -e "${YELLOW}  claude --dangerously-skip-permissions                ${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

exec /usr/bin/supervisord -n -c "$SUPERVISOR_CONF"
