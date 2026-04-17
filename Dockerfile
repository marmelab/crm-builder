# ─────────────────────────────────────────────────────────────
#  Atomic CRM — Single image, two startup modes
#
#  MODE=demo  → FakeRest (browser-side), no external dependencies
#  MODE=full  → Local Supabase, requires host Docker socket
# ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    APP_DIR=/app \
    CI=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ── System dependencies ───────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git make unzip ca-certificates gnupg lsb-release \
    supervisor procps tmux \
    chromium chromium-driver \
    libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libasound2 libx11-6 libxext6 libxfixes3 \
    && rm -rf /var/lib/apt/lists/*

# ── ttyd (not in Debian repos, GitHub binary) ────────────────
RUN curl -L https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 \
    -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

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
RUN curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
    | tar -xz -C /usr/local/bin supabase

# ── Claude Code ───────────────────────────────────────────────
RUN npm install -g @anthropic-ai/claude-code

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

# ── Playwright Chromium (for vitest browser mode) ─────────────
# PLAYWRIGHT_BROWSERS_PATH=/ms-playwright → accessible to all users
RUN npx playwright install chromium-headless-shell \
    && chmod -R a+rx /ms-playwright

# ── Git initialisation ────────────────────────────────────────
# Required for agents to create worktrees:
#   git worktree add /worktrees/my-feature feature/my-feature
# Each worktree = isolated directory for one agent + its Vite dev server
RUN git config --global user.email "claude@atomic-crm.dev" \
    && git config --global user.name "Claude Code" \
    && git init \
    && git add . \
    && git commit -m "Initial commit (from marmelab/atomic-crm main)"

# ── Integrate crm-builder (from local directory) ──────────────
COPY claudeConfig/.claude/ /root/.claude/

# ── Non-root user for Claude Code ────────────────────────────
# --dangerously-skip-permissions is rejected when running as root
RUN useradd -m -s /bin/bash developer \
    && cp -r /root/.claude /home/developer/.claude \
    && cp /root/.gitconfig /home/developer/.gitconfig \
    && chown -R developer:developer /home/developer \
    && chown -R developer:developer /app \
    && mkdir -p /worktrees && chown developer:developer /worktrees \
    && mkdir -p /app/node_modules/.vite && chown -R developer:developer /app/node_modules/.vite

# ── Save original App.tsx (Supabase mode) ─────────────────────
RUN cp src/App.tsx src/App.supabase.tsx

# ── App.tsx variants bundled in the image ─────────────────────
COPY app-variants/App.fakerest.tsx /app-variants/App.fakerest.tsx
COPY app-variants/App.supabase.tsx /app-variants/App.supabase.tsx

# ── Utility scripts ───────────────────────────────────────────
COPY scripts/switch-mode.sh /usr/local/bin/switch-mode
COPY scripts/ttyd-session.sh /usr/local/bin/ttyd-session.sh
RUN chmod +x /usr/local/bin/switch-mode /usr/local/bin/ttyd-session.sh

# ── Supervisor configs ────────────────────────────────────────
COPY supervisord.demo.conf /etc/supervisor/conf.d/demo.conf
COPY supervisord.full.conf /etc/supervisor/conf.d/full.conf

# ── Chat service ──────────────────────────────────────────────
COPY chat-service/ /chat-service/
RUN cd /chat-service && npm ci \
    && chown -R developer:developer /chat-service

# ── Entrypoint ────────────────────────────────────────────────
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 5173  → CRM (Vite)
# 54321 → Supabase API  (MODE=full only)
# 54323 → Supabase Dashboard (MODE=full only)
# 7681  → Claude Code web terminal
EXPOSE 5173 54321 54323 7681 8080

ENTRYPOINT ["/entrypoint.sh"]
