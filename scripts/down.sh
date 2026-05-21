#!/bin/bash
# down.sh — drop-in replacement for `docker compose down [flags]`
#
# Stops Supabase containers gracefully before compose tears down the main
# container. With -v/--volumes, also removes Supabase's own Docker volumes
# (which are not tracked by compose and would otherwise survive the wipe).
#
# Usage:
#   ./scripts/down.sh          # same as: docker compose down
#   ./scripts/down.sh -v       # same as: docker compose down -v  +  purge Supabase volumes

# Run from the project root regardless of where the script is called from.
cd "$(dirname "$0")/.."

CONTAINER=$(docker compose ps -q atomic-crm 2>/dev/null | head -1)

# Supabase project_id: read from the running container, fall back to hardcoded default.
# Containers and volumes are named supabase_*_<project_id>.
SUPABASE_SUFFIX=$(
  { [ -n "$CONTAINER" ] && docker exec "$CONTAINER" sh -c \
      "grep '^project_id' /app/supabase/config.toml" 2>/dev/null; } \
  || echo 'project_id = "atomic-crm-demo"'
)
SUPABASE_SUFFIX=$(echo "$SUPABASE_SUFFIX" | sed 's/project_id = //;s/"//g;s/ //g')

# Stop Supabase containers directly from the host — more reliable than
# running `npx supabase stop` inside the container (which can fail silently
# due to PATH or permission issues).
SUPABASE_CONTAINERS=$(docker ps -q --filter "name=_${SUPABASE_SUFFIX}" 2>/dev/null || true)
if [ -n "$SUPABASE_CONTAINERS" ]; then
  echo "Stopping Supabase containers (${SUPABASE_SUFFIX})..."
  echo "$SUPABASE_CONTAINERS" | xargs docker rm -f 2>/dev/null || true

  if [[ " $* " =~ " -v " ]] || [[ " $* " =~ " --volumes " ]]; then
    echo "Removing Supabase volumes..."
    docker volume ls --quiet \
      | grep "_${SUPABASE_SUFFIX}$" \
      | xargs -r docker volume rm 2>/dev/null || true
  fi
fi

docker compose down "$@"
