#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${1:-/workspaces/crm-builder}"
CLAUDE_DIR="$HOME/.claude"
SEED_DIR="$WORKSPACE/.devcontainer/claude-seed"

echo "[post-create] ensuring volume mount points are owned by current user"
# Docker named volumes are created with root:root ownership; chown them once
# so the unprivileged user can write. Idempotent.
for d in "$HOME/.claude" "$HOME/.config/gh"; do
  if [ -d "$d" ] && [ "$(stat -c %u "$d")" != "$(id -u)" ]; then
    sudo chown -R "$(id -u):$(id -g)" "$d"
    echo "  - chown $d -> $(whoami)"
  fi
done

echo "[post-create] git safe.directory (skip if gitconfig is read-only)"
# ~/.gitconfig is bind-mounted read-only from the host; safe.directory is only needed
# when host UID != container UID, which isn't the case here (node=1000, host=1000).
# Try to add it but don't fail the script if it can't be written.
git config --global --add safe.directory "$WORKSPACE" 2>/dev/null || \
  echo "  (skipped — gitconfig is read-only, but UIDs match so safe.directory isn't required)"

echo "[post-create] installing Claude Code globally"
npm install -g @anthropic-ai/claude-code

echo "[post-create] chat-service deps"
(cd "$WORKSPACE/chat-service" && npm install)

echo "[post-create] seeding ~/.claude (idempotent)"
mkdir -p "$CLAUDE_DIR" "$CLAUDE_DIR/projects/-workspaces-crm-builder/memory"

# Settings: only seed if absent
if [ ! -f "$CLAUDE_DIR/settings.json" ] && [ -f "$SEED_DIR/settings.json" ]; then
  cp "$SEED_DIR/settings.json" "$CLAUDE_DIR/settings.json"
  echo "  - settings.json seeded"
fi

# Memory: copy each file only if absent (preserve any new memory written in container)
MEM_TARGET="$CLAUDE_DIR/projects/-workspaces-crm-builder/memory"
if [ -d "$SEED_DIR/memory" ]; then
  cp -rn "$SEED_DIR/memory/." "$MEM_TARGET/" 2>/dev/null || true
  echo "  - memory seeded ($(ls "$MEM_TARGET" | wc -l) files in $MEM_TARGET)"
fi

echo "[post-create] done"
echo
echo "Next steps inside the container:"
echo "  1) claude login         (OAuth, persisted in volume)"
echo "  2) gh auth login        (HTTPS push, persisted in volume)"
echo "  3) start using claude — plugins auto-install on first launch"
