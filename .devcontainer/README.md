# Dev Container

Isolated dev environment for working on the chat-service / agents / docker config without permission prompts on the host. Claude Code state (sessions, memory, plugins, OAuth) lives in a Docker volume so it survives container rebuilds.

## What's inside

- Node.js 22 + npm (Microsoft `typescript-node` base)
- Docker CLI with access to the host's Docker daemon (`docker-outside-of-docker` feature)
- GitHub CLI (`gh`)
- `@anthropic-ai/claude-code` (installed globally via `postCreateCommand`)
- VS Code extensions: Claude Code, Docker, ESLint

## Persistent state (Docker volumes)

| Mount | Purpose | Survives rebuild? |
|---|---|---|
| `claude-crmbuilder-tooling` → `/home/node/.claude` | Claude sessions, memory, plugins, OAuth credentials | ✅ |
| `crmbuilder-gh-config` → `/home/node/.config/gh` | `gh auth login` token for HTTPS push | ✅ |
| `~/.gitconfig` (read-only bind) → `/home/node/.gitconfig` | Git identity (user.name / user.email) | ✅ (host file) |

These volumes are **isolated from the host's `~/.claude`** — login/permissions in the container don't leak credentials to the host and vice versa.

## First-time setup

1. Set `ANTHROPIC_API_KEY` in your host shell (forwarded via `${localEnv:...}`) — *or* skip and use `claude login`.
2. In VS Code: **Dev Containers: Reopen in Container** (cmd-shift-P).
3. `postCreateCommand` will:
   - register `safe.directory` for git
   - install Claude Code globally
   - `npm install` in `chat-service/`
   - seed `~/.claude` from `.devcontainer/claude-seed/` **only if empty** (settings, project memory)
4. Inside the container, run once:
   ```bash
   claude login        # OAuth, persisted in the volume
   gh auth login       # HTTPS push, persisted in its own volume
   ```
5. Plugins declared in `enabledPlugins` (see `claude-seed/settings.json`) auto-install on first `claude` launch.

## The seed (`.devcontainer/claude-seed/`)

Only used to populate the empty volume on first boot. After that, the live volume wins and the seed is ignored. Both files are per-user and gitignored — populate them locally before the first container build:

| Path | Why |
|---|---|
| `claude-seed/settings.json` | Per-user (plugin selection, theme, hooks) |
| `claude-seed/memory/` | Per-user (feedback, project notes) |

To refresh the seed from your host (e.g. after installing a new plugin you want to carry into future containers):

```bash
mkdir -p .devcontainer/claude-seed/memory
cp ~/.claude/settings.json .devcontainer/claude-seed/settings.json
# Claude encodes the host repo path as the project memory dir name:
#   /home/alice/code/crm-builder → -home-alice-code-crm-builder
cp ~/.claude/projects/"-$(pwd | tr / -)"/memory/*.md .devcontainer/claude-seed/memory/
```

## Reset

To wipe the container's Claude state (force re-seed from the seed folder):

```bash
docker volume rm claude-crmbuilder-tooling crmbuilder-gh-config
# then rebuild the container
```

## Why a dev container?

Running Claude Code inside a sandboxed dev container avoids host permission prompts on `Bash` calls (the host file system isn't reachable beyond the workspace mount). The persistent volume ensures you don't lose plugin installs, sessions, or memory between container restarts.
