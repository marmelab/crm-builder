#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  apply-migrations — Apply committed migrations to the local
#  Supabase instance.
#
#  Usage:
#    apply-migrations
#
#  Behaviour:
#    Migrations are already committed to supabase/migrations/ on
#    main (written by the deploy-time migration round and merged
#    by the merger) before this script runs. There is nothing to
#    promote — this script only applies what is already there.
#
#    If Supabase is not running: start it (initial start applies
#    every migration in supabase/migrations/).
#    If Supabase is already running: run `npx supabase migration up`.
#
#    After applying, the PostgREST schema cache is reloaded so
#    new columns/tables are visible immediately.
# ─────────────────────────────────────────────────────────────
set -e

APP_DIR=${APP_DIR:-/app}
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

if [ ! -S /var/run/docker.sock ]; then
  echo -e "${RED}Docker socket not found - Supabase requires the Docker daemon.${NC}" >&2
  exit 1
fi

cd "${APP_DIR}"

mkdir -p supabase/migrations

# ── Apply migrations to local Supabase ──
if curl -s --max-time 2 -o /dev/null http://localhost:54321; then
  echo -e "${BOLD}Applying pending migrations to running Supabase...${NC}"
  MIG_OUT=$(npx supabase migration up 2>&1)
  MIG_EXIT=$?
  if [ $MIG_EXIT -ne 0 ]; then
    # Auto-repair phantom versions that are recorded in Supabase but absent from
    # the local migrations/ directory (happens when a prior session's worktree was
    # cleaned up after applying the migration but before it landed in git).
    if echo "$MIG_OUT" | grep -q "Remote migration versions not found in local migrations directory"; then
      PHANTOM_VERSIONS=$(echo "$MIG_OUT" | grep -oE '[0-9]{14}' | sort -u | tr '\n' ' ' | sed 's/ $//')
      if [ -n "$PHANTOM_VERSIONS" ]; then
        # shellcheck disable=SC2086
        npx supabase migration repair --status reverted $PHANTOM_VERSIONS 2>/dev/null
        MIG_OUT=$(npx supabase migration up 2>&1)
        MIG_EXIT=$?
      fi
    fi
    if [ $MIG_EXIT -ne 0 ]; then
      echo "$MIG_OUT" >&2
      echo -e "${RED}Migration up failed.${NC}" >&2
      exit 1
    fi
  fi
  echo -e "${GREEN}Migrations applied.${NC}"
  # Reload PostgREST schema cache so new columns/tables are visible immediately.
  npx supabase db execute --sql "SELECT pg_notify('pgrst', 'reload schema');" 2>/dev/null \
    && echo -e "${GREEN}PostgREST schema cache reloaded.${NC}" \
    || echo -e "${YELLOW}Could not reload PostgREST schema cache (non-fatal).${NC}"
else
  echo -e "${BOLD}Starting Supabase (initial start applies all migrations)...${NC}"
  echo -e "${YELLOW}First run can take up to ~2 min to pull images.${NC}"
  npx supabase start 2>&1 | grep -E "✓|✗|Error|Started|API URL" || true

  echo -e "${BOLD}Waiting for Supabase API (localhost:54321)...${NC}"
  RETRIES=120
  until curl -s --max-time 2 -o /dev/null http://localhost:54321; do
    RETRIES=$((RETRIES - 1))
    if [ $RETRIES -le 0 ]; then
      echo -e "${RED}Supabase did not respond after 120s.${NC}" >&2
      exit 1
    fi
    sleep 1
  done
  echo -e "${GREEN}Supabase ready and all migrations applied.${NC}"
  # Reload PostgREST schema cache after initial start.
  npx supabase db execute --sql "SELECT pg_notify('pgrst', 'reload schema');" 2>/dev/null \
    && echo -e "${GREEN}PostgREST schema cache reloaded.${NC}" \
    || echo -e "${YELLOW}Could not reload PostgREST schema cache (non-fatal).${NC}"
fi
