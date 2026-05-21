# Atomic CRM Builder

Customizing a CRM can be tedious. We built Atomic CRM Builder to provide a containerized environment that helps you create your custom CRM based on [Atomic CRM](https://github.com/marmelab/atomic-crm).

The builder provides two modes:

```
MODE=demo (default)                 MODE=full
──────────────────                  ─────────────────────────────
FakeRest in the browser             Local Supabase (Postgres)
Starts in ~5 seconds                Starts in ~2-3 min (first time)
No extra prerequisites              Requires host Docker socket
Data resets on reload               Data is persisted
```

Note: The user can toggle mode with a single click from the User Interface.


## Quick start

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed
- Anthropic API key: [console.anthropic.com](https://console.anthropic.com) or a Claude Code subscription

### 1. Build (once, ~5 min)
```bash
docker build -t atomic-crm-dev .
```

### 2a. Demo mode (recommended to start)
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-YOUR_KEY \
  -p 5173:5173 -p 8080:8080 \
  atomic-crm-dev
```

### 2b. Full mode (Supabase)
```bash
docker run -it --rm \
  -e ANTHROPIC_API_KEY=sk-ant-YOUR_KEY \
  -e MODE=full \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  atomic-crm-dev
```

### With docker compose (easier)
```bash
make up        # demo mode
make up-full   # full mode

# First-time login:
# Run this from another shell — the stack pauses on first boot waiting for
# credentials, and resumes automatically once login completes.
make claude         # OAuth flow on first run — copy URL to browser, paste token back
```

### Persist code changes across restarts
```bash
# Stop and restart — keeps your code changes
make restart # or make restart-full

# Full reset — deletes volumes (loses code changes)
make wipe up
```

---

## Recommended workflow

```
1. Start in demo mode
      ↓
2. Claude develops features via prompts
   (components, fields, views...)
      ↓
3. Visual validation in the browser
      ↓
4. Claude generates and applies the Database migrations
      ↓
5. Verify on real data
```

---

## Usage

Once started, open these URLs:

| URL | Content |
|---|---|
| `http://localhost:5173` | The CRM |
| `http://localhost:8080` | Chat assistant (the main UI for asking Claude to ship changes) |
| `http://localhost:54323` | Supabase Dashboard (full mode only) |

For a direct, interactive Claude session, run from your host:
```bash
make claude         # opens `claude --dangerously-skip-permissions` in the container
                    # (also triggers OAuth on first run if ANTHROPIC_API_KEY is unset)
```

Inside that session you can also switch modes without restarting the container:
```bash
switch-mode demo    # → FakeRest
switch-mode full    # → Supabase
```

---

## Feature development cycle

### Phase 1 — Fast dev in demo mode

```
You (in the chat at localhost:8080):
  "Add a 'priority' field (low/medium/high) on contacts
   with a coloured badge in the list"

Claude:
  → Spawns a dev team in an isolated git worktree
  → Edits ContactList.tsx, ContactEdit.tsx, types.ts
  → Reviews, validates, merges to main
  → Vite hot-reloads the browser
```

Validate visually on `localhost:5173`.

### Phase 2 — Promote to your real database

When a feature changes the data shape, Claude writes the SQL into
`supabase/migrations-pending/` (invisible to Supabase CLI) and, once the
dev wave is merged, asks for permission in plain language:

```
Claude:
  "Some of these changes affect how your data is stored.
   Want me to apply them to your real database now?"

You: "yes"

Claude:
  → Promotes the file from supabase/migrations-pending/
    to supabase/migrations/ (one commit on main)
  → Starts Supabase if needed and applies the migration

(if you are still in demo mode)
Claude:
  "Your real database is up to date. Want to switch the app
   over to your real data now?"

You: "yes"

Claude:
  → Switches the data provider to Supabase — Vite hot-reloads
```

You can also toggle modes yourself at any time: one click on the
mode badge in the chat header, or `switch-mode demo` / `switch-mode full`
from `make claude`.

---

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
