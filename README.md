# Atomic CRM Builder

Building a custom CRM from scratch demands both domain knowledge and technical expertise. Atomic CRM Builder lets non-developers design, build, and customize a CRM tailored to their domain using plain-English instructions.

It uses [Atomic CRM](https://github.com/marmelab/atomic-crm) as a starting template and orchestrates a team of AI agents specialized in CRM development, powered by Claude Code. Everything runs in a containerized environment to keep execution secure and isolated. The resulting CRM is built on Supabase, React, and Shadcn.

<img width="1557" height="932" alt="HiringCRM" src="https://github.com/user-attachments/assets/76b57f2c-026f-43de-b312-2a434707a0ad" />

## Quick start

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed
- Anthropic API key: [console.anthropic.com](https://console.anthropic.com) or a Claude Code subscription

### 1. Build (once, ~5 min)
```bash
docker build -t atomic-crm-dev .
```

### 2. Launch the builder

```bash
make up

# First-time login:
# Run this from another shell — the stack pauses on first boot waiting for
# credentials, and resumes automatically once login completes.
make claude         # OAuth flow on first run — copy URL to browser, paste token back
```

### 3. Stop and Restart

```bash
make restart     # Keep your code changes
# or
make wipe up     # Full reset — deletes volumes (loses code changes)
```

## Usage

Once started, open [`http://localhost:8080`](http://localhost:8080) to get the builder UI. From there, you can prompt the assistant, test the modification, and download the modified code. 

Other useful urls: 
*  `http://localhost:5173`: The CRM
* `http://localhost:54323`: The Supabase Dashboard (full mode only)

For a direct, interactive Claude session in the builder, run from your host:

```bash
make claude         # opens `claude --dangerously-skip-permissions` in the container
                    # (also triggers OAuth on first run if ANTHROPIC_API_KEY is unset)
```

Inside that session you can also switch modes without restarting the container:
```bash
switch-mode demo    # → Frontend only
switch-mode full    # → Full-stack
```

## Container Isolation

The entire stack runs in a docker container:
- The CRM (database, server functions, and frontend)
- The builder UI (chat interface, stats, real-time notifications)
- The Claude Code session

This allows to run Claude with `--dangerously-skip-permissions`, and avoids asking technical confirmation to the end user (who is not technical). 

## Custom Harness

The builder runs on a custom harness: a team of agents specialized in CRM development (orchestrator, architect, developer, reviewer, documentarian, etc.), along with dedicated skills, rules, and hooks. You can explore the harness setup in [`.claudeConfig/.claude`](./.claudeConfig/.claude).

## Recommended workflow

```
1. Start the app in demo mode (frontend-only, mocked backend)
      ↓
2. Chat with the assistant to add features
      ↓
3. Validate in the browser on test data
      ↓
4. Claude develops the backend, generates and applies the Database migrations
      ↓
5. Validate in the browser on real data
```

Here is an example:

### Phase 1 — Fast dev in demo mode

```
You:
  "Add a 'priority' field (low/medium/high) on contacts
   with a coloured badge in the list"

Assistant:
  → Spawns a dev team in an isolated git worktree
  → Edits ContactList.tsx, ContactEdit.tsx, types.ts
  → Reviews, validates, merges to main
  → Vite hot-reloads the browser
```

Validate visually on `localhost:5173`.

### Phase 2 — Promote to your real database

When a feature changes the data shape, the assistant writes the SQL into
`supabase/migrations-pending/` (invisible to Supabase CLI) and, once the
dev wave is merged, asks for permission in plain language:

```
Assistant:
  "Some of these changes affect how your data is stored.
   Want me to apply them to your real database now?"

You: "yes"

Assistant:
  → Promotes the file from supabase/migrations-pending/
    to supabase/migrations/ (one commit on main)
  → Starts Supabase if needed and applies the migration

(if you are still in demo mode)
Assistant:
  "Your real database is up to date. Want to switch the app
   over to your real data now?"

You: "yes"

Assistant:
  → Switches the data provider to Supabase — Vite hot-reloads
```

You can also toggle modes yourself at any time: one click on the
mode badge in the chat header, or `switch-mode demo` / `switch-mode full`
from `make claude`.

## What works in demo vs full mode

| Feature | Demo mode | Full mode |
|---|---|---|
| UI components, forms | ✅ | ✅ |
| New fields, views | ✅ | ✅ |
| Filters, sorting, pagination | ✅ | ✅ |
| Response speed | ✅ (instant, in-memory) | ⚠️ (network round-trip, migrations) |
| Data persistence | ❌ (reload = reset) | ✅ |
| Real authentication | ❌ | ✅ |
| File attachments | ❌ | ✅ |
| Security policies (RLS) | ❌ | ✅ |
