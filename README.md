# Atomic CRM — Isolated dev environment with Claude Code

Single Docker image, two development modes depending on your needs.

## The two modes

```
MODE=demo (default)                 MODE=full
──────────────────                  ─────────────────────────────
FakeRest in the browser             Local Supabase (Postgres)
Starts in ~5 seconds                Starts in ~2-3 min (first time)
No extra prerequisites              Requires host Docker socket
Data resets on reload               Data is persisted
Great for UI development            Required for auth, storage, RLS
```

## Recommended workflow

```
1. Start in demo mode
      ↓
2. Claude develops features via prompts
   (components, fields, views...)
      ↓
3. Visual validation in the browser
      ↓
4. switch-mode full  (in the Claude terminal)
      ↓
5. Claude generates and applies the Supabase migration
   (npx supabase db push)
      ↓
6. Verify on real data
```

---

## Quick start

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed
- Anthropic API key: [console.anthropic.com](https://console.anthropic.com)

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
cp .env.example .env    # then fill in ANTHROPIC_API_KEY (optional if you'll
                        # authenticate via `make claude` instead)

make up        # demo mode
make up-full   # full mode

# First-time login (only if you don't have ANTHROPIC_API_KEY set):
# Run this from another shell — the stack pauses on first boot waiting for
# credentials, and resumes automatically once login completes.
make claude         # OAuth flow on first run — copy URL to browser, paste token back
```

### Persist code changes across restarts
```bash
# Stop and restart — keeps your code changes
docker compose --profile full down
docker compose --profile full up

# Full reset — deletes volumes (loses code changes)
docker compose --profile full down -v
docker compose --profile full up
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
You (in the Claude terminal):
  "Add a 'priority' field (low/medium/high) on contacts
   with a coloured badge in the list"

Claude:
  → Edits src/contacts/ContactList.tsx
  → Edits src/contacts/ContactEdit.tsx
  → Adds the type in src/types.ts
  → Vite automatically reloads the browser
```

Validate visually on `localhost:5173`.

### Phase 2 — Migration to Supabase

```bash
switch-mode full
```

```
You:
  "Now create the Supabase migration for the priority field
   and apply it"

Claude:
  → Creates supabase/migrations/xxx_add_priority_to_contacts.sql
  → Content: ALTER TABLE contacts ADD COLUMN priority text
             CHECK (priority IN ('low', 'medium', 'high'));
  → Runs: npx supabase db push
  → Verifies the CRM works with real data
```

---

## What works in demo vs full mode

| Feature | Demo mode | Full mode |
|---|---|---|
| UI components, forms | ✅ | ✅ |
| New fields, views | ✅ | ✅ |
| Filters, sorting, pagination | ✅ | ✅ |
| Data persistence | ❌ (reload = reset) | ✅ |
| Real authentication | ❌ | ✅ |
| File attachments | ❌ | ✅ |
| Security policies (RLS) | ❌ | ✅ |
| E2E tests | ⚠️ (partial) | ✅ |
