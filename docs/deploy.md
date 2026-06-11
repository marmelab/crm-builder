# deploy-routes.js — reference

Handles the sidebar "Deploy" modal. Independent of the chat WebSocket — own SSE channel `/api/deploy/events`.

## Credentials

Persisted to `/var/lib/atomic-crm/supabase-deploy/config.json` (mode 600). Never returned by `/api/deploy/status`. Redacted from streamed logs. Blank field on save = keep stored value (safe partial edits). Only `projectRef` identifies the Supabase project — URL is derived (`https://<ref>.supabase.co`), never entered directly.

## Deploy gate

Requires BOTH targets fully configured (Supabase + Cloudflare). Server-side: `isDeployable` — `handleDeployRun` returns 412 if not met. Client-side: Deploy button disabled.

## Phases (run in-process under a `script` PTY)

| # | Phase | Notes |
|---|---|---|
| 0 | vite build | Isolated `_deploy` worktree — never touches live `/app/src` |
| 1 | supabase link | |
| 2 | db push | |
| 3 | functions deploy | |
| 4 | secrets set | |
| 5 | wrangler deploy | Deploys assets-only Worker named `atomic-crm-<projectRef>` (account ID lowercased), SPA fallback |

## Build worktree (`_deploy`)

- Checked out from `HEAD` at `/app/worktrees/_deploy`, `node_modules` hard-linked in
- Overlays `App.supabase.tsx` variant from `/app-variants/` — **FATAL if missing** (aborts, never ships FakeRest build)
- Bakes `VITE_SUPABASE_URL` + `VITE_SB_PUBLISHABLE_KEY` into the bundle
- Removed in `finally` block (success or failure)

`wrangler` is installed globally in the image.
