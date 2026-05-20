import { EventEmitter } from 'node:events';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, basename } from 'node:path';

export class TranscriptWatcher extends EventEmitter {
  #sessionId;
  #projectDir;
  #jsonlPath = null;
  #linesRead = 0;
  #fileWatcher = null;
  #dirWatcher = null;
  #debounce = null;
  closed = false;

  // projectDir: directory containing <sessionId>.jsonl files.
  // sessionId: null for new sessions (watch dir), string for resumed sessions.
  constructor(sessionId, projectDir) {
    super();
    this.#sessionId = sessionId || null;
    this.#projectDir = projectDir;
    if (sessionId) {
      this.#jsonlPath = join(projectDir, `${sessionId}.jsonl`);
    }
  }

  async start() {
    if (this.#sessionId) {
      // Resumed session: seek to current end-of-file so we only see new lines.
      try {
        const content = await readFile(this.#jsonlPath, 'utf8');
        this.#linesRead = (content.match(/\n/g) || []).length;
      } catch { /* file doesn't exist yet — will be created shortly */ }
      this.#watchFile();
    } else {
      // Ensure the project dir exists before watching — fs.watch() throws
      // synchronously on a missing directory, which would silently swallow
      // all events if the caller does .catch(() => {}).
      await mkdir(this.#projectDir, { recursive: true }).catch(() => {});
      await this.#watchDir();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.#debounce);
    this.#fileWatcher?.close();
    this.#dirWatcher?.close();
  }

  async #watchDir() {
    // Snapshot files that exist before we start watching — ignore them.
    let before;
    try {
      const files = await readdir(this.#projectDir);
      before = new Set(files.filter(f => f.endsWith('.jsonl')));
    } catch {
      before = new Set();
    }

    // Extracted so both the watcher callback and the post-attach re-check can use it.
    // `before.add()` makes it idempotent against duplicate calls.
    const handleNewFile = (filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;
      if (before.has(filename)) return;
      before.add(filename);

      const id = basename(filename, '.jsonl');
      this.#sessionId = id;
      this.#jsonlPath = join(this.#projectDir, filename);

      this.emit('event', { session_id: id });

      this.#dirWatcher?.close();
      this.#dirWatcher = null;
      this.#watchFile();
    };

    this.#dirWatcher = watch(this.#projectDir, { persistent: false }, (_event, filename) => {
      handleNewFile(filename);
    });

    // Post-attach re-check: catches files created between readdir resolving and
    // watch() registering (tiny window, but possible under load).
    try {
      const files = await readdir(this.#projectDir);
      for (const f of files) handleNewFile(f);
    } catch { /* ignore */ }
  }

  #watchFile() {
    // Debounce rapid change events — JSONL writes can trigger multiple events.
    this.#fileWatcher = watch(this.#jsonlPath, { persistent: false }, () => {
      clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => this.#poll().catch(() => {}), 50);
    });
    // Initial poll in case lines were written before the watcher was attached.
    this.#poll().catch(() => {});
  }

  async #poll() {
    if (!this.#jsonlPath) return;
    let content;
    try {
      content = await readFile(this.#jsonlPath, 'utf8');
    } catch { return; }

    const lines = content.split('\n');
    for (let i = this.#linesRead; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) { if (i < lines.length - 1) this.#linesRead = i + 1; continue; }
      let entry;
      try { entry = JSON.parse(raw); } catch { break; } // partial line — retry next poll
      this.#linesRead = i + 1;
      if (entry.type === 'assistant') {
        this.emit('event', entry);
      }
    }
  }
}
