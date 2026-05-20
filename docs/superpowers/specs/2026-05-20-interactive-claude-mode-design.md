# Interactive Claude Mode — Design Spec

**Date**: 2026-05-20  
**Branch**: feat/removeUseOf-P  
**Goal**: Remove `--print` from the Claude spawn, connect chat-service to Claude interactive mode.

---

## Context

The current `PtySession` spawns:
```
claude --print --output-format stream-json --input-format stream-json --verbose
       --dangerously-skip-permissions --strict-mcp-config --mcp-config {}
       [--model <m>] [--resume <id>]
```

This works but uses `--print`, which the user wants removed. Without `--print`, `--output-format stream-json` is silently ignored and Claude launches its Ink TUI — ANSI output, not structured JSON events.

---

## Approach

**Spawn without `--print`**, using `node-pty` to create a proper PTY (ensures Claude starts cleanly — terminal queries are answered by the PTY automatically).  
**Text extraction**: watch the JSONL transcript Claude writes to disk — same format as stream-json assistant events, so `turn.js` stays unchanged.  
**Turn-end detection**: strip ANSI from `onData` chunks, detect the Claude prompt character. Fallback: 1500ms silence timeout.

Build tools (`python3`, `make`, `g++`) are confirmed available in the container — `node-pty` compiles without issues.

---

## Architecture

```
Before:
  PtySession → claude --print --output-format stream-json --input-format stream-json
               stdout JSON events → turn.js event loop

After:
  PtySession → node-pty.spawn('claude', ['--dangerously-skip-permissions', ...])
               ├─ onData → strip ANSI → prompt detection → emit synthetic {type:'result'}
               └─ JSONL watcher → new assistant entries → emit {type:'assistant', message:{...}}
               Both feed the same event emitter turn.js already listens to
```

`turn.js` event loop is **unchanged**. The same `for await (const event of ptyEventsUntilResult(session))` loop works because `PtySession` emits compatible events.

---

## PtySession

### Spawn

```javascript
import pty from 'node-pty';

pty.spawn('claude', ['--dangerously-skip-permissions', ...modelArg, ...resumeArg], {
  name: 'xterm-256color',
  cols: 220,
  rows: 50,
  cwd: CWD,
  env: buildSpawnEnv({ ...process.env, HOME: CLAUDE_HOME, CLAUDE_PROJECT_DIR: CWD, ... }),
})
```

Remove: `--print`, `--output-format stream-json`, `--input-format stream-json`, `--verbose`, `--strict-mcp-config`, `--mcp-config {}`.

### Sending messages

```javascript
// Old: JSON line to stdin
this.#proc.stdin.write(JSON.stringify({type:'user', message:{role:'user', content: msg}}) + '\n')

// New: plain text via PTY write
this.#pty.write(msg + '\r')  // \r = Enter in PTY
```

### JSONL watcher (text extraction)

Claude writes its transcript to:
```
/home/developer/.claude/projects/-app/<sessionId>.jsonl
```

The slug `-app` = `/app`.replace(/\//g, '-').

**Session ID discovery**:
1. Before spawn: snapshot existing `.jsonl` files in the projects dir.
2. After spawn: `fs.watch` the directory, first new `.jsonl` file → its basename (without `.jsonl`) is the session ID.
3. With `--resume <id>`: the file already exists, watch it directly.

**Reading new entries**:
- Track byte offset of last read.
- On file change, read from offset → split on `\n` → parse JSON lines.
- For each `{type:'assistant', message:{role:'assistant', content:[...]}}` line: emit that event directly on the PtySession emitter.
- Emit `{session_id: <id>}` once on first discovery (turn.js checks `if (event.session_id)`).

### Turn-end detection

```javascript
#detectTurnEnd(rawChunk) {
  const text = stripAnsi(rawChunk);
  // Claude Code interactive prompt appears when Claude is ready for next input
  if (/[❯>]\s*$/.test(text.trimEnd())) {
    this.#emitResult();
  }
}
```

Fallback: reset a 1500ms timer on each stdout chunk. If it fires, call `#emitResult()`.

`#emitResult()` emits once per turn:
```javascript
this.emit('event', { type: 'result', is_error: false, total_cost_usd: 0, modelUsage: {} });
```

---

## Changes to `turn.js`

Minimal. The event loop, `extractText`, `extractToolUses`, duplicate-message suppression, `pendingTicketWrites` tracking — all unchanged.

**Remove**:
- `--strict-mcp-config` / `--mcp-config` args (were in PtySession, now gone).
- The `rewriteUserMessage` + `buildPrompt` wrapping is still used; the result is passed as plain text to `session.send()`.

**Stats side effects** (no code change needed, values just become 0):
- `event.modelUsage` → `{}` → `breakdownFromModelUsage({})` returns zeros → tokens stay 0.
- `event.total_cost_usd` → `0` → cost stays 0.
- No `system` task events → `activeAgents` stays 0.

The UI stats ticker shows zeros for cost/tokens. That's accepted.

---

## What is lost

| Feature | Status |
|---------|--------|
| Token counts (input/output/cache) | Lost — not in JSONL transcript |
| Cost (USD) | Lost — not in JSONL transcript |
| Active agents counter | Lost — no `system` task events |
| Rate limit detection | Lost — no `rate_limit_event` |
| Tool use tracking (pendingTicketWrites) | Lost — `extractToolUses` returns `[]` from JSONL entries (JSONL stores final content, not mid-turn tool blocks) |

`pendingTicketWrites` silently becomes a no-op (no tool_use blocks in JSONL assistant entries). Ticket progress still updates via `sendProgress` on `result`.

---

## Dependencies

- `node-pty` — native module, compiles with `python3`/`make`/`g++` (confirmed available in container).
- `strip-ansi` (pure JS) — for prompt detection only.

---

## Files changed

| File | Change |
|------|--------|
| `chat-service/lib/server/pty-session.js` | Full rewrite: child_process → interactive spawn + JSONL watcher + prompt detection |
| `chat-service/package.json` | Add `node-pty` and `strip-ansi` dependencies |
| `chat-service/lib/server/turn.js` | Remove `--strict-mcp-config` args (they were in PtySession constructor, not turn.js — likely no change needed) |
| `chat-service/lib/server/claude-spawn.js` | `spawnClaude` kept for `regenerateTitleWithHaiku` only; `spawnClaude` itself may become unused |
