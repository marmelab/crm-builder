# Session Stats Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter dans le chat widget un panel de statistiques par session consultable en idle, basé sur le JSONL de session et `hooks.log`, couvrant chronologie agents/tool calls, skills/hooks/rules, top opérations, erreurs et retries.

**Architecture:** Nouveau module serveur `chat-service/lib/stats.js` qui agrège le log de session en une fonction pure `aggregateSession()` exportée ; nouvelle route HTTP `GET /api/stats` dans `chat-service/server.js` qui expose l'agrégé en JSON ; extensions client dans `public/index.html`, `chat.js`, `chat.css` pour ajouter le bouton, basculer en mode stats et rendre le panel. Pas de cache serveur au premier jet, parse complet à chaque clic.

**Tech Stack:** Node 20 (ESM, built-in `node:test`, `node:readline`, `node:fs/promises`), vanilla JS côté client (pas de framework), CSS vanilla dans `chat.css`. Aucune nouvelle dépendance npm.

**Spec de référence:** [docs/superpowers/specs/2026-04-23-session-stats-panel-design.md](../specs/2026-04-23-session-stats-panel-design.md)

---

## Safety notes

- **Côté client, construction DOM exclusivement via `document.createElement` + `textContent`**. Pas d'assignation de HTML dynamique à partir de données (descriptions d'agents, chemins de fichiers, contenus de prompt…) — ces champs peuvent contenir du texte qui trouve son origine dans le message utilisateur. Un helper `el(tag, props, ...children)` est introduit en Task 10 pour rendre ça concis.
- **Côté serveur, isolation du chemin de fichier** : `/api/stats` ne reçoit jamais un chemin brut. Il reçoit uniquement un `sessionId`, qu'il résout via la map interne `sessionLogs` peuplée depuis l'événement `session_id` de Claude. Rien ne passe directement depuis la query au filesystem.

## File Structure

**Nouveaux fichiers :**

- `chat-service/lib/stats.js` — agrégation pure. Exporte `aggregateSession({ sessionLogPath, hooksLogPath, sessionId }) → Promise<AggregatedSession>`.
- `chat-service/test/stats.test.js` — tests unitaires node:test.
- `chat-service/test/fixtures/empty-session.jsonl`
- `chat-service/test/fixtures/simple-quick-edit.jsonl`
- `chat-service/test/fixtures/single-team-single-ticket.jsonl`
- `chat-service/test/fixtures/parallel-two-teams.jsonl` (adapté du log réel 2026-04-23T09-38-50)
- `chat-service/test/fixtures/malformed-lines.jsonl`
- `chat-service/test/fixtures/hooks.log.single-team`
- `chat-service/test/fixtures/hooks.log.parallel-teams`
- `chat-service/test/fixtures/skills-rules.jsonl`

**Fichiers modifiés :**

- `chat-service/server.js`
- `chat-service/package.json` (script test)
- `chat-service/public/index.html`
- `chat-service/public/chat.js`
- `chat-service/public/chat.css`

---

## Task 1: Scaffolding — fixtures + module vide + premier test

**Files:**
- Create: `chat-service/lib/stats.js`, `chat-service/test/stats.test.js`, toutes les fixtures listées
- Modify: `chat-service/package.json`

- [ ] **Step 1: Copier le log réel comme base pour `parallel-two-teams.jsonl`**

```bash
docker exec atomic-crm-demo cat /chat-service/logs/session-2026-04-23T09-38-50-907Z.jsonl > /home/jerome/Work/crm-builder/chat-service/test/fixtures/parallel-two-teams.jsonl
```

- [ ] **Step 2: Extraire la fenêtre hooks.log correspondante**

```bash
docker exec atomic-crm-demo bash -c "grep -E '^\\[2026-04-23T09:[34][0-9]|^\\[2026-04-23T10:0[0-9]' /chat-service/logs/hooks.log" > /home/jerome/Work/crm-builder/chat-service/test/fixtures/hooks.log.parallel-teams
```

- [ ] **Step 3: Créer `empty-session.jsonl`**

Contenu :

```
{"ts":"2026-04-23T12:00:00.000Z","dir":"out","type":"debug_raw","event":{"type":"system","subtype":"init","cwd":"/app","session_id":"00000000-0000-0000-0000-000000000001","tools":["Task","Bash","Read"]}}
{"ts":"2026-04-23T12:00:02.000Z","dir":"out","type":"debug_raw","event":{"type":"result","subtype":"success","is_error":false,"duration_ms":2000,"num_turns":1,"result":"ok","session_id":"00000000-0000-0000-0000-000000000001","total_cost_usd":0.001,"usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":3}}}
```

- [ ] **Step 4: Créer `simple-quick-edit.jsonl`**

```
{"ts":"2026-04-23T12:00:00.000Z","dir":"in","type":"user_message","content":"Rename foo to bar"}
{"ts":"2026-04-23T12:00:00.100Z","dir":"out","type":"status","working":true}
{"ts":"2026-04-23T12:00:01.000Z","dir":"out","type":"debug_raw","event":{"type":"system","subtype":"init","cwd":"/app","session_id":"00000000-0000-0000-0000-000000000002","tools":["Task","Bash","Read","Edit"]}}
{"ts":"2026-04-23T12:00:02.000Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_001","name":"Read","input":{"file_path":"/app/src/foo.ts"}}]},"session_id":"00000000-0000-0000-0000-000000000002"}}
{"ts":"2026-04-23T12:00:02.500Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_002","name":"Edit","input":{"file_path":"/app/src/foo.ts","old_string":"foo","new_string":"bar"}}]},"session_id":"00000000-0000-0000-0000-000000000002"}}
{"ts":"2026-04-23T12:00:03.000Z","dir":"out","type":"debug_raw","event":{"type":"result","subtype":"success","is_error":false,"duration_ms":3000,"num_turns":1,"session_id":"00000000-0000-0000-0000-000000000002","total_cost_usd":0.01,"usage":{"input_tokens":100,"cache_creation_input_tokens":200,"cache_read_input_tokens":500,"output_tokens":50}}}
{"ts":"2026-04-23T12:00:03.100Z","dir":"out","type":"status","working":false}
```

- [ ] **Step 5: Créer `single-team-single-ticket.jsonl`**

```
{"ts":"2026-04-23T13:00:00.000Z","dir":"in","type":"user_message","content":"Add X feature"}
{"ts":"2026-04-23T13:00:00.100Z","dir":"out","type":"status","working":true}
{"ts":"2026-04-23T13:00:01.000Z","dir":"out","type":"debug_raw","event":{"type":"system","subtype":"init","cwd":"/app","session_id":"sess-single","tools":["Task","Agent","TeamCreate","TeamDelete","Bash","Read","Edit","Skill"]}}
{"ts":"2026-04-23T13:00:02.000Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tc_001","name":"TeamCreate","input":{"team_name":"ticket-TASK-100","description":"Add X feature"}}]},"session_id":"sess-single"}}
{"ts":"2026-04-23T13:00:03.000Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"ag_dev","name":"Agent","input":{"subagent_type":"developer","team_name":"ticket-TASK-100","description":"Implement TASK-100","prompt":"WORKTREE_PATH=/worktrees/TASK-100\nBRANCH_NAME=feature/x\nMODE=demo","isolation":"worktree"}}]},"session_id":"sess-single"}}
{"ts":"2026-04-23T13:00:03.100Z","dir":"out","type":"debug_raw","event":{"type":"system","subtype":"task_started","task_id":"tsk_dev","tool_use_id":"ag_dev","task_type":"local_agent","description":"Implement TASK-100"}}
{"ts":"2026-04-23T13:00:10.000Z","dir":"out","type":"debug_raw","event":{"type":"system","subtype":"task_notification","task_id":"tsk_dev","tool_use_id":"ag_dev","status":"completed","usage":{"total_tokens":5000,"tool_uses":4,"duration_ms":6900}}}
{"ts":"2026-04-23T13:00:11.000Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"ag_rev","name":"Agent","input":{"subagent_type":"quality-reviewer","team_name":"ticket-TASK-100","description":"Review TASK-100","prompt":"Review in /worktrees/TASK-100"}}]},"session_id":"sess-single"}}
{"ts":"2026-04-23T13:00:11.100Z","dir":"out","type":"debug_raw","event":{"type":"system","subtype":"task_started","task_id":"tsk_rev","tool_use_id":"ag_rev","task_type":"local_agent","description":"Review TASK-100"}}
{"ts":"2026-04-23T13:00:15.000Z","dir":"out","type":"debug_raw","event":{"type":"system","subtype":"task_notification","task_id":"tsk_rev","tool_use_id":"ag_rev","status":"completed","usage":{"total_tokens":2500,"tool_uses":3,"duration_ms":3900}}}
{"ts":"2026-04-23T13:00:16.000Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tm_del","name":"TeamDelete","input":{}}]},"session_id":"sess-single"}}
{"ts":"2026-04-23T13:00:17.000Z","dir":"out","type":"debug_raw","event":{"type":"result","subtype":"success","is_error":false,"duration_ms":17000,"num_turns":1,"session_id":"sess-single","total_cost_usd":0.1,"usage":{"input_tokens":1000,"cache_creation_input_tokens":2000,"cache_read_input_tokens":5000,"output_tokens":800}}}
{"ts":"2026-04-23T13:00:17.100Z","dir":"out","type":"status","working":false}
```

- [ ] **Step 6: Créer `hooks.log.single-team`**

```
[2026-04-23T13:00:08+00:00] typecheck START pwd=/worktrees/TASK-100 MODE=demo
[2026-04-23T13:00:09+00:00] typecheck OK wt=/worktrees/TASK-100
[2026-04-23T13:00:09+00:00] typecheck EXIT=0 OK (all worktrees)
[2026-04-23T13:00:09+00:00] unit-fn SKIP wt=/worktrees/TASK-100 (no changes)
[2026-04-23T13:00:09+00:00] unit-fn EXIT=0 no_active_worktree
```

- [ ] **Step 7: Créer `malformed-lines.jsonl`**

```
{"ts":"2026-04-23T14:00:00.000Z","dir":"in","type":"user_message","content":"test"}
{"ts":"2026-04-23T14:00:00.5", this is not valid JSON at all
{"ts":"2026-04-23T14:00:01.000Z","dir":"out","type":"debug_raw","event":{"type":"result","subtype":"success","is_error":false,"duration_ms":1000,"num_turns":1,"session_id":"sess-malformed","total_cost_usd":0.0005,"usage":{"input_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}
```

- [ ] **Step 8: Créer `skills-rules.jsonl`**

```
{"ts":"2026-04-23T14:00:00.000Z","dir":"in","type":"user_message","content":"test"}
{"ts":"2026-04-23T14:00:01.000Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Skill","input":{"skill":"superpowers:test-driven-development"}}]},"session_id":"sess-sr"}}
{"ts":"2026-04-23T14:00:02.000Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Skill","input":{"skill":"superpowers:test-driven-development"}}]},"session_id":"sess-sr"}}
{"ts":"2026-04-23T14:00:03.000Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t3","name":"Read","input":{"file_path":"/home/developer/.claude/rules/agent-output-format.md"}}]},"session_id":"sess-sr"}}
{"ts":"2026-04-23T14:00:04.000Z","dir":"out","type":"debug_raw","event":{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t4","name":"Read","input":{"file_path":"/app/.claude/rules/agent-output-format.md"}}]},"session_id":"sess-sr"}}
{"ts":"2026-04-23T14:00:05.000Z","dir":"out","type":"debug_raw","event":{"type":"result","subtype":"success","is_error":false,"duration_ms":5000,"num_turns":1,"session_id":"sess-sr","total_cost_usd":0.01,"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}}
```

- [ ] **Step 9: Squelette de `lib/stats.js`**

```javascript
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

async function* readJsonl(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip malformed */ }
  }
}

export async function aggregateSession({ sessionLogPath, hooksLogPath, sessionId }) {
  const events = [];
  for await (const ev of readJsonl(sessionLogPath)) events.push(ev);
  return {
    sessionId: sessionId ?? null,
    logPath: sessionLogPath,
    startTs: events[0]?.ts ?? null,
    endTs: events[events.length - 1]?.ts ?? null,
    durationMs: 0,
    summary: {
      totalMs: 0, agentsCount: 0, opsCount: 0, tokensTotal: 0, costUsd: 0,
      errorsCount: 0, retriesCount: 0, timeBreakdown: [],
    },
    teams: [], phases: [],
    topAgents: [], topToolCalls: [], toolCounts: [],
    skills: [], hooks: [], rules: [], errors: [], retries: [],
  };
}
```

- [ ] **Step 10: Mettre à jour `chat-service/package.json` pour scanner tout le dossier test/**

Changer la ligne `"test": "node --test test/server.test.js"` en :

```json
"test": "node --test test/"
```

- [ ] **Step 11: Premier test (session vide + malformé)**

Dans `chat-service/test/stats.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aggregateSession } from '../lib/stats.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');
const fx = (name) => join(fixturesDir, name);

test('aggregateSession: empty session returns zeroed shape', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('empty-session.jsonl'),
    hooksLogPath: null,
    sessionId: '00000000-0000-0000-0000-000000000001',
  });
  assert.equal(out.sessionId, '00000000-0000-0000-0000-000000000001');
  assert.equal(out.phases.length, 0);
  assert.equal(out.teams.length, 0);
  assert.equal(out.summary.agentsCount, 0);
});

test('aggregateSession: skips malformed JSONL lines', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('malformed-lines.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-malformed',
  });
  assert.equal(out.sessionId, 'sess-malformed');
});
```

- [ ] **Step 12: Lancer les tests**

Run: `cd chat-service && npm test`
Expected: PASS sur 2 nouveaux tests + les 5 tests pré-existants de `server.test.js`.

- [ ] **Step 13: Commit**

```bash
git add chat-service/lib/stats.js chat-service/test/ chat-service/package.json
git commit -m "feat(stats): scaffold aggregator module with fixtures"
```

---

## Task 2: Summary — durée, totaux, tokens, coût

**Files:** Modify `chat-service/lib/stats.js`, `chat-service/test/stats.test.js`

- [ ] **Step 1: Test**

```javascript
test('aggregateSession: computes summary totals from simple session', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('simple-quick-edit.jsonl'),
    hooksLogPath: null,
    sessionId: '00000000-0000-0000-0000-000000000002',
  });
  assert.equal(out.startTs, '2026-04-23T12:00:00.000Z');
  assert.equal(out.endTs, '2026-04-23T12:00:03.100Z');
  assert.equal(out.durationMs, 3100);
  assert.equal(out.summary.totalMs, 3100);
  assert.equal(out.summary.opsCount, 2);
  assert.equal(out.summary.tokensTotal, 100 + 200 + 50);
  assert.equal(out.summary.costUsd, 0.01);
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `cd chat-service && npm test`
Expected: FAIL sur durationMs, opsCount, tokensTotal, costUsd.

- [ ] **Step 3: Implémenter `computeSummary` et brancher dans `aggregateSession`**

Dans `lib/stats.js`, avant `aggregateSession` :

```javascript
function extractToolUsesFromAssistant(ev) {
  if (ev.type !== 'assistant') return [];
  return (ev.message?.content || []).filter((b) => b.type === 'tool_use');
}

function msBetween(a, b) { return new Date(b).getTime() - new Date(a).getTime(); }

function computeSummary(events) {
  let opsCount = 0, tokensTotal = 0, costUsd = 0;
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    for (const _ of extractToolUsesFromAssistant(ev)) opsCount++;
    if (ev.type === 'result') {
      const u = ev.usage || {};
      tokensTotal += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      costUsd += ev.total_cost_usd || 0;
    }
  }
  return { opsCount, tokensTotal, costUsd };
}
```

Modifier `aggregateSession` : calculer `startTs`/`endTs`/`durationMs` depuis `events[0]`/`events.at(-1)` et remplir les champs `summary.totalMs/opsCount/tokensTotal/costUsd` via `computeSummary`.

- [ ] **Step 4: Run tests, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): compute session summary (duration, ops, tokens, cost)"
```

---

## Task 3: Phases + Teams

**Files:** Modify `chat-service/lib/stats.js`, `chat-service/test/stats.test.js`

- [ ] **Step 1: Tests**

```javascript
test('aggregateSession: extracts agent phases and links to team via Agent tool_use_id', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('single-team-single-ticket.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-single',
  });
  assert.equal(out.teams.length, 1);
  assert.equal(out.teams[0].team_name, 'ticket-TASK-100');
  assert.equal(out.teams[0].description, 'Add X feature');
  assert.equal(out.teams[0].agentsCount, 2);
  assert.equal(out.summary.agentsCount, 2);
  assert.equal(out.phases.length, 3);
  const orch = out.phases.find((p) => p.kind === 'orchestrator');
  assert.ok(orch);
  assert.equal(orch.teamName, null);
  const dev = out.phases.find((p) => p.description === 'Implement TASK-100');
  assert.equal(dev.agentType, 'developer');
  assert.equal(dev.teamName, 'ticket-TASK-100');
  assert.equal(dev.durationMs, 6900);
  const tb = out.summary.timeBreakdown;
  assert.ok(tb.find((r) => r.agent === 'orchestrator'));
  assert.ok(tb.find((r) => r.agent === 'developer' && r.ms === 6900));
});

test('aggregateSession: parallel-two-teams fixture has correct team assignments', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-parallel',
  });
  const teamNames = out.teams.map((t) => t.team_name).sort();
  assert.deepEqual(teamNames, ['ticket-TASK-003', 'ticket-TASK-004']);
  const t003 = out.phases.filter((p) => p.kind === 'agent' && /TASK-003/.test(p.description));
  assert.ok(t003.length >= 3);
  for (const p of t003) assert.equal(p.teamName, 'ticket-TASK-003');
  const bootstrap = out.phases.find((p) => p.description === 'Bootstrap project context');
  assert.equal(bootstrap.teamName, null);
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implémenter extractTeams + extractPhases + orchestrator synthétique**

Ajouter dans `lib/stats.js` avant `aggregateSession` :

```javascript
function colorFromName(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 65% 55%)`;
}

function extractTeams(events) {
  const agentToolIdToTeam = new Map();
  const teams = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (b.name === 'TeamCreate' && b.input?.team_name) {
        const n = b.input.team_name;
        if (!teams.has(n)) {
          teams.set(n, {
            team_name: n,
            description: b.input.description ?? '',
            color: colorFromName(n),
            durationMs: 0, agentsCount: 0, errorsCount: 0,
          });
        }
      } else if ((b.name === 'Agent' || b.name === 'Task') && b.input?.team_name) {
        agentToolIdToTeam.set(b.id, b.input.team_name);
      }
    }
  }
  return { teams, agentToolIdToTeam };
}

function extractPhases(events, agentToolIdToTeam) {
  const byTaskId = new Map();
  const agentTypeByToolId = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if ((b.name === 'Agent' || b.name === 'Task') && b.input?.subagent_type) {
        agentTypeByToolId.set(b.id, b.input.subagent_type);
      }
    }
  }
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_started' && ev.task_type === 'local_agent') {
      byTaskId.set(ev.task_id, {
        phaseId: ev.task_id,
        kind: 'agent',
        agentType: agentTypeByToolId.get(ev.tool_use_id) ?? 'unknown',
        description: ev.description || '',
        teamName: agentToolIdToTeam.get(ev.tool_use_id) ?? null,
        startTs: rec.ts,
        endTs: null, durationMs: 0, opsCount: 0, tokensTotal: 0,
        errorsCount: 0, retriesCount: 0, children: [],
        _toolUseId: ev.tool_use_id,
      });
    } else if (ev.type === 'system' && ev.subtype === 'task_notification' && byTaskId.has(ev.task_id)) {
      const p = byTaskId.get(ev.task_id);
      p.endTs = rec.ts;
      const u = ev.usage || {};
      p.durationMs = u.duration_ms || msBetween(p.startTs, p.endTs);
      p.opsCount = u.tool_uses || 0;
      p.tokensTotal = u.total_tokens || 0;
    }
  }
  return [...byTaskId.values()].sort((a, b) => a.startTs.localeCompare(b.startTs));
}

function buildOrchestratorPhase(events, agentPhases, startTs, endTs) {
  const agentTotalMs = agentPhases.reduce((a, p) => a + p.durationMs, 0);
  const totalMs = startTs && endTs ? msBetween(startTs, endTs) : 0;
  let opsCount = 0;
  const skip = new Set(['Agent', 'Task', 'TeamCreate', 'TeamDelete']);
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (skip.has(b.name)) continue;
      opsCount++;
    }
  }
  return {
    phaseId: 'orchestrator', kind: 'orchestrator', agentType: 'orchestrator',
    description: 'Orchestrator', teamName: null,
    startTs, endTs, durationMs: Math.max(0, totalMs - agentTotalMs),
    opsCount, tokensTotal: 0, errorsCount: 0, retriesCount: 0, children: [],
  };
}

function buildTimeBreakdown(orchestrator, agentPhases) {
  const byAgent = new Map([['orchestrator', orchestrator.durationMs]]);
  for (const p of agentPhases) byAgent.set(p.agentType, (byAgent.get(p.agentType) || 0) + p.durationMs);
  return [...byAgent].map(([agent, ms]) => ({ agent, ms })).sort((a, b) => b.ms - a.ms);
}
```

Brancher dans `aggregateSession` : appeler `extractTeams`, `extractPhases`, `buildOrchestratorPhase`, puis ordonner `phases` et peupler `summary.agentsCount` + `summary.timeBreakdown` + `teams[]` avec les durées/counts cumulés.

- [ ] **Step 4: Run tests, PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): extract agent phases and teams via Agent.tool_use_id"
```

---

## Task 4: Children des phases + toolCounts + top ops

**Files:** Modify `chat-service/lib/stats.js`, `chat-service/test/stats.test.js`

- [ ] **Step 1: Tests**

```javascript
test('aggregateSession: orchestrator phase children exclude Agent/Task/Team* dispatches', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('single-team-single-ticket.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-single',
  });
  const orch = out.phases.find((p) => p.kind === 'orchestrator');
  assert.equal(orch.children.filter((c) => c.kind === 'tool_use').length, 0);
});

test('aggregateSession: toolCounts ordered by count desc', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('simple-quick-edit.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-simple',
  });
  assert.equal(out.toolCounts.length, 2);
  const names = out.toolCounts.map((t) => t.tool).sort();
  assert.deepEqual(names, ['Edit', 'Read']);
  for (const t of out.toolCounts) assert.equal(t.count, 1);
});

test('aggregateSession: topAgents sorted by durationMs desc', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-parallel',
  });
  assert.ok(out.topAgents.length > 0 && out.topAgents.length <= 5);
  for (let i = 1; i < out.topAgents.length; i++) {
    assert.ok(out.topAgents[i - 1].durationMs >= out.topAgents[i].durationMs);
  }
});

test('aggregateSession: topToolCalls flags ops >30s as flaggedSlow', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-parallel',
  });
  assert.ok(out.topToolCalls.filter((c) => c.flaggedSlow).length >= 1);
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implémenter**

Dans `lib/stats.js`:

```javascript
function buildPhaseOwnerMap(events, agentPhases) {
  const phaseByToolUseId = new Map();
  for (const p of agentPhases) if (p._toolUseId) phaseByToolUseId.set(p._toolUseId, p);
  return phaseByToolUseId;
}

function resolvePhase(ev, phaseByToolUseId) {
  const cursor = ev.parent_tool_use_id;
  if (cursor && phaseByToolUseId.has(cursor)) return phaseByToolUseId.get(cursor);
  return null;
}

function toolDetail(toolName, input) {
  if (!input) return null;
  const short = (s, n = 80) => (typeof s === 'string' && s.length > n) ? '…' + s.slice(-n) : s;
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit': return short(input.file_path);
    case 'Bash': return short(input.command, 80);
    case 'Grep': return `"${input.pattern ?? ''}"${input.path ? ' in ' + input.path : ''}`;
    case 'Glob': return input.pattern ?? null;
    case 'Skill': return input.skill ?? null;
    default: return null;
  }
}

const SKIP_CHILD = new Set(['Agent', 'Task', 'TeamCreate', 'TeamDelete']);

function populateChildrenAndCounts(events, phases, orchestrator) {
  const agentPhases = phases.filter((p) => p.kind === 'agent');
  const phaseByToolUseId = buildPhaseOwnerMap(events, agentPhases);
  const toolCounts = new Map();
  const allToolCalls = [];
  const prevTsByPhase = new Map();

  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    const owner = resolvePhase(rec.event, phaseByToolUseId) ?? orchestrator;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (SKIP_CHILD.has(b.name)) continue;
      const prev = prevTsByPhase.get(owner.phaseId);
      const approxDurationMs = prev ? msBetween(prev, rec.ts) : 0;
      prevTsByPhase.set(owner.phaseId, rec.ts);
      if (b.name === 'Skill') {
        owner.children.push({
          kind: 'skill',
          skill: b.input?.skill || 'unknown',
          ts: rec.ts,
          approxDurationMs, isApprox: true,
        });
      } else {
        owner.children.push({
          kind: 'tool_use',
          tool: b.name, detail: toolDetail(b.name, b.input),
          ts: rec.ts,
          approxDurationMs, isApprox: true,
          agentType: owner.agentType,
        });
        const tc = toolCounts.get(b.name) || { tool: b.name, count: 0, totalDurationMs: 0, isApprox: true };
        tc.count++; tc.totalDurationMs += approxDurationMs;
        toolCounts.set(b.name, tc);
        allToolCalls.push({
          phaseId: owner.phaseId, tool: b.name, detail: toolDetail(b.name, b.input),
          durationMs: approxDurationMs, isApprox: true,
          teamName: owner.teamName ?? null,
          flaggedSlow: approxDurationMs > 30000,
          ts: rec.ts,
        });
      }
    }
  }

  // Refine Bash durations from local_bash task_notifications (they share tool_use_id)
  const bashDurByToolUseId = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_notification' && ev.task_type === 'local_bash' && ev.tool_use_id) {
      bashDurByToolUseId.set(ev.tool_use_id, ev.usage?.duration_ms || 0);
    }
  }
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (b.name !== 'Bash' || !bashDurByToolUseId.has(b.id)) continue;
      const dur = bashDurByToolUseId.get(b.id);
      const match = allToolCalls.find((c) => c.tool === 'Bash' && c.ts === rec.ts && c.isApprox);
      if (match) {
        match.durationMs = dur; match.isApprox = false; match.flaggedSlow = dur > 30000;
      }
    }
  }

  return {
    toolCounts: [...toolCounts.values()].sort((a, b) => b.count - a.count),
    allToolCalls,
  };
}

function buildTopAgents(agentPhases) {
  return [...agentPhases].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
    .map((p) => ({ phaseId: p.phaseId, label: `${p.agentType} ${p.description}`.trim(), durationMs: p.durationMs, teamName: p.teamName }));
}

function buildTopToolCalls(allToolCalls) {
  return [...allToolCalls].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5)
    .map(({ ts, ...rest }) => rest);
}
```

Branché dans `aggregateSession` après `phases` construits. Nettoyer les `_toolUseId` internes sur les phases avant de les renvoyer.

- [ ] **Step 4: Run, PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): populate phase children, tool counts, and top leaderboards"
```

---

## Task 5: Hooks — corrélation avec `hooks.log`

**Files:** Modify `chat-service/lib/stats.js`, `chat-service/test/stats.test.js`

- [ ] **Step 1: Tests**

```javascript
test('aggregateSession: correlates hooks.log with session window (single-team)', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('single-team-single-ticket.jsonl'),
    hooksLogPath: fx('hooks.log.single-team'),
    sessionId: 'sess-single',
  });
  const typecheck = out.hooks.find((h) => h.hookName === 'typecheck-on-commit.sh');
  assert.ok(typecheck);
  assert.equal(typecheck.runs, 1);
  assert.equal(typecheck.okCount, 1);
  assert.equal(typecheck.failCount, 0);
  assert.equal(typecheck.blocking, false);
  const unitFn = out.hooks.find((h) => h.hookName === 'run-unit-tests-functions.sh');
  assert.ok(unitFn);
  assert.equal(unitFn.skipCount, 1);
});

test('aggregateSession: blocking hooks marked blocking=true (parallel fixture)', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: fx('hooks.log.parallel-teams'),
    sessionId: 'sess-parallel',
  });
  const allowed = ['block-bash-file-write.sh','block-bash-validation.sh','circuit-breaker.sh','silent-mode-check.sh'];
  for (const h of out.hooks) {
    if (h.blocking) assert.ok(allowed.includes(h.hookName));
  }
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implémenter**

Dans `lib/stats.js`:

```javascript
const HOOK_NAME_MAP = {
  'typecheck': 'typecheck-on-commit.sh',
  'unit-app':  'run-unit-tests-app.sh',
  'unit-fn':   'run-unit-tests-functions.sh',
  'e2e':       'run-e2e-tests.sh',
  'prettier':  'prettier-on-stop.sh',
  'block-bash-file-write': 'block-bash-file-write.sh',
  'block-bash-validation': 'block-bash-validation.sh',
  'circuit-breaker':       'circuit-breaker.sh',
  'silent-mode-check':     'silent-mode-check.sh',
};
const BLOCKING_HOOKS = new Set([
  'block-bash-file-write.sh','block-bash-validation.sh','circuit-breaker.sh','silent-mode-check.sh',
]);

function parseHookLine(line) {
  const m = line.match(/^\[([^\]]+)\]\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!m) return null;
  const [, ts, shortName, state, rest = ''] = m;
  const wtMatch = rest.match(/wt=(\S+)/);
  const worktree = wtMatch ? wtMatch[1] : null;
  let kind = null, exitCode = null;
  if (state === 'START') kind = 'start';
  else if (state === 'SKIP') kind = 'skip';
  else if (state === 'OK') kind = 'ok';
  else if (state.startsWith('EXIT=')) { kind = 'exit'; exitCode = Number(state.slice(5)); }
  return { ts, shortName, kind, exitCode, worktree, rest };
}

async function readHooksLog(path, winStart, winEnd) {
  if (!path) return [];
  const raw = await readFile(path, 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  const ws = winStart ? new Date(winStart).getTime() : 0;
  const we = winEnd ? new Date(winEnd).getTime() : Infinity;
  for (const l of lines) {
    const p = parseHookLine(l);
    if (!p) continue;
    const t = new Date(p.ts).getTime();
    if (Number.isNaN(t) || t < ws || t > we) continue;
    out.push(p);
  }
  return out;
}

function aggregateHooks(hookLines) {
  const openByKey = new Map();
  const execsByName = new Map();
  for (const line of hookLines) {
    const fullName = HOOK_NAME_MAP[line.shortName] || `${line.shortName}.sh`;
    if (!execsByName.has(fullName)) execsByName.set(fullName, []);
    const key = `${line.shortName}|${line.worktree ?? '-'}`;
    if (line.kind === 'start') {
      openByKey.set(key, line);
    } else if (line.kind === 'exit') {
      const start = openByKey.get(key) ?? openByKey.get(`${line.shortName}|-`);
      const startTs = start?.ts ?? line.ts;
      openByKey.delete(key);
      execsByName.get(fullName).push({
        ts: startTs, worktree: line.worktree ?? start?.worktree ?? null,
        durationMs: msBetween(startTs, line.ts), exitCode: line.exitCode, tail: null,
      });
    } else if (line.kind === 'skip') {
      execsByName.get(fullName).push({
        ts: line.ts, worktree: line.worktree, durationMs: 0, exitCode: null, skip: true, tail: null,
      });
    }
  }
  const out = [];
  for (const [fullName, execs] of execsByName) {
    const runs = execs.filter((e) => !e.skip).length;
    out.push({
      hookName: fullName,
      hookType: BLOCKING_HOOKS.has(fullName) ? 'PreToolUse' : 'SubagentStop',
      runs,
      totalDurationMs: execs.reduce((a, e) => a + (e.durationMs || 0), 0),
      okCount: execs.filter((e) => !e.skip && e.exitCode === 0).length,
      failCount: execs.filter((e) => !e.skip && e.exitCode !== 0 && e.exitCode !== null).length,
      skipCount: execs.filter((e) => e.skip).length,
      blocking: BLOCKING_HOOKS.has(fullName),
      executions: execs,
    });
  }
  return out.sort((a, b) => b.runs - a.runs);
}

function extractWorktreeFromAgentPrompt(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/WORKTREE_PATH=(\S+)/);
  return m ? m[1] : null;
}

function assignHookExecsToPhases(events, phases, hookAggregates) {
  const worktreeByPhaseId = new Map();
  const toolUseIdToWorktree = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if ((b.name === 'Agent' || b.name === 'Task') && b.input?.prompt) {
        const wt = extractWorktreeFromAgentPrompt(b.input.prompt);
        if (wt) toolUseIdToWorktree.set(b.id, wt);
      }
    }
  }
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'task_started' && ev.tool_use_id && toolUseIdToWorktree.has(ev.tool_use_id)) {
      worktreeByPhaseId.set(ev.task_id, toolUseIdToWorktree.get(ev.tool_use_id));
    }
  }
  for (const agg of hookAggregates) {
    for (const exec of agg.executions) {
      if (!exec.worktree) continue;
      const phaseId = [...worktreeByPhaseId.entries()].find(([, wt]) => wt === exec.worktree)?.[0];
      if (!phaseId) continue;
      const phase = phases.find((p) => p.phaseId === phaseId);
      if (!phase) continue;
      phase.children.push({
        kind: 'hook',
        hookName: agg.hookName, hookType: agg.hookType,
        worktree: exec.worktree,
        startTs: exec.ts,
        endTs: exec.ts && exec.durationMs ? new Date(new Date(exec.ts).getTime() + exec.durationMs).toISOString() : exec.ts,
        durationMs: exec.durationMs,
        exitCode: exec.exitCode,
        result: exec.skip ? 'skip' : (exec.exitCode === 0 ? 'ok' : 'fail'),
      });
    }
  }
}
```

Brancher dans `aggregateSession` après la construction des phases.

- [ ] **Step 4: Run, PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): correlate hooks.log with session phases by worktree"
```

---

## Task 6: Skills et Rules

**Files:** Modify `chat-service/lib/stats.js`, `chat-service/test/stats.test.js`

- [ ] **Step 1: Test**

```javascript
test('aggregateSession: aggregates skills and rules', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('skills-rules.jsonl'),
    hooksLogPath: null,
    sessionId: 'sess-sr',
  });
  assert.equal(out.skills.length, 1);
  assert.equal(out.skills[0].skill, 'superpowers:test-driven-development');
  assert.equal(out.skills[0].count, 2);
  assert.equal(out.rules.length, 1);
  assert.equal(out.rules[0].ruleFile, 'agent-output-format.md');
  assert.equal(out.rules[0].reads, 2);
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implémenter**

```javascript
function aggregateSkills(phases) {
  const byName = new Map();
  for (const phase of phases) {
    for (const child of phase.children) {
      if (child.kind !== 'skill') continue;
      const row = byName.get(child.skill) ?? { skill: child.skill, count: 0, totalDurationMs: 0, invocations: [] };
      row.count++;
      row.totalDurationMs += child.approxDurationMs || 0;
      row.invocations.push({ ts: child.ts, agentType: phase.agentType, phaseId: phase.phaseId });
      byName.set(child.skill, row);
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count);
}

const RULE_PATH_RE = /\.claude\/rules\/([^/]+\.md)$/;

function aggregateRules(events, phases) {
  const agentPhases = phases.filter((p) => p.kind === 'agent');
  const phaseByToolUseId = buildPhaseOwnerMap(events, agentPhases);
  const byFile = new Map();
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || rec.event?.type !== 'assistant') continue;
    for (const b of extractToolUsesFromAssistant(rec.event)) {
      if (b.name !== 'Read') continue;
      const m = typeof b.input?.file_path === 'string' && b.input.file_path.match(RULE_PATH_RE);
      if (!m) continue;
      const ruleFile = m[1];
      const owner = resolvePhase(rec.event, phaseByToolUseId);
      const agentType = owner?.agentType ?? 'orchestrator';
      const row = byFile.get(ruleFile) ?? { ruleFile, reads: 0, readers: new Map() };
      row.reads++;
      row.readers.set(agentType, (row.readers.get(agentType) || 0) + 1);
      byFile.set(ruleFile, row);
    }
  }
  return [...byFile.values()]
    .map((r) => ({
      ruleFile: r.ruleFile, reads: r.reads,
      readers: [...r.readers].map(([agentType, count]) => ({ agentType, count })).sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.reads - a.reads);
}
```

Brancher dans `aggregateSession`.

- [ ] **Step 4: Run, PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): aggregate skills usage and rules reads"
```

---

## Task 7: Erreurs et retries

**Files:** Modify `chat-service/lib/stats.js`, `chat-service/test/stats.test.js`

- [ ] **Step 1: Tests**

```javascript
test('aggregateSession: detects (retry) suffix retries', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: fx('hooks.log.parallel-teams'),
    sessionId: 'sess-parallel',
  });
  const retries = out.retries.filter((r) => r.matchMethod === 'suffix-parens-retry');
  assert.ok(retries.length >= 1);
  assert.ok(retries.find((r) => /TASK-004/.test(r.description)));
});

test('aggregateSession: summary error/retry counts match arrays', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: fx('hooks.log.parallel-teams'),
    sessionId: 'sess-parallel',
  });
  assert.equal(out.summary.errorsCount, out.errors.length);
  assert.equal(out.summary.retriesCount, out.retries.length);
});

test('aggregateSession: blocking hooks EXIT=2 are NOT errors', async () => {
  const out = await aggregateSession({
    sessionLogPath: fx('parallel-two-teams.jsonl'),
    hooksLogPath: fx('hooks.log.parallel-teams'),
    sessionId: 'sess-parallel',
  });
  const blocked = ['block-bash-file-write.sh','block-bash-validation.sh','circuit-breaker.sh','silent-mode-check.sh'];
  for (const e of out.errors) {
    if (e.kind !== 'hook_failed') continue;
    assert.ok(!blocked.includes(e.payload?.hookName));
  }
});
```

- [ ] **Step 2: Run, confirm FAIL**

- [ ] **Step 3: Implémenter**

```javascript
function tailPayload(obj, maxLen = 800) {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
  } catch { return null; }
}

function detectErrors(events, phases, hooks) {
  const errs = [];
  for (const rec of events) {
    if (rec.type !== 'debug_raw' || !rec.event) continue;
    const ev = rec.event;
    if (ev.type === 'system' && ev.subtype === 'notification' && ev.priority === 'immediate') {
      errs.push({ kind: 'notification', ts: rec.ts, phaseId: null, teamName: null,
        summary: ev.text || ev.key || 'notification', payload: tailPayload(ev) });
    } else if (ev.type === 'result' && ev.is_error) {
      errs.push({ kind: 'turn_error', ts: rec.ts, phaseId: null, teamName: null,
        summary: `Turn failed: ${ev.api_error_status || ev.result || 'error'}`, payload: tailPayload(ev) });
    } else if (ev.type === 'system' && ev.subtype === 'task_notification' && ev.status === 'failed') {
      const phase = phases.find((p) => p.phaseId === ev.task_id);
      errs.push({ kind: 'task_failed', ts: rec.ts, phaseId: ev.task_id, teamName: phase?.teamName ?? null,
        summary: `${phase?.description ?? ev.task_id} failed`, payload: tailPayload(ev) });
    }
  }
  for (const h of hooks) {
    if (h.blocking) continue;
    for (const e of h.executions) {
      if (e.exitCode != null && e.exitCode !== 0) {
        errs.push({ kind: 'hook_failed', ts: e.ts, phaseId: null, teamName: null,
          summary: `${h.hookName} EXIT=${e.exitCode}`,
          payload: { hookName: h.hookName, worktree: e.worktree, exitCode: e.exitCode } });
      }
    }
  }
  return errs.sort((a, b) => a.ts.localeCompare(b.ts));
}

function commonPrefixRatio(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return Math.max(a.length, b.length) === 0 ? 1 : i / Math.max(a.length, b.length);
}

function detectRetries(phases, errors) {
  const retries = [];
  const sortedAgents = phases.filter((p) => p.kind === 'agent').sort((a, b) => a.startTs.localeCompare(b.startTs));
  const retrySet = new Set();

  const SUFFIX = /\((retry|after [^)]+)\)\s*$/i;
  for (const p of sortedAgents) {
    if (SUFFIX.test(p.description)) {
      retries.push({ ts: p.startTs, triggeredByErrorTs: null, phaseId: p.phaseId,
        description: p.description, matchMethod: 'suffix-parens-retry' });
      retrySet.add(p.phaseId);
    }
  }

  for (const err of errors.filter((e) => e.kind === 'task_failed')) {
    const errPhase = sortedAgents.find((p) => p.phaseId === err.phaseId);
    if (!errPhase) continue;
    const windowEnd = new Date(err.ts).getTime() + 5 * 60 * 1000;
    const cand = sortedAgents.find((p) =>
      !retrySet.has(p.phaseId) &&
      p.startTs > err.ts &&
      new Date(p.startTs).getTime() <= windowEnd &&
      commonPrefixRatio(errPhase.description, p.description) > 0.8
    );
    if (cand) {
      retries.push({ ts: cand.startTs, triggeredByErrorTs: err.ts, phaseId: cand.phaseId,
        description: cand.description, matchMethod: 'failure-followed-by-similar' });
      retrySet.add(cand.phaseId);
    }
  }

  for (let i = 0; i < sortedAgents.length; i++) {
    for (let j = i + 1; j < sortedAgents.length; j++) {
      const a = sortedAgents[i], b = sortedAgents[j];
      if (retrySet.has(b.phaseId) || a.description !== b.description) continue;
      if (new Date(b.startTs).getTime() - new Date(a.startTs).getTime() > 5 * 60 * 1000) continue;
      retries.push({ ts: b.startTs, triggeredByErrorTs: null, phaseId: b.phaseId,
        description: b.description, matchMethod: 'duplicate-description-5min' });
      retrySet.add(b.phaseId);
    }
  }

  return retries.sort((a, b) => a.ts.localeCompare(b.ts));
}
```

Dans `aggregateSession`, après le calcul de `hooks` :

```javascript
const errors = detectErrors(events, phases, hooks);
const retries = detectRetries(phases, errors);
for (const p of phases) {
  p.errorsCount = errors.filter((e) => e.phaseId === p.phaseId).length;
  p.retriesCount = retries.filter((r) => r.phaseId === p.phaseId).length;
}
for (const t of teams.values()) {
  t.errorsCount = errors.filter((e) => e.teamName === t.team_name).length;
}
summary.errorsCount = errors.length;
summary.retriesCount = retries.length;
```

Et inclure `errors, retries` dans l'objet retourné.

- [ ] **Step 4: Run, PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): detect errors (4 sources) and retries (3 heuristics)"
```

---

## Task 8: HTTP endpoint `/api/stats`

**Files:** Modify `chat-service/server.js`, create `chat-service/test/api-stats.test.js`

- [ ] **Step 1: Ajouter la map `sessionLogs` et l'envoi de `session_meta`**

En haut de `server.js` (après les imports) :

```javascript
const sessionLogs = new Map();
```

Dans `processMessage`, remplacer la ligne `if (event.session_id) state.sessionId = event.session_id;` par :

```javascript
if (event.session_id) {
  state.sessionId = event.session_id;
  if (state.log?.path && !sessionLogs.has(event.session_id)) {
    sessionLogs.set(event.session_id, state.log.path);
  }
  if (!state.sessionMetaSent) {
    safeSend(ws, { type: 'session_meta', sessionId: event.session_id });
    state.sessionMetaSent = true;
  }
}
```

Dans le handler `ws.on('close', ...)`:

```javascript
ws.on('close', () => {
  const s = connections.get(ws);
  if (s?.sessionId) sessionLogs.delete(s.sessionId);
  s?.log?.close();
  connections.delete(ws);
});
```

- [ ] **Step 2: Ajouter le route handler**

Juste avant `const httpServer = createServer(...)`, ajouter :

```javascript
const HOOKS_LOG_PATH = `${LOG_DIR}/hooks.log`;

async function handleStatsRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) { res.writeHead(204); res.end(); return; }
  const logPath = sessionLogs.get(sessionId);
  if (!logPath) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'session_log_not_found' }));
    return;
  }
  try {
    const { aggregateSession } = await import('./lib/stats.js');
    const out = await aggregateSession({ sessionLogPath: logPath, hooksLogPath: HOOKS_LOG_PATH, sessionId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (err) {
    console.error('aggregateSession failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'aggregate_failed', message: err.message }));
  }
}
```

Et dans `createServer`, en tout premier dans le handler :

```javascript
if (req.url?.startsWith('/api/stats')) return handleStatsRequest(req, res);
```

- [ ] **Step 3: Test d'intégration minimal**

Créer `chat-service/test/api-stats.test.js` :

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('aggregateSession integration: parallel fixture produces shaped output', async () => {
  const { aggregateSession } = await import('../lib/stats.js');
  const out = await aggregateSession({
    sessionLogPath: join(__dirname, 'fixtures', 'parallel-two-teams.jsonl'),
    hooksLogPath: join(__dirname, 'fixtures', 'hooks.log.parallel-teams'),
    sessionId: 'integration-test',
  });
  assert.ok(out.summary);
  assert.ok(out.phases.length > 0);
  assert.equal(out.teams.length, 2);
  assert.ok(Array.isArray(out.topAgents));
  assert.ok(Array.isArray(out.topToolCalls));
  assert.ok(Array.isArray(out.hooks));
  assert.ok(Array.isArray(out.errors));
  assert.ok(Array.isArray(out.retries));
});
```

- [ ] **Step 4: Run, PASS**

Run: `cd chat-service && npm test`

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): expose /api/stats endpoint with sessionId lookup"
```

---

## Task 9: UI — bouton stats + state + session_meta

**Files:** Modify `chat-service/public/index.html`, `chat-service/public/chat.js`, `chat-service/public/chat.css`

- [ ] **Step 1: HTML**

Dans `chat-service/public/index.html`, remplacer les 4 boutons du header par :

```html
      <button id="chat-stats-btn" hidden title="Session stats" aria-label="Show session statistics">📊</button>
      <button id="chat-debug" title="Debug OFF" aria-label="Toggle debug">🔍</button>
      <button id="chat-expand" title="Expand" aria-label="Expand chat">⤢</button>
      <button id="chat-toggle" aria-label="Toggle chat">✕</button>
```

Et ajouter juste après `<div id="chat-messages"></div>` :

```html
    <div id="chat-stats-panel" hidden></div>
```

- [ ] **Step 2: CSS**

Ajouter à la fin de `chat.css` :

```css
#chat-stats-btn {
  background: none; border: none; color: #636366;
  cursor: pointer; font-size: 14px; padding: 2px 4px;
  transition: color .15s, opacity .15s; border-radius: 6px;
}
#chat-stats-btn:hover:not(:disabled) { color: #fff; }
#chat-stats-btn:disabled { opacity: .35; cursor: not-allowed; }

#chat-widget.chat-stats-mode #chat-messages,
#chat-widget.chat-stats-mode #chat-form,
#chat-widget.chat-stats-mode #chat-debug { display: none; }

#chat-stats-panel {
  flex: 1; overflow-y: auto; padding: 16px;
  font-size: 13px; color: #f2f2f7;
}
#chat-stats-panel::-webkit-scrollbar { width: 4px; }
#chat-stats-panel::-webkit-scrollbar-thumb { background: #3a3a3c; border-radius: 2px; }

.stats-loading { padding: 24px; text-align: center; color: #8e8e93; }
.stats-error {
  padding: 16px; color: #f87171;
  background: rgba(248,113,113,.08); border-radius: 10px;
}
.stats-error button {
  margin-top: 8px; margin-right: 8px;
  background: #2c2c2e; border: 1px solid #3a3a3c; color: #f2f2f7;
  padding: 6px 12px; border-radius: 8px; cursor: pointer;
}
```

- [ ] **Step 3: JS — state + session_meta**

Dans `chat.js`, ajouter avec les autres consts DOM :

```javascript
const statsBtn = document.getElementById('chat-stats-btn');
const statsPanel = document.getElementById('chat-stats-panel');
```

Après `let debugMode = false;` :

```javascript
let hasUserMessage = false;
let currentSessionId = null;
let statsMode = false;

function updateStatsBtnVisibility() {
  if (!hasUserMessage) { statsBtn.hidden = true; return; }
  statsBtn.hidden = false;
  statsBtn.disabled = working;
}
```

Dans `ws.onmessage`, ajouter en début (avant le check `msg.type === 'status'`) :

```javascript
  if (msg.type === 'session_meta') {
    currentSessionId = msg.sessionId;
    return;
  }
```

À la fin du bloc `if (msg.type === 'status')`, juste avant le `return`, ajouter `updateStatsBtnVisibility();`.

Dans le callback `form.addEventListener('submit', ...)`, après `appendMessage('user', content);` ajouter :

```javascript
  hasUserMessage = true;
  updateStatsBtnVisibility();
```

Dans le callback `btn.addEventListener('click', ...)` de `appendChoices`, après `ws.send(JSON.stringify({ content: id }));` ajouter :

```javascript
    hasUserMessage = true;
    updateStatsBtnVisibility();
```

- [ ] **Step 4: Smoke test manuel**

Ouvrir `http://localhost:8080`. Avant toute interaction : pas de bouton 📊. Cliquer `QUICK_EDIT` : le bouton 📊 apparaît, grisé pendant le spinner, actif ensuite. Il ne fait rien au clic pour l'instant (wiring Task 10).

- [ ] **Step 5: Commit**

```bash
git add chat-service/public/
git commit -m "feat(stats): add stats button with idle/working state"
```

---

## Task 10: UI — bascule + fetch + helper `el()`

**Files:** Modify `chat-service/public/chat.js`

- [ ] **Step 1: Ajouter le helper `el` en haut du fichier**

Après les consts DOM et juste avant `function formatTokens` :

```javascript
function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'className') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'dataset' && typeof v === 'object') for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return e;
}
```

- [ ] **Step 2: Bascule mode stats + fetch**

Ajouter après `updateStatsBtnVisibility` :

```javascript
async function enterStatsMode() {
  if (!currentSessionId) return;
  statsMode = true;
  widget.classList.add('chat-stats-mode');
  statsPanel.hidden = false;
  statsBtn.textContent = '←';
  statsBtn.title = 'Back to chat';

  statsPanel.replaceChildren(el('div', { className: 'stats-loading' }, 'Loading stats…'));
  try {
    const res = await fetch(`/api/stats?sessionId=${encodeURIComponent(currentSessionId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderStatsPanel(data);
  } catch (err) {
    const retry = el('button', { id: 'stats-retry-btn', onclick: enterStatsMode }, 'Retry');
    const back  = el('button', { id: 'stats-back-btn',  onclick: exitStatsMode  }, '← Back to chat');
    const label = el('div', null, el('strong', null, 'Failed to load stats:'), ' ', String(err.message));
    statsPanel.replaceChildren(el('div', { className: 'stats-error' }, label, retry, back));
  }
}

function exitStatsMode() {
  statsMode = false;
  widget.classList.remove('chat-stats-mode');
  statsPanel.hidden = true;
  statsPanel.replaceChildren();
  statsBtn.textContent = '📊';
  statsBtn.title = 'Session stats';
}

statsBtn.addEventListener('click', () => {
  if (statsMode) exitStatsMode(); else enterStatsMode();
});

// Placeholder until Tasks 11-15 fill in the sections
function renderStatsPanel(data) {
  const pre = el('pre', { style: { fontSize: '11px', color: '#636366', overflow: 'auto' } });
  pre.textContent = JSON.stringify(data, null, 2);
  statsPanel.replaceChildren(pre);
}
```

- [ ] **Step 3: Smoke test**

Cliquer 📊 → le panel s'affiche avec le JSON brut (placeholder). Cliquer ← → retour au chat.

- [ ] **Step 4: Commit**

```bash
git commit -am "feat(stats): wire stats mode toggle with fetch + loading/error UI"
```

---

## Task 11: UI — Section Header résumé

**Files:** Modify `chat-service/public/chat.js`, `chat-service/public/chat.css`

- [ ] **Step 1: Helper `formatDuration` près de `formatTokens`**

```javascript
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}
```

- [ ] **Step 2: Remplacer `renderStatsPanel`**

```javascript
function renderStatsPanel(data) {
  statsPanel.replaceChildren(renderSummarySection(data));
}

function renderSummarySection(data) {
  const kpi = el('div', { className: 'stats-kpi-line' },
    el('span', null, `⏱️ ${formatDuration(data.summary.totalMs)} total`),
    el('span', null, `🤖 ${data.summary.agentsCount} agents`),
    el('span', null, `🔧 ${data.summary.opsCount} ops`),
    el('span', null, `🪙 ${formatTokens(data.summary.tokensTotal)} tokens`),
    el('span', null, `💵 $${data.summary.costUsd.toFixed(3)}`),
    el('span', { className: 'kpi-warn' }, `⚠️ ${data.summary.errorsCount} erreurs`),
    el('span', { className: 'kpi-warn' }, `🔁 ${data.summary.retriesCount} retries`),
  );

  const teamRow = data.teams.length
    ? el('div', { className: 'stats-team-row' },
        ...data.teams.map((t) => {
          const pill = el('span', { className: 'stats-team-pill', style: { borderColor: t.color, color: t.color } });
          pill.textContent = `👥 ${t.team_name.replace(/^ticket-/, '')} · ${formatDuration(t.durationMs)} · ${t.agentsCount} agents${t.errorsCount ? ' · ⚠️ ' + t.errorsCount : ''}`;
          return pill;
        }))
    : null;

  const totalMs = data.summary.totalMs || 1;
  const breakdown = el('div', { className: 'stats-breakdown' },
    ...data.summary.timeBreakdown.map((row) => {
      const pct = Math.max(2, Math.round((row.ms / totalMs) * 100));
      const seg = el('span', {
        className: 'stats-breakdown-seg',
        style: { flex: String(pct) },
        title: `${row.agent} · ${formatDuration(row.ms)} (${pct}%)`,
      });
      seg.textContent = pct > 8 ? `${row.agent} ${formatDuration(row.ms)}` : '';
      return seg;
    }));

  return el('section', { className: 'stats-section stats-summary' }, kpi, teamRow, breakdown);
}
```

- [ ] **Step 3: CSS**

Ajouter à `chat.css` :

```css
.stats-section { margin-bottom: 20px; }
.stats-kpi-line {
  display: flex; flex-wrap: wrap; gap: 12px;
  font-size: 12px; color: #d1d5db;
  padding: 10px 12px; background: #2c2c2e; border-radius: 10px;
  font-variant-numeric: tabular-nums;
}
.stats-kpi-line .kpi-warn { color: #f59e0b; }

.stats-team-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.stats-team-pill {
  border: 1px solid; padding: 4px 10px; border-radius: 999px;
  font-size: 11px; font-weight: 500;
}

.stats-breakdown {
  display: flex; margin-top: 12px; height: 22px;
  border-radius: 6px; overflow: hidden; background: #2c2c2e;
}
.stats-breakdown-seg {
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: #1c1c1e; font-weight: 600;
  background: #3b82f6; border-right: 1px solid #1c1c1e;
  white-space: nowrap; overflow: hidden;
}
.stats-breakdown-seg:nth-child(2n) { background: #8b5cf6; }
.stats-breakdown-seg:nth-child(3n) { background: #f97316; }
.stats-breakdown-seg:nth-child(4n) { background: #10b981; }
.stats-breakdown-seg:nth-child(5n) { background: #f59e0b; }
```

- [ ] **Step 4: Smoke test manuel**

Après conversation, le header affiche les KPIs + pastilles team + mini-barre.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): render summary section (KPIs, teams, time breakdown)"
```

---

## Task 12: UI — Chronologie 2 niveaux

**Files:** Modify `chat-service/public/chat.js`, `chat-service/public/chat.css`

- [ ] **Step 1: Dans `renderStatsPanel`, chaîner la section chronologie**

```javascript
function renderStatsPanel(data) {
  statsPanel.replaceChildren(
    renderSummarySection(data),
    renderChronologySection(data),
  );
}
```

- [ ] **Step 2: Fonction de rendu**

```javascript
function relLabelFactory(baseTs) {
  const base = baseTs ? new Date(baseTs).getTime() : 0;
  return (ts) => {
    const d = new Date(ts).getTime() - base;
    const m = Math.floor(d / 60000);
    const s = Math.floor((d % 60000) / 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
}

const TOOL_ICON = { Read: '📖', Write: '✏️', Edit: '✏️', Bash: '⚡', Grep: '🔍', Glob: '🔍' };

function toolIcon(name) { return TOOL_ICON[name] || '🔧'; }

function renderChronologySection(data) {
  const relLabel = relLabelFactory(data.startTs);
  const teamColor = (name) => data.teams.find((t) => t.team_name === name)?.color || '#64748b';

  const rows = data.phases.map((phase) => renderPhaseRow(phase, relLabel, teamColor));
  return el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Chronologie'),
    ...rows,
  );
}

function renderPhaseRow(phase, relLabel, teamColor) {
  const det = el('details', { className: 'phase-row' });
  const dot = phase.kind === 'orchestrator' ? '🎭' : '🤖';

  const teamBadge = phase.teamName
    ? el('span', { className: 'phase-team', style: { color: teamColor(phase.teamName), borderColor: teamColor(phase.teamName) } },
        `👥 ${phase.teamName.replace(/^ticket-/, '')}`)
    : (phase.kind === 'agent' ? el('span', { className: 'phase-team muted' }, '🎭 hors équipe') : null);

  const warn  = phase.errorsCount  ? el('span', { className: 'phase-warn' }, `⚠️ ${phase.errorsCount}`)  : null;
  const retry = phase.retriesCount ? el('span', { className: 'phase-warn' }, `🔁 ${phase.retriesCount}`) : null;

  det.appendChild(el('summary', null,
    el('span', { className: 'phase-time' }, relLabel(phase.startTs)),
    el('span', { className: 'phase-icon' }, dot),
    el('span', { className: 'phase-name' }, phase.agentType || phase.kind),
    el('span', { className: 'phase-desc' }, phase.description),
    el('span', { className: 'phase-stats' },
      `${formatDuration(phase.durationMs)} · ${phase.opsCount} ops · ${formatTokens(phase.tokensTotal || 0)} tok`),
    warn, retry, teamBadge,
  ));

  if (phase.children.length === 0) {
    det.appendChild(el('div', { className: 'phase-empty' }, '(no sub-events)'));
  } else {
    const list = el('div', { className: 'phase-children' });
    for (const c of phase.children) list.appendChild(renderChildRow(c, relLabel));
    det.appendChild(list);
  }
  return det;
}

function renderChildRow(child, relLabel) {
  let icon = '🔧', label = child.kind, detail = '';
  if (child.kind === 'tool_use') { icon = toolIcon(child.tool); label = child.tool; detail = child.detail ?? ''; }
  else if (child.kind === 'skill') { icon = '🧠'; label = 'Skill'; detail = child.skill; }
  else if (child.kind === 'hook') { icon = '🪝'; label = child.hookName; detail = `${child.worktree || ''} ${child.result || ''}`.trim(); }

  const dur = child.kind === 'hook'
    ? formatDuration(child.durationMs)
    : (child.isApprox ? `~${formatDuration(child.approxDurationMs)}` : formatDuration(child.approxDurationMs));

  const detailSpan = el('span', { className: 'child-detail', title: String(detail) });
  detailSpan.textContent = String(detail);

  return el('div', { className: `child-row child-${child.kind}` },
    el('span', { className: 'child-time' }, relLabel(child.ts || child.startTs)),
    el('span', { className: 'child-icon' }, icon),
    el('span', { className: 'child-label' }, label),
    detailSpan,
    el('span', { className: 'child-dur' }, dur),
  );
}
```

- [ ] **Step 3: CSS**

```css
.stats-section-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #d1d5db; }

.phase-row { margin-bottom: 4px; border-radius: 8px; background: #2c2c2e; }
.phase-row summary {
  list-style: none; padding: 8px 10px;
  display: grid; grid-template-columns: auto auto auto 1fr auto auto auto auto;
  gap: 8px; align-items: center; font-size: 12px; cursor: pointer;
}
.phase-row summary::before { content: '▸'; font-size: 9px; opacity: .5; }
.phase-row[open] summary::before { content: '▾'; }
.phase-time { font-variant-numeric: tabular-nums; color: #8e8e93; font-size: 11px; }
.phase-icon { font-size: 13px; }
.phase-name { font-weight: 600; color: #f2f2f7; }
.phase-desc { color: #8e8e93; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.phase-stats { color: #8e8e93; font-size: 11px; font-variant-numeric: tabular-nums; }
.phase-warn { color: #f59e0b; font-size: 11px; }
.phase-team { border: 1px solid; padding: 1px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; }
.phase-team.muted { color: #636366; border-color: #3a3a3c; }

.phase-children { padding: 6px 10px 10px 30px; border-top: 1px solid #3a3a3c; }
.phase-empty { padding: 6px 10px 10px 30px; color: #636366; font-size: 11px; font-style: italic; }
.child-row {
  display: grid; grid-template-columns: auto auto auto 1fr auto;
  gap: 8px; font-size: 11px; padding: 3px 0; align-items: center;
}
.child-time { color: #636366; font-variant-numeric: tabular-nums; }
.child-label { color: #f2f2f7; font-weight: 500; }
.child-detail { color: #8e8e93; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.child-dur { color: #636366; font-variant-numeric: tabular-nums; }
.child-hook .child-label { color: #a78bfa; }
.child-skill .child-label { color: #34d399; }
```

- [ ] **Step 4: Smoke test**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): render 2-level chronology with expandable phases"
```

---

## Task 13: UI — Top opérations

**Files:** Modify `chat-service/public/chat.js`, `chat-service/public/chat.css`

- [ ] **Step 1: Chaîner dans `renderStatsPanel`**

```javascript
function renderStatsPanel(data) {
  statsPanel.replaceChildren(
    renderSummarySection(data),
    renderChronologySection(data),
    renderTopOpsSection(data),
  );
}
```

- [ ] **Step 2: Rendu**

```javascript
function renderTopOpsSection(data) {
  const grid = el('div', { className: 'stats-top-grid' },
    buildTopList('Agents les plus longs', data.topAgents, (a) => ({
      main: a.label,
      meta: a.teamName ? `👥 ${a.teamName.replace(/^ticket-/,'')}` : '',
      value: formatDuration(a.durationMs),
    })),
    buildTopList('Tool calls les plus longs', data.topToolCalls, (c) => ({
      main: `${toolIcon(c.tool)} ${c.tool}`,
      meta: c.detail ?? '',
      value: `${c.isApprox ? '~' : ''}${formatDuration(c.durationMs)}`,
      slow: !!c.flaggedSlow,
    })),
    buildTopList('Outils les plus utilisés', data.toolCounts.slice(0, 5), (t) => ({
      main: `${toolIcon(t.tool)} ${t.tool}`,
      meta: `${formatDuration(t.totalDurationMs)} total`,
      value: `${t.count} calls`,
    })),
  );
  return el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Top opérations'),
    grid,
  );
}

function buildTopList(title, items, fmt) {
  const col = el('div', { className: 'stats-top-col' },
    el('h4', null, title),
  );
  if (!items.length) {
    col.appendChild(el('ol', { className: 'stats-top-list' }, el('li', { className: 'top-empty' }, '—')));
    return col;
  }
  const list = el('ol', { className: 'stats-top-list' });
  for (const it of items) {
    const f = fmt(it);
    const li = el('li', f.slow ? { className: 'slow' } : null,
      el('div', { className: 'top-main' }, f.main),
      el('div', { className: 'top-meta' }, f.meta),
      el('div', { className: 'top-value' }, f.value),
    );
    list.appendChild(li);
  }
  col.appendChild(list);
  return col;
}
```

- [ ] **Step 3: CSS**

```css
.stats-top-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.stats-top-col { background: #2c2c2e; border-radius: 10px; padding: 10px 12px; }
.stats-top-col h4 {
  font-size: 11px; font-weight: 600; color: #8e8e93;
  margin-bottom: 6px; text-transform: uppercase; letter-spacing: .04em;
}
.stats-top-list { list-style: decimal inside; padding: 0; margin: 0; }
.stats-top-list li { padding: 4px 0; font-size: 11px; border-bottom: 1px solid #3a3a3c; }
.stats-top-list li:last-child { border-bottom: none; }
.stats-top-list li.slow .top-value { color: #f59e0b; font-weight: 600; }
.top-main { color: #f2f2f7; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top-meta { color: #636366; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top-value { color: #8e8e93; font-variant-numeric: tabular-nums; }
.top-empty { color: #636366; font-style: italic; list-style: none; }
```

- [ ] **Step 4: Smoke test**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): render top operations leaderboards"
```

---

## Task 14: UI — Skills / Hooks / Rules

**Files:** Modify `chat-service/public/chat.js`, `chat-service/public/chat.css`

- [ ] **Step 1: Chaîner**

```javascript
function renderStatsPanel(data) {
  statsPanel.replaceChildren(
    renderSummarySection(data),
    renderChronologySection(data),
    renderTopOpsSection(data),
    renderSkillsHooksRulesSection(data),
  );
}
```

- [ ] **Step 2: Rendu**

```javascript
function renderSkillsHooksRulesSection(data) {
  const skillsList = buildSubList('Skills invoquées', data.skills, (s) => ({
    main: `🧠 ${s.skill}`, count: `${s.count} calls`, meta: `~${formatDuration(s.totalDurationMs)}`,
  }));

  const hooksList = buildSubList('Hooks déclenchés', data.hooks, (h) => {
    const metaEl = el('span', null,
      el('span', { className: 'sub-ok' }, `✓ ${h.okCount}`), ' ',
      el('span', { className: 'sub-fail' }, `✗ ${h.failCount}`),
    );
    if (h.skipCount) { metaEl.appendChild(document.createTextNode(' ')); metaEl.appendChild(el('span', { className: 'sub-skip' }, `SKIP ${h.skipCount}`)); }
    if (h.blocking)  { metaEl.appendChild(document.createTextNode(' ')); metaEl.appendChild(el('span', { className: 'sub-blocking' }, 'blocking')); }
    return { main: `🪝 ${h.hookName}`, count: `${h.runs} runs`, metaEl: el('span', null, `${formatDuration(h.totalDurationMs)} · `, metaEl) };
  });

  const rulesList = buildSubList('Rules référencées', data.rules, (r) => ({
    main: `📜 ${r.ruleFile}`, count: `${r.reads} reads`, meta: r.readers.map((x) => `${x.agentType}×${x.count}`).join(', '),
  }));

  const note = el('div', { className: 'stats-note' },
    'Détection des rules basée sur les lectures de .claude/rules/*.md ; un agent peut appliquer une rule sans la relire.');

  return el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Skills · Hooks · Rules'),
    skillsList, hooksList, rulesList, note,
  );
}

function buildSubList(title, items, rowFn) {
  const col = el('div', { className: 'stats-sub' }, el('h4', null, title));
  if (!items.length) { col.appendChild(el('div', { className: 'sub-empty' }, '—')); return col; }
  for (const it of items) {
    const r = rowFn(it);
    const main = el('span', { className: 'sub-main' }, r.main);
    const count = el('span', { className: 'sub-count' }, r.count);
    const meta = r.metaEl ? r.metaEl : el('span', { className: 'sub-meta' }, r.meta ?? '');
    meta.classList.add('sub-meta');
    col.appendChild(el('div', { className: 'sub-row' }, main, count, meta));
  }
  return col;
}
```

- [ ] **Step 3: CSS**

```css
.stats-sub { margin-bottom: 16px; }
.stats-sub h4 {
  font-size: 11px; font-weight: 600; color: #8e8e93;
  margin-bottom: 6px; text-transform: uppercase; letter-spacing: .04em;
}
.sub-row {
  display: grid; grid-template-columns: 1fr auto auto;
  gap: 10px; padding: 4px 0; font-size: 11px; align-items: center;
  border-bottom: 1px solid #2c2c2e;
}
.sub-main { color: #f2f2f7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-count { color: #8e8e93; font-variant-numeric: tabular-nums; font-size: 10px; }
.sub-meta { color: #636366; font-size: 10px; font-variant-numeric: tabular-nums; }
.sub-ok { color: #34d399; }
.sub-fail { color: #f87171; }
.sub-skip { color: #8e8e93; }
.sub-blocking { color: #a78bfa; font-style: italic; }
.sub-empty { color: #636366; font-style: italic; font-size: 11px; padding: 4px 0; }
.stats-note { font-size: 10px; color: #636366; font-style: italic; margin-top: 8px; }
```

- [ ] **Step 4: Smoke test**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): render skills/hooks/rules aggregated section"
```

---

## Task 15: UI — Erreurs & retries

**Files:** Modify `chat-service/public/chat.js`, `chat-service/public/chat.css`

- [ ] **Step 1: Chaîner**

```javascript
function renderStatsPanel(data) {
  statsPanel.replaceChildren(
    renderSummarySection(data),
    renderChronologySection(data),
    renderTopOpsSection(data),
    renderSkillsHooksRulesSection(data),
    renderErrorsRetriesSection(data),
  );
}
```

- [ ] **Step 2: Rendu**

```javascript
function renderErrorsRetriesSection(data) {
  const merged = [
    ...data.errors.map((e) => ({ ...e, _kind: 'error' })),
    ...data.retries.map((r) => ({ ...r, _kind: 'retry', summary: `Retry: ${r.description}` })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  const section = el('section', { className: 'stats-section' },
    el('h3', { className: 'stats-section-title' }, 'Erreurs & retries'));

  if (!merged.length) {
    section.appendChild(el('div', { className: 'sub-empty' }, 'Aucune erreur ni retry dans cette session 🎉'));
    return section;
  }

  for (const it of merged) {
    const det = el('details', { className: `err-row err-${it._kind}` });
    const icon = it._kind === 'retry' ? '🔁' : (it.kind === 'hook_failed' ? '🪝' : '❌');
    const t = new Date(it.ts).toISOString().slice(11, 19);

    const summary = el('summary', null,
      el('span', { className: 'err-time' }, t),
      el('span', { className: 'err-icon' }, icon),
      el('span', { className: 'err-summary' }, it.summary),
      it.teamName ? el('span', { className: 'err-meta' }, `👥 ${it.teamName.replace(/^ticket-/,'')}`) : null,
      it._kind === 'retry' ? el('span', { className: 'err-meta muted' }, `via ${it.matchMethod}`) : null,
    );
    det.appendChild(summary);

    const body = el('pre', { className: 'err-payload' });
    body.textContent = typeof it.payload === 'string' ? it.payload : JSON.stringify(it.payload, null, 2);
    det.appendChild(body);

    section.appendChild(det);
  }
  return section;
}
```

- [ ] **Step 3: CSS**

```css
.err-row { margin-bottom: 4px; border-radius: 8px; background: #2c2c2e; }
.err-row summary {
  list-style: none; padding: 6px 10px;
  display: grid; grid-template-columns: auto auto 1fr auto auto;
  gap: 8px; align-items: center; font-size: 12px; cursor: pointer;
}
.err-row summary::before { content: '▸'; font-size: 9px; opacity: .5; }
.err-row[open] summary::before { content: '▾'; }
.err-time { color: #636366; font-variant-numeric: tabular-nums; font-size: 11px; }
.err-summary { color: #f2f2f7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.err-meta { color: #8e8e93; font-size: 10px; }
.err-meta.muted { color: #636366; }
.err-error .err-icon { color: #f87171; }
.err-retry .err-icon { color: #f59e0b; }
.err-payload {
  padding: 8px 12px; margin: 0;
  background: #1c1c1e; font-size: 10px; color: #8e8e93;
  overflow-x: auto; max-height: 240px; overflow-y: auto;
  border-top: 1px solid #3a3a3c;
}
```

- [ ] **Step 4: Smoke test**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(stats): render errors and retries section with expandable payloads"
```

---

## Task 16: Validation manuelle end-to-end

**Files:** aucune modif de code, juste CHANGELOG

- [ ] **Step 1: Redémarrer le service si nécessaire**

```bash
docker exec atomic-crm-demo supervisorctl restart chat-service
```

- [ ] **Step 2: Scénario 1 — session heureuse courte**

Ouvrir `http://localhost:8080`. Cliquer `QUICK_EDIT`, demander un rename simple. Attendre l'idle. Cliquer 📊. Vérifier :
- Le bouton était invisible avant le 1er message
- Il est grisé pendant le spinner
- Il est cliquable en idle
- Le panel s'ouvre et contient les 5 sections
- Le bouton ← revient au chat
- Le message « Aucune erreur ni retry » s'affiche

- [ ] **Step 3: Scénario 2 — session parallèle complète**

Déclencher un test parallèle classique (2 tickets en parallèle via `FULL_SETUP` ou un prompt explicite). Après la fin complète, cliquer 📊. Vérifier :
- Header : 2 pastilles team avec couleurs différentes
- Chronologie : entrelacement correct des agents des 2 teams, badges team corrects, phases dépliables avec children
- Top agents : tri par durée desc
- Top tool calls : au moins 1 entrée `flaggedSlow` (surlignée)
- Skills : au moins 1 skill `superpowers:*`
- Hooks : typecheck, unit-fn, etc. avec compteurs ok/fail
- Rules : `agent-output-format.md` présent
- Erreurs/retries : entrée Merge TASK-XXX (retry) visible, dépliable avec payload

- [ ] **Step 4: Scénario 3 — erreur de fetch**

Dans un autre terminal :

```bash
docker exec atomic-crm-demo supervisorctl stop chat-service
```

Dans le panel toujours ouvert, cliquer ← puis 📊 : l'UI d'erreur doit apparaître avec les boutons Retry / ← Back to chat fonctionnels. Redémarrer :

```bash
docker exec atomic-crm-demo supervisorctl start chat-service
```

Cliquer Retry → panel charge correctement.

- [ ] **Step 5: CHANGELOG + commit de closure**

Ajouter à `CHANGELOG.md`, en haut, une nouvelle section (numéro de phase à déterminer selon l'état du fichier au moment de l'implémentation) :

```markdown
## Phase 28 — Session stats panel

Nouveau bouton 📊 dans le header du chat widget, disponible en idle après la
première question, qui bascule sur un panel de statistiques par session lu
depuis le JSONL de session et `hooks.log`. Cinq sections : résumé (KPIs, pastilles
team, répartition temporelle), chronologie 2 niveaux (agents → tool calls / skills /
hooks), top opérations (agents, tool calls, outils), skills/hooks/rules agrégés,
erreurs/retries avec payload tail.

Spec: [docs/superpowers/specs/2026-04-23-session-stats-panel-design.md](docs/superpowers/specs/2026-04-23-session-stats-panel-design.md)
Plan: [docs/superpowers/plans/2026-04-23-session-stats-panel.md](docs/superpowers/plans/2026-04-23-session-stats-panel.md)
```

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for session stats panel (Phase 28)"
```

---

## Notes d'implémentation transverses

- **Aucune dépendance npm nouvelle** — builtins node + vanilla browser JS.
- **ES modules** : `"type": "module"` dans package.json — `import/export` partout.
- **Tests** : `node --test test/`. Ne pas oublier le changement de script en Task 1 Step 10.
- **Bind-mounts Docker** : vérifier au début de Task 9 que `chat-service/public/`, `chat-service/server.js`, et **`chat-service/lib/`** (nouveau dossier) sont accessibles au container live — sinon rebuild ou ajuster `docker-compose.yml`.
- **Taille de chat.js** : le fichier passe d'environ 425 à environ 700 lignes. Reste gérable. Split en `stats-render.js` si ça dépasse 1000 lignes — pas avant.
- **Sécurité DOM** : construction exclusive via `el()` (créé en Task 10) + `textContent`. Aucune assignation de HTML dynamique. Les descriptions d'agent contiennent du texte dérivé du prompt utilisateur et sont donc potentiellement attaquables — le choix `textContent` les neutralise.
- **Pas de test UI automatisé** : validation manuelle en Task 16. Playwright envisagé en v2 seulement si régression observée.
