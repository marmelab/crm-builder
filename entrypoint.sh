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

# ── First-run bootstrap ───────────────────────────────────────
# crm-app:/app is a named volume. On first boot the volume is empty, so we
# restore the build artifacts staged at /opt/atomic-crm-source by the
# Dockerfile (includes node_modules, .git, etc.).
if [ ! -f /app/package.json ] && [ -d /opt/atomic-crm-source ]; then
  echo -e "${BOLD}${BLUE}First run — populating /app from image (this takes ~30s)…${NC}"
  cp -a /opt/atomic-crm-source/. /app/
  chown -R developer:developer /app
  echo -e "${GREEN}✓  Source ready${NC}"
  echo ""
fi

# ── Auth check — API key or OAuth token ───────────────────────
CLAUDE_DIR="/home/developer/.claude"
# Only the OAuth login is shared/persisted (across rebuilds and parallel
# instances), via a dedicated volume mounted at AUTH_DIR. The harness config
# (agents/skills/hooks/rules/settings.json) stays image-local in CLAUDE_DIR.
#
# We do NOT symlink the login files into CLAUDE_DIR. The Claude CLI rewrites
# credentials with an atomic temp-write + rename, which REPLACES a symlink with
# a regular file — so a refreshed token would land in image-local CLAUDE_DIR and
# be lost on the next container recreate (recurring 401 "please /login"). Instead:
#   1. seed CLAUDE_DIR from the persistent volume on boot (restore last good login),
#   2. a background loop mirrors any credential change back to the volume.
AUTH_DIR="/home/developer/.claude-auth"
AUTH_FILES=".credentials.json credentials.json .claude.json"

mkdir -p "${CLAUDE_DIR}" "${AUTH_DIR}"

# Seed: the volume is the source of truth across recreates — restore it over any
# stale container-local copy so the CLI starts from the last good token.
for f in ${AUTH_FILES}; do
  [ -f "${AUTH_DIR}/${f}" ] && cp -a "${AUTH_DIR}/${f}" "${CLAUDE_DIR}/${f}" 2>/dev/null || true
done
chown -R developer:developer "${CLAUDE_DIR}" "${AUTH_DIR}" 2>/dev/null || true

# Ensure the interactive orchestrator PTY skips claude's first-run onboarding.
# claude >=2.1 gates the interactive TUI on hasCompletedOnboarding; `claude login`
# sets oauthAccount but NOT this flag, so a fresh login (or a wiped auth volume)
# leaves the orchestrator stuck on the login-method/theme picker — no transcript,
# no Stop sentinel, every session hangs to the 120 s silence timeout. Idempotent;
# the mirror loop below propagates the change back to AUTH_DIR.
#
# Two more interactive gates would ALSO trap the orchestrator PTY on a fresh
# environment (a brand-new auth volume or a re-login), and the PTY send path
# can't navigate their menus — it types the user's message into the dialog
# instead of choosing an option, so the turn hangs with no transcript:
#   1. "Do you trust the files in this folder?"  → .claude.json projects["/app"].hasTrustDialogAccepted
#   2. "Bypass Permissions mode … Yes, I accept" → settings.json skipDangerousModePermissionPrompt
# (1) is per-project keyed on CWD (/app), stored in .claude.json. (2) is global
CLAUDE_DIR="${CLAUDE_DIR}" node -e '
  const fs = require("fs"); const p = process.env.CLAUDE_DIR + "/.claude.json";
  let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  let changed = false;
  if (c.hasCompletedOnboarding !== true) { c.hasCompletedOnboarding = true; changed = true; }
  if (!c.theme) { c.theme = "dark"; changed = true; }
  c.projects = c.projects || {};
  c.projects["/app"] = c.projects["/app"] || {};
  if (c.projects["/app"].hasTrustDialogAccepted !== true) { c.projects["/app"].hasTrustDialogAccepted = true; changed = true; }
  if (changed) fs.writeFileSync(p, JSON.stringify(c));
' 2>/dev/null || true
CLAUDE_DIR="${CLAUDE_DIR}" node -e '
  const fs = require("fs"); const p = process.env.CLAUDE_DIR + "/settings.json";
  let s = {}; try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  if (s.skipDangerousModePermissionPrompt !== true) {
    s.skipDangerousModePermissionPrompt = true;
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  }
' 2>/dev/null || true
chown developer:developer "${CLAUDE_DIR}/.claude.json" "${CLAUDE_DIR}/settings.json" 2>/dev/null || true

# Persist: mirror login files CLAUDE_DIR → AUTH_DIR whenever they change (token
# refresh or fresh `make claude` login). Survives `exec` below as an orphan under
# pid 1. 10 s cadence is well within token lifetime and recreate cadence.
( while true; do
    for f in ${AUTH_FILES}; do
      if [ -f "${CLAUDE_DIR}/${f}" ] && ! cmp -s "${CLAUDE_DIR}/${f}" "${AUTH_DIR}/${f}" 2>/dev/null; then
        cp -a "${CLAUDE_DIR}/${f}" "${AUTH_DIR}/${f}" 2>/dev/null || true
      fi
    done
    sleep 10
  done ) &

if [ -n "${ANTHROPIC_API_KEY}" ]; then
  echo -e "${GREEN}✓  Auth: API key${NC}"
elif [ -f "${CLAUDE_DIR}/.credentials.json" ] || [ -f "${CLAUDE_DIR}/credentials.json" ]; then
  echo -e "${GREEN}✓  Auth: OAuth token${NC}"
else
  echo -e "${YELLOW}⚠️   No authentication found${NC}"
  echo ""
  echo -e "${BOLD}  → From your host machine, run:${NC} ${YELLOW}make claude${NC}"
  echo ""
  echo "Waiting for credentials..."
  export HOME=/home/developer
  # Re-chown each iteration: claude creates subdirs (projects/, statsig/, …)
  # during OAuth that are otherwise blocked if any new root-owned path appears.
  while [ ! -f "${CLAUDE_DIR}/.credentials.json" ] && [ ! -f "${CLAUDE_DIR}/credentials.json" ]; do
    sleep 2
    chown -R developer:developer "${CLAUDE_DIR}" "${AUTH_DIR}" 2>/dev/null || true
  done
  echo -e "${GREEN}✓  Credentials detected — continuing startup${NC}"
fi

# No resync of agents/skills/hooks/rules/settings.json: CLAUDE_DIR is now
# image-local (the volume only holds the login at AUTH_DIR), so the image's
# config is authoritative by construction — nothing stale to overwrite.

# Local additions (runtime-generated by documentator). Agents and skills are
# exposed to Claude Code via symlinks
# into the canonical paths (probe-tested 2026-05-05 — Claude Code follows
# symlinks for agent dispatch). Hooks and rules under local/ are wired through
# settings.local.json with absolute paths, no symlink needed.
LOCAL="/home/developer/.claude/local"
mkdir -p "$LOCAL/agents" "$LOCAL/skills" "$LOCAL/hooks" "$LOCAL/rules"
for kind in agents skills; do
  for src in "$LOCAL/$kind"/*.md; do
    [ -e "$src" ] || continue
    target="/home/developer/.claude/$kind/$(basename "$src")"
    [ -e "$target" ] && continue
    ln -s "$src" "$target"
  done
done

# settings.local.json — Claude Code auto-loads this when present. Survives the
# resync (we never overwrite it). The documentator wires its new hooks here.
if [ ! -f "/home/developer/.claude/settings.local.json" ]; then
  printf '{\n  "hooks": {}\n}\n' > /home/developer/.claude/settings.local.json
fi

# Fix ownership — credentials written during bootstrap run as root
chown -R developer:developer /home/developer/.claude 2>/dev/null || true

# Supabase remote-deploy config dir (mounted as a named volume — see
# docker-compose.yml). On fresh volumes the mount-point is root-owned; chown
# so the chat-service (running as developer) can write config.json. Mode 700
# because only the developer user needs access — never world-readable.
mkdir -p /var/lib/atomic-crm/supabase-deploy 2>/dev/null || true
chown developer:developer /var/lib/atomic-crm/supabase-deploy 2>/dev/null || true
chmod 700 /var/lib/atomic-crm/supabase-deploy 2>/dev/null || true

# Chat-service logs dir (bind-mounted in dev, needs developer write access)
mkdir -p /chat-service/logs 2>/dev/null || true
chmod 777 /chat-service/logs 2>/dev/null || true
# hooks.log is touched/appended by dozens of subagent processes; ensure it
# exists and is writable by `developer` so a stale root-owned file from a
# previous troubleshooting session doesn't silently break logging.
touch /chat-service/logs/hooks.log 2>/dev/null || true
chown developer:developer /chat-service/logs/hooks.log 2>/dev/null || true
chmod 664 /chat-service/logs/hooks.log 2>/dev/null || true

# Runtime-generated docs (reflections, learnings) — live at /app/docs inside
# the crm-app volume. Ensure they exist and are writable by developer so
# Mode 2 can persist reflections.
# Note: ticket files (TASK-XXX.json) live in /chat-service/logs/<sessionId>/ now,
# alongside log.jsonl and meta.json — chown'd via the chat-service logs block above.
mkdir -p /app/docs/learnings /app/adr 2>/dev/null || true

if [ ! -f /app/docs/learnings/patterns.md ]; then
  cat > /app/docs/learnings/patterns.md <<'PATTERNS_EOF'
# Patterns ledger

Index of patterns captured by the `documentator` agent. The documentator is
triggered explicitly by the maintainer ("retiens X", "documente Y") — it is
not on a schedule. Each entry points to a runtime artifact under
`/home/developer/.claude/local/{rules,skills,hooks,agents}/`.

---

<!-- Patterns appear below this line. Documentator preserves the file header verbatim. -->
PATTERNS_EOF
fi

chown -R developer:developer /app/docs 2>/dev/null || true

# Worktrees root — lives inside /app so cp -al hard-links against
# /app/node_modules stay on the same device. Excluded from git via .gitignore.
mkdir -p /app/worktrees 2>/dev/null || true
chown -R developer:developer /app/worktrees 2>/dev/null || true

# Make sure /app/worktrees is gitignored (idempotent — only adds the line if
# missing). Without this, `git status` in /app would list every worktree as
# untracked and merger would try to add them.
if [ -f /app/.gitignore ] && ! grep -qxF 'worktrees/' /app/.gitignore; then
  echo 'worktrees/' >> /app/.gitignore
fi

# ── Sync node_modules with package-lock.json ──────────────────
# Volume crm-app:/app persists node_modules across restarts. If an agent
# modifies package.json/package-lock.json (e.g. adds a dependency) and
# commits, the volume keeps the old node_modules. Hash-check at boot:
# if package-lock.json changed since last npm ci, re-install.
LOCK_HASH=$(sha256sum /app/package-lock.json 2>/dev/null | cut -d' ' -f1)
PREV_HASH=$(cat /app/.npm-ci-hash 2>/dev/null || echo "")
if [ -n "$LOCK_HASH" ] && [ "$LOCK_HASH" != "$PREV_HASH" ]; then
  echo -e "${YELLOW}package-lock.json changed → wiping and reinstalling node_modules${NC}"
  # rm -rf is mandatory: npm ci over an existing node_modules occasionally
  # fails with ENOTEMPTY when a transitive dep tree shape changes (e.g.
  # 'rmdir es-abstract' fails because some sub-dir is non-empty).
  rm -rf /app/node_modules
  (cd /app && su developer -c 'npm ci') || echo -e "${RED}npm ci failed — vite/tsc may be broken${NC}"
  echo "$LOCK_HASH" > /app/.npm-ci-hash
  chown developer:developer /app/.npm-ci-hash
fi

# Write /app/CLAUDE.md orientation header. The upstream atomic-crm CLAUDE.md
# is essentially empty (just `@AGENTS.md`) — we prepend a short pointer to
# project-context.json so every Claude Code spawn auto-loads the right
# guidance. Idempotent: regenerated on every boot from this template.
APP_AGENTS_REF=""
if [ -f /app/AGENTS.md ]; then
  APP_AGENTS_REF=$'\n@AGENTS.md\n'
fi
cat > /app/CLAUDE.md <<CLAUDEMD
# Project context

This CRM is configured for the user's specific business. The single source
of truth for entities, fields, pipeline stages, user roles, and integrations
is:

  docs/project-context.json

Read it before adding/modifying any entity or field. The structured spec is
maintained by the \`project-manager\` agent (interview flow). Do not edit it
manually — request a setup via the chat UI's "Define your business" flow.

If the file is missing or has \`validated: false\`, the project has not yet
been cadred — propose the user to run "Define your business" from the chat
UI before implementing entity/field changes.

Architectural decisions live in \`adr/\`. Source files reference them via
\`// See adr/ADR-NNN-...\` comments — \`grep -r 'adr/ADR-' src/\` to locate.

\`MEMORY.md\` holds long-lived domain knowledge (business rules, custom-field
semantics, workflow constraints). Read explicitly by domain-aware agents
(planner, developer, simple-developer, documentator), not auto-imported.

${APP_AGENTS_REF}
CLAUDEMD
chown developer:developer /app/CLAUDE.md 2>/dev/null || true

# Seed /app/MEMORY.md once on first boot. Maintained by the documentator
# at session end — idempotent, only seeded if absent.
if [ ! -f /app/MEMORY.md ]; then
  cat > /app/MEMORY.md <<'MEMORYMD'
# Project memory

Long-lived domain knowledge. Maintained by the documentator at session end.
One bullet, one sentence per fact.

## Business Knowledge

<!-- Domain vocabulary, business rules, custom fields, workflows. -->
MEMORYMD
  chown developer:developer /app/MEMORY.md 2>/dev/null || true
fi

# Commit the orientation file on main if it differs from HEAD. Without this
# commit, the merger's `git reset --hard HEAD` (in /app between merges) would
# silently restore the upstream stub. Idempotent: no-op if content matches.
#
# Everything runs as `developer` because `/app` is chown'd to developer above —
# git refuses with "dubious ownership" when run as root.
if [ -d /app/.git ]; then
  su developer -c '
    set -e
    cd /app
    BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)
    if [ -z "$BRANCH" ]; then
      exit 0  # detached HEAD or mid-rebase — skip
    fi
    if git diff --quiet HEAD -- CLAUDE.md 2>/dev/null; then
      exit 0  # already up to date
    fi
    git add CLAUDE.md
    git -c user.name="Atomic CRM Builder" \
        -c user.email="builder@atomic-crm.local" \
        commit -m "chore: refresh CLAUDE.md orientation header" --quiet
  ' || echo -e "${YELLOW}Could not commit CLAUDE.md (non-fatal)${NC}"

  # Commit MEMORY.md if seeded or changed. Session-end documentator
  # updates produce their own commits.
  su developer -c '
    set -e
    cd /app
    BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)
    if [ -z "$BRANCH" ]; then
      exit 0
    fi
    # Distinguish initial seed (untracked) from later changes so the commit
    # message is accurate. Later changes are usually the user editing on the
    # host between restarts — not a re-seed.
    if git ls-files --error-unmatch MEMORY.md >/dev/null 2>&1; then
      if git diff --quiet HEAD -- MEMORY.md 2>/dev/null; then
        exit 0  # tracked and clean
      fi
      MSG="chore: update MEMORY.md"
    else
      MSG="chore: seed MEMORY.md"
    fi
    git add MEMORY.md
    git -c user.name="Atomic CRM Builder" \
        -c user.email="builder@atomic-crm.local" \
        commit -m "$MSG" --quiet
  ' || echo -e "${YELLOW}Could not commit MEMORY.md (non-fatal)${NC}"
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

# ── App.tsx variant ───────────────────────────────────────────
/entrypoint-helpers/apply-app-variant.sh
if [ "$MODE" = "demo" ]; then
  echo -e "${GREEN}✓  Data provider: FakeRest${NC}"
else
  echo -e "${GREEN}✓  Data provider: Supabase${NC}"
fi

# ── Docker socket group (enables runtime mode switch to Supabase) ─
if [ -S /var/run/docker.sock ]; then
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
  if ! getent group "$DOCKER_GID" > /dev/null 2>&1; then
    groupadd --gid "$DOCKER_GID" docker-host
  fi
  usermod -aG "$DOCKER_GID" developer
  echo -e "${GREEN}✓  Docker socket available (GID=${DOCKER_GID})${NC}"
fi

# The Supabase CLI's scratch dirs (supabase/.temp, supabase/.branches) must be
# writable by `developer`: that's the user supervisord runs the chat-service —
# and therefore the remote deploy (`supabase link/db push/...`) — as. Earlier
# image versions ran `supabase start` as root, leaving these root-owned, which
# made `supabase link` fail with "permission denied: supabase/.temp/...". Clean
# up any such legacy ownership; the starts below now run as developer too.
chown -R developer:developer /app/supabase 2>/dev/null || true

# ── Start Supabase when MODE=full ─────────────────────────────
if [ "$MODE" = "full" ]; then
  if [ ! -S /var/run/docker.sock ]; then
    echo ""
    echo -e "${RED}❌  Docker socket not found!${NC}"
    echo "    Full mode requires the Docker daemon."
    echo "    Add: -v /var/run/docker.sock:/var/run/docker.sock"
    echo ""
    echo "    Or use demo mode: MODE=demo docker compose up"
    exit 1
  fi

  echo ""
  echo -e "${BOLD}Starting Supabase...${NC}"
  echo -e "${YELLOW}(First run: ~2 min to pull images)${NC}"
  su developer -c 'cd /app && supabase start' 2>&1 | grep -E "✓|✗|Error|Started|API URL" || true

  echo -e "${BOLD}Waiting for Supabase API (localhost:54321)...${NC}"
  RETRIES=60
  until curl -s --max-time 2 -o /dev/null http://localhost:54321; do
    RETRIES=$((RETRIES - 1))
    if [ $RETRIES -le 0 ]; then
      echo -e "${RED}❌  Supabase did not respond after 60s${NC}"
      exit 1
    fi
    sleep 1
  done
  echo -e "${GREEN}✓  Supabase ready (localhost:54321)${NC}"
fi

# Commit the App.tsx variant so `git reset --hard HEAD` in the merger restores
# the correct data-provider wiring instead of the upstream stub. Same pattern
# as the CLAUDE.md commit above — idempotent, no-op when content already matches.
if [ -d /app/.git ]; then
  su developer -c '
    set -e
    cd /app
    BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)
    if [ -z "$BRANCH" ]; then
      exit 0  # detached HEAD or mid-rebase — skip
    fi
    if git diff --quiet HEAD -- src/App.tsx 2>/dev/null; then
      exit 0  # already up to date
    fi
    git add src/App.tsx
    git -c user.name="Atomic CRM Builder" \
        -c user.email="builder@atomic-crm.local" \
        commit -m "chore: pin App.tsx to data-provider variant" --quiet
  ' || echo -e "${YELLOW}Could not commit App.tsx (non-fatal)${NC}"
fi

# ── URL summary ───────────────────────────────────────────────
echo ""
echo -e "  ${BLUE}🌐  CRM              →  http://localhost:${PORT_CRM:-5173}${NC}"
if [ "$MODE" = "full" ]; then
echo -e "  ${BLUE}🗄️   Supabase         →  http://localhost:54323${NC}"
fi
echo -e "  ${BLUE}💬  Chat assistant   →  http://localhost:${PORT_CHAT:-8080}${NC}"
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}  For an interactive Claude session, from your host:   ${NC}"
echo -e "${YELLOW}  make claude                                          ${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Pre-warm Supabase once Vite is ready (no resource contention at cold start) ─
if [ -S /var/run/docker.sock ]; then
  (
    until curl -s --max-time 2 -o /dev/null http://localhost:5173; do sleep 3; done
    su developer -c 'cd /app && supabase start' > /var/log/supabase-prewarm.log 2>&1
  ) &
fi

# ── Graceful shutdown: stop Supabase before supervisord exits ─────────────────
# exec would replace this bash process, losing the trap. Run supervisord in the
# background instead and wait — SIGTERM from `compose down` is caught here.
_stop() {
  if [ "$MODE" = "full" ]; then
    echo -e "${YELLOW}Stopping Supabase before shutdown...${NC}"
    su developer -c 'cd /app && supabase stop --no-backup' 2>/dev/null || true
  fi
  kill "$SUPERVISOR_PID" 2>/dev/null || true
}
trap _stop TERM INT

/usr/bin/supervisord --user=root -n -c /etc/supervisor/conf.d/supervisord.conf &
SUPERVISOR_PID=$!
wait $SUPERVISOR_PID
