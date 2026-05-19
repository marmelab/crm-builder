#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  apply-migrations — Promote pending migrations to active,
#  then apply them to the local Supabase.
#
#  Usage:
#    apply-migrations <SESSION_SHORT_ID> TASK-001 [TASK-002 ...]
#
#  Behaviour:
#    1. For each TASK-XXX argument, find files matching
#       `supabase/migrations-pending/*_<SESSION_SHORT_ID>_<TASK-XXX>_*.sql`
#       and `git mv` them to `supabase/migrations/`. The
#       SESSION_SHORT_ID prefix scopes the match so a different
#       chat session's refused pending migration (which happens
#       to share a TASK-XXX id with this session) is never
#       picked up.
#    2. Commit the moves on main (one commit covering every
#       promoted file).
#    3. If Supabase is not running: start it (initial start
#       applies every migration in supabase/migrations/).
#       Otherwise: run `npx supabase migration up`.
#
#  Migrations the user has NOT approved stay in
#  supabase/migrations-pending/ and are NEVER picked up by
#  Supabase CLI, even from a later session.
# ─────────────────────────────────────────────────────────────
set -e

APP_DIR=${APP_DIR:-/app}
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

if [ "$#" -lt 2 ]; then
  echo "Usage: apply-migrations <SESSION_SHORT_ID> TASK-001 [TASK-002 ...]" >&2
  exit 2
fi

SESSION_SHORT_ID="$1"
shift

case "$SESSION_SHORT_ID" in
  [a-z0-9]*) ;;
  *)
    echo -e "${RED}Invalid SESSION_SHORT_ID: '${SESSION_SHORT_ID}'.${NC}" >&2
    exit 2
    ;;
esac

if [ ! -S /var/run/docker.sock ]; then
  echo -e "${RED}Docker socket not found - Supabase requires the Docker daemon.${NC}" >&2
  exit 1
fi

cd "${APP_DIR}"

mkdir -p supabase/migrations supabase/migrations-pending

# ── Phase 1 — promote pending files matching this session + each TASK-XXX ──
PROMOTED=()
for TASK in "$@"; do
  case "$TASK" in
    TASK-*) ;;
    *)
      echo -e "${RED}Invalid argument: '${TASK}' (expected TASK-XXX).${NC}" >&2
      exit 2
      ;;
  esac
  # Primary pattern uses the canonical hyphen form (TASK-001).
  # Fallback also accepts the underscore form (TASK_001) in case the developer
  # replaced the hyphen when applying the "underscores in slug" convention.
  TASK_US="${TASK//-/_}"
  MATCHES=$(find supabase/migrations-pending -maxdepth 1 -type f \
    \( -name "*_${SESSION_SHORT_ID}_${TASK}_*.sql" \
    -o -name "*_${SESSION_SHORT_ID}_${TASK_US}_*.sql" \) 2>/dev/null || true)
  if [ -z "$MATCHES" ]; then
    echo -e "${YELLOW}No pending migration file matches session ${SESSION_SHORT_ID} + ${TASK}; skipping.${NC}"
    continue
  fi
  while IFS= read -r SRC; do
    [ -n "$SRC" ] || continue
    DST="supabase/migrations/$(basename "$SRC")"
    if [ -e "$DST" ]; then
      echo -e "${YELLOW}${DST} already exists; not overwriting.${NC}"
      continue
    fi
    git mv "$SRC" "$DST"
    PROMOTED+=("$DST")
    echo -e "${GREEN}Promoted $(basename "$SRC")${NC}"
  done <<<"$MATCHES"
done

if [ "${#PROMOTED[@]}" -gt 0 ]; then
  git commit -m "chore(supabase): apply pending migrations (${SESSION_SHORT_ID}): $*" >/dev/null
  echo -e "${GREEN}Committed ${#PROMOTED[@]} migration file(s) on main.${NC}"
else
  # Nothing was promoted. Check whether any SQL files remain in migrations-pending —
  # if so, they exist but their names don't match the expected pattern, which means
  # the developer didn't follow the naming convention. Fail loudly so the orchestrator
  # does NOT write .deploy-applied and the user is not misled.
  STRAYS=$(find supabase/migrations-pending -maxdepth 1 -type f -name "*.sql" 2>/dev/null || true)
  if [ -n "$STRAYS" ]; then
    echo -e "${RED}ERROR: SQL files exist in supabase/migrations-pending/ but none match" >&2
    echo -e "       the expected pattern: *_${SESSION_SHORT_ID}_<TASK-XXX>_*.sql${NC}" >&2
    echo -e "${RED}Found:${NC}" >&2
    echo "$STRAYS" | while IFS= read -r f; do echo "  $f" >&2; done
    echo -e "${RED}Fix: rename the file(s) to include the session ID '${SESSION_SHORT_ID}' and the correct TASK-XXX.${NC}" >&2
    exit 1
  fi
  echo -e "${YELLOW}Nothing to promote (no files in migrations-pending). Continuing in case a previous run already promoted files.${NC}"
fi

# ── Phase 2 — apply migrations to local Supabase ──
if curl -s --max-time 2 -o /dev/null http://localhost:54321; then
  echo -e "${BOLD}Applying pending migrations to running Supabase...${NC}"
  if ! npx supabase migration up 2>&1; then
    echo -e "${RED}Migration up failed.${NC}" >&2
    exit 1
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
