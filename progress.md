## Docker image — issues encountered and resolved

- ttyd requires a pty to provide a working terminal
- supervisor configuration issues (multi-line commands, user switching)
- Claude Code requires a non-root user for --dangerously-skip-permissions
- Chromium path must be explicitly set via environment variable
- Vite cache directories must be pre-created as developer to avoid root ownership on first run
- Docker socket access: developer user must be added to the socket's owner group (GID varies per host)
- Must use Playwright's own managed chromium (chromium-headless-shell), not the system one
- CI=true required for headless e2e tests
- network_mode: host required for full mode so that Supabase containers (started on host via socket) are reachable via localhost

## Known upstream test issue

File: e2e/userAddingATask.spec.ts line 54
`getByText('Jane Smith')` matches 2 elements in strict mode — the contact name link
and a truncated label elsewhere on the page. Playwright refuses to click an ambiguous selector.

Fix: add `.first()` to the selector:
```ts
await page.getByText("Jane Smith").first().click();
```
