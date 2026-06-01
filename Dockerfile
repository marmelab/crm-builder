# ─────────────────────────────────────────────────────────────
#  Atomic CRM — Single image, two startup modes
#
#  MODE=demo  → FakeRest (browser-side), no external dependencies
#  MODE=full  → Local Supabase, requires host Docker socket
# ─────────────────────────────────────────────────────────────
FROM node:24-trixie-slim

# ── Version pins — update when upgrading tools ────────────────
ARG SUPABASE_CLI_VERSION=v2.98.2
ARG CLAUDE_CODE_VERSION=2.1.98
ARG WRANGLER_VERSION=4.42.0

ENV DEBIAN_FRONTEND=noninteractive \
    APP_DIR=/app \
    CI=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ── System dependencies ───────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git make zip unzip jq ca-certificates gnupg lsb-release \
    supervisor procps tmux \
    chromium chromium-driver \
    libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libasound2 libx11-6 libxext6 libxfixes3 \
    && rm -rf /var/lib/apt/lists/*

# ── Docker CLI (used only in MODE=full) ──────────────────────
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/debian $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# ── Supabase CLI (used only in MODE=full) ────────────────────
RUN curl -fsSL https://github.com/supabase/cli/releases/download/${SUPABASE_CLI_VERSION}/supabase_linux_amd64.tar.gz \
    | tar -xz -C /usr/local/bin supabase

# ── Claude Code ───────────────────────────────────────────────
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# ── TypeScript language server (required by typescript-lsp plugin for agents)
RUN npm install -g typescript-language-server typescript

# ── Wrangler (Cloudflare Workers deploy — used by the frontend deploy phase) ──
RUN npm install -g wrangler@${WRANGLER_VERSION}

# ── Download project (zip from main branch) ──────────────────
# GitHub automatically generates a zip for any branch at:
# /archive/refs/heads/BRANCH_NAME.zip
# The zip extracts into a folder named atomic-crm-main/
RUN wget -q https://github.com/marmelab/atomic-crm/archive/refs/heads/main.zip \
    -O /tmp/atomic-crm.zip \
    && unzip -q /tmp/atomic-crm.zip -d /tmp \
    && mv /tmp/atomic-crm-main ${APP_DIR} \
    && rm /tmp/atomic-crm.zip

WORKDIR ${APP_DIR}
RUN npm install
RUN npm install playwright@^1.60 @playwright/test@^1.60
# Pre-bundle Vite dependencies so the first dev-server start is instant
RUN npx vite optimize 2>/dev/null || true

# ── Playwright Chromium (for vitest browser mode) ─────────────
# PLAYWRIGHT_BROWSERS_PATH=/ms-playwright → accessible to all users
RUN npx playwright install chromium-headless-shell \
    && chmod -R a+rwx /ms-playwright

# ── Git initialisation ────────────────────────────────────────
# node_modules is tracked so `git worktree add` includes them automatically —
# each worktree gets isolated deps without an extra install step, enabling
# parallel agent runs without vitest cache conflicts.
RUN git config --global user.email "claude@atomic-crm.dev" \
    && git config --global user.name "Claude Code" \
    && git init \
    && git add . \
    && git commit -m "Initial commit (from marmelab/atomic-crm main)"

# ── Non-root user for Claude Code ────────────────────────────
# --dangerously-skip-permissions is rejected when running as root.
# Note: .claude is copied in the final layer so agent config changes
# don't invalidate this expensive step.
RUN useradd -m -s /bin/bash developer \
    && cp /root/.gitconfig /home/developer/.gitconfig \
    && chown -R developer:developer /home/developer \
    && chown -R developer:developer /app \
    && mkdir -p /app/worktrees && chown developer:developer /app/worktrees \
    && mkdir -p /app/node_modules/.vite && chown -R developer:developer /app/node_modules/.vite \
    && ln -sf .claude/.claude.json /home/developer/.claude.json \
    # Pre-write the npm-ci hash so the first boot skips npm ci (node_modules from
    # the image is already consistent with package-lock.json). Entrypoint only
    # re-runs npm ci when an agent later modifies package-lock.json.
    && sha256sum /app/package-lock.json | cut -d' ' -f1 > /app/.npm-ci-hash \
    && chown developer:developer /app/.npm-ci-hash

# ── Save original App.tsx (Supabase mode) ─────────────────────
RUN cp src/App.tsx src/App.supabase.tsx

# ── App.tsx variants bundled in the image ─────────────────────
COPY app-variants/App.fakerest.tsx /app-variants/App.fakerest.tsx
COPY app-variants/App.supabase.tsx /app-variants/App.supabase.tsx

# ── Utility scripts ───────────────────────────────────────────
COPY scripts/switch-mode.sh /usr/local/bin/switch-mode
COPY scripts/apply-migrations.sh /usr/local/bin/apply-migrations
COPY scripts/pending-deploys.mjs /usr/local/bin/pending-deploys
RUN chmod +x /usr/local/bin/switch-mode /usr/local/bin/apply-migrations /usr/local/bin/pending-deploys

# ── Supervisor config ─────────────────────────────────────────
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# ── Chat service ──────────────────────────────────────────────
COPY chat-service/ /chat-service/
RUN cd /chat-service && npm ci \
    && chown -R developer:developer /chat-service

# ── Entrypoint ────────────────────────────────────────────────
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── Agent config — most volatile, kept last ───────────────────
# Changing agents/skills/hooks only invalidates these two steps.
COPY claudeConfig/.claude/ /root/.claude/
RUN cp -r /root/.claude /home/developer/.claude \
    && chown -R developer:developer /home/developer/.claude

# 5173  → CRM (Vite)
# 54321 → Supabase API  (MODE=full only)
# 54323 → Supabase Dashboard (MODE=full only)
# 8080  → Chat assistant (WebSocket)
EXPOSE 5173 54321 54323 8080

ENTRYPOINT ["/entrypoint.sh"]
