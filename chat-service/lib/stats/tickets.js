import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Read TASK-*.json files from the session directory and compute their wave
// number from the dependency graph (Kahn's algorithm — every ticket whose
// deps are already merged moves into the next wave). Returns null if the
// session has no ticket files (SIMPLE flow, planner failed, ...).
export async function loadTicketsAndWaves(sessionDir) {
  let entries;
  try { entries = await readdir(sessionDir); } catch { return null; }
  const taskFiles = entries.filter((n) => /^TASK-\d+\.json$/.test(n));
  if (taskFiles.length === 0) return null;
  const tickets = [];
  for (const f of taskFiles) {
    try {
      const t = JSON.parse(await readFile(join(sessionDir, f), 'utf8'));
      tickets.push({
        id: t.ticket_id || f.replace(/\.json$/, ''),
        title: t.title || '',
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        parallelSafe: t.parallel_safe !== false,
        status: t.status || 'pending',
        riskLevel: t.risk_level || null,
      });
    } catch { /* skip malformed */ }
  }
  // Topological wave assignment
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const remaining = new Set(tickets.map((t) => t.id));
  const waves = [];
  let safety = tickets.length + 1; // protect against dep cycles
  while (remaining.size > 0 && safety-- > 0) {
    const ready = [...remaining].filter((id) => {
      const t = byId.get(id);
      return t.dependencies.every((d) => !remaining.has(d));
    });
    if (ready.length === 0) {
      // Cycle or unresolvable dep — drop the rest into a final "stuck" wave.
      waves.push([...remaining]);
      break;
    }
    waves.push(ready);
    for (const id of ready) remaining.delete(id);
  }
  for (let i = 0; i < waves.length; i++) {
    for (const id of waves[i]) byId.get(id).wave = i + 1;
  }
  return { tickets: tickets.sort((a, b) => a.id.localeCompare(b.id)), waves };
}
