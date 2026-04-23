# Session Stats Panel — Design

**Date:** 2026-04-23
**Status:** approved, ready for implementation plan
**Scope:** chat-service (server + public UI)

---

## Goal

Donner à l'utilisateur un panel de statistiques par session de chat, consultable en mode idle après la première question, pour diagnostiquer la fiabilité et la rapidité des opérations (agents dispatchés, skills, hooks, rules, tool calls, erreurs, retries).

## Non-goals

- Agréger des données **cross-session** (historique, tendances).
- Corréler avec `git log`, `docs/tickets/*.json`, ou d'autres sources externes (futur, pas maintenant).
- Recalcul en live pendant qu'une session travaille — la consultation est strictement post-mortem par construction (bouton désactivé en `working`).
- Persister le mode stats à la fermeture du widget.

## Architecture

### Flux

1. L'utilisateur clique le bouton 📊 (idle, après ≥ 1 message envoyé).
2. Le client fetch `GET /api/stats?sessionId=<current>`.
3. Le serveur lit `/chat-service/logs/session-<ts>.jsonl` en streaming ligne par ligne, plus les lignes de `/chat-service/logs/hooks.log` qui tombent dans la fenêtre `[session_start_ts, session_end_or_now]`, et agrège.
4. Le serveur renvoie un JSON structuré. Le client rend le panel en vanilla JS (cohérent avec le `chat.js` existant).

Pas de cache au premier jet : re-parse à chaque clic. Coût mesuré acceptable (<1s pour un JSONL de 5MB localement). Cache sessionId-indexé prévu en v2 **si** mesuré nécessaire.

### Découpage du code

- `chat-service/lib/stats.js` — tout le parsing + agrégation. Exporte une fonction pure `aggregateSession({ sessionLogPath, hooksLogPath, sessionStartTs, sessionEndTs }) → aggregatedJson`. Pas de dépendance HTTP, testable à la fixture.
- `chat-service/server.js` — nouveau handler `GET /api/stats` qui résout le chemin du log à partir du `sessionId` de la connexion WS active (ou d'un paramètre query) et appelle `aggregateSession`.
- `chat-service/public/chat.js` — extension : bouton header, state `hasUserMessage`, bascule mode stats, rendu du panel.
- `chat-service/public/chat.css` — styles pour le bouton, la classe `chat-stats-mode`, le panel et ses sections.
- `chat-service/public/index.html` — ajout du bouton `#chat-stats-btn` à côté de `#chat-debug`, et d'un `<div id="chat-stats-panel">` masqué par défaut.

Isolation :
- `stats.js` n'importe rien du serveur HTTP ni du WS. Il reçoit des chemins de fichiers et des bornes temporelles, retourne un objet.
- Le client ne parse jamais le JSONL brut — il ne reçoit que le JSON agrégé.

## UI

### Bouton 📊

- Placé dans le header, **à gauche de la loupe** (`#chat-debug`).
- Icône : 📊
- Invisible tant que l'utilisateur n'a pas envoyé au moins un message (`hasUserMessage === false`).
- Grisé + `disabled` quand `working === true` (style `opacity: 0.4; cursor: not-allowed`).
- Actif (couleur normale, hover) quand idle et `hasUserMessage === true`.

### Bascule vers le panel

Au clic, ajoute la classe `chat-stats-mode` sur `#chat-widget`. CSS :
- `#chat-messages` et `#chat-form` : `display: none`
- `#chat-stats-panel` : `display: block`
- Header : le bouton 📊 devient « ← Retour » (même élément, texte/icône swap), le bouton 🔍 (debug) est masqué tant qu'on est en mode stats
- Bouton expand (⤢) reste actif pour élargir le widget
- Bouton fermer (✕) ferme le widget entièrement ; à la réouverture on est en mode chat

Au clic sur « ← Retour » : enlève la classe `chat-stats-mode`, vide le DOM de `#chat-stats-panel` (stateless entre 2 ouvertures — toujours un fetch frais).

### Fetch + loading

Pendant le fetch : spinner centré dans `#chat-stats-panel`. En cas d'échec : message d'erreur avec boutons « Retry » et « ← Retour au chat ».

## Shape du JSON agrégé (contract entre serveur et client)

```json
{
  "sessionId": "<uuid>",
  "logPath": "/chat-service/logs/session-...jsonl",
  "startTs": "2026-04-23T09:38:50.907Z",
  "endTs": "2026-04-23T10:10:10.770Z",
  "durationMs": 1880000,
  "summary": {
    "totalMs": 1880000,
    "agentsCount": 12,
    "opsCount": 342,
    "tokensTotal": 287000,
    "costUsd": 1.42,
    "errorsCount": 3,
    "retriesCount": 2,
    "timeBreakdown": [
      { "agent": "orchestrator", "ms": 240000 },
      { "agent": "planner",      "ms": 120000 },
      { "agent": "developer",    "ms": 720000 }
    ]
  },
  "teams": [
    {
      "team_name": "ticket-TASK-003",
      "description": "Badge 'new' sur les contacts récents",
      "color": "#3b82f6",
      "durationMs": 1140000,
      "agentsCount": 4,
      "errorsCount": 2
    }
  ],
  "phases": [
    {
      "phaseId": "a3d6a2c8b3411f4b8",
      "kind": "agent",
      "agentType": "project-manager",
      "description": "Bootstrap project context",
      "teamName": null,
      "startTs": "...",
      "endTs": "...",
      "durationMs": 46262,
      "opsCount": 9,
      "tokensTotal": 24060,
      "errorsCount": 0,
      "retriesCount": 0,
      "children": [
        {
          "kind": "tool_use",
          "tool": "Read",
          "detail": "/app/src/App.tsx",
          "ts": "...",
          "approxDurationMs": 800,
          "isApprox": true,
          "agentType": "project-manager"
        },
        {
          "kind": "skill",
          "skill": "superpowers:test-driven-development",
          "ts": "...",
          "approxDurationMs": 1200,
          "isApprox": true
        },
        {
          "kind": "hook",
          "hookName": "typecheck-on-commit.sh",
          "hookType": "SubagentStop",
          "worktree": "/worktrees/TASK-003",
          "startTs": "...",
          "endTs": "...",
          "durationMs": 38000,
          "exitCode": 0,
          "result": "ok"
        }
      ]
    }
  ],
  "topAgents": [
    { "phaseId": "...", "label": "developer TASK-003", "durationMs": 713000, "teamName": "ticket-TASK-003" }
  ],
  "topToolCalls": [
    {
      "phaseId": "...",
      "tool": "Bash",
      "detail": "npm run test:unit:functions",
      "durationMs": 72000,
      "isApprox": false,
      "teamName": "ticket-TASK-003",
      "flaggedSlow": true
    }
  ],
  "toolCounts": [
    { "tool": "Bash",  "count": 153, "totalDurationMs": 1020000, "isApprox": false },
    { "tool": "Read",  "count": 111, "totalDurationMs":  180000, "isApprox": true  }
  ],
  "skills": [
    {
      "skill": "superpowers:test-driven-development",
      "count": 4,
      "totalDurationMs": 3200,
      "invocations": [
        { "ts": "...", "agentType": "developer", "phaseId": "..." }
      ]
    }
  ],
  "hooks": [
    {
      "hookName": "typecheck-on-commit.sh",
      "hookType": "SubagentStop",
      "runs": 12,
      "totalDurationMs": 222000,
      "okCount": 10,
      "failCount": 2,
      "skipCount": 0,
      "blocking": false,
      "executions": [
        { "ts": "...", "worktree": "...", "durationMs": 38000, "exitCode": 0, "tail": null }
      ]
    }
  ],
  "rules": [
    {
      "ruleFile": "agent-output-format.md",
      "reads": 7,
      "readers": [
        { "agentType": "developer", "count": 3 },
        { "agentType": "quality-reviewer", "count": 2 }
      ]
    }
  ],
  "errors": [
    {
      "kind": "task_failed",
      "ts": "2026-04-23T09:55:30Z",
      "phaseId": "...",
      "teamName": "ticket-TASK-004",
      "summary": "Merge TASK-004 failed — merge conflict",
      "payload": { /* tail of the originating event */ }
    }
  ],
  "retries": [
    {
      "ts": "2026-04-23T09:55:34Z",
      "triggeredByErrorTs": "2026-04-23T09:55:30Z",
      "phaseId": "...",
      "description": "Merge TASK-004 (retry)",
      "matchMethod": "suffix-parens-retry"
    }
  ]
}
```

Les champs `isApprox: true` signalent les durées estimées par delta de timestamps plutôt que par `duration_ms` fiable. L'UI doit les préfixer avec `~` pour honnêteté.

## Algorithmes clés

### Association agent → team

- Pour chaque `debug_raw.event.type === "assistant"`, pour chaque bloc `tool_use` où `name === "Agent"` : indexer `tool_use.id` → `tool_use.input.team_name`.
- Pour chaque `system.task_started` où `task_type === "local_agent"` : `teamName = index[task_started.tool_use_id]` (ou `null` si absent).
- `TeamCreate` events consultés uniquement pour récupérer la `description` humaine et définir la couleur du team (via hash stable sur `team_name`).
- Les agents sans `team_name` sont catégorisés `hors équipe`.

### Phases (Niveau 1 de la chronologie)

Une phase représente une exécution continue d'un agent (ou de l'orchestrator) :
- **Orchestrator** : démarre au début de la session ; chaque fois qu'un subagent est dispatché, la phase orchestrator « pause » (pour les stats de durée) jusqu'au retour du subagent. Implémentation : on calcule la durée orchestrator comme `totalSession - Σ(subagent durations)`. Pas besoin de fragmenter la phase orchestrator en sous-phases.
- **Subagent** : une phase = un `task_started` + son `task_notification` correspondant (même `task_id`).

Ordre des phases : tri chronologique par `startTs`.

### Sous-timeline (Niveau 2)

Pour chaque phase :
- Tous les `tool_use` blocks de la phase (identifiés par `parent_tool_use_id` remontant jusqu'au `tool_use_id` initial de la phase — pour l'orchestrator, c'est les top-level, pas de parent).
- Tous les `Skill` tool_uses (cas spécial : on affiche `input.skill` au lieu du label générique).
- Toutes les lignes `hooks.log` dont le timestamp tombe dans `[phaseStartTs, phaseEndTs]` ET dont le worktree correspond à celui de l'agent. Le worktree d'un agent se déduit de l'`Agent` tool_use qui l'a lancé : si `input.isolation === "worktree"`, on parse `input.prompt` pour en extraire la ligne `WORKTREE_PATH=...` (convention utilisée par l'orchestrator dans ce projet). Pour l'orchestrator lui-même (pas de worktree dédié) : lignes `hooks.log` dont le worktree n'est pas attribué à un autre agent dans la fenêtre temporelle (reste minoritaire en pratique).

Tri chronologique par `ts`.

### Durées

- **Bash, Agent, Task** : `duration_ms` du `task_progress`/`task_notification` correspondant → fiable (`isApprox: false`).
- **Read, Edit, Write, Grep, Glob, Skill, TodoWrite, ...** : `ts(nextEventInSamePhase) - ts(thisEvent)` → approximation (`isApprox: true`, préfixe `~` à l'affichage).
- **Hooks** : durée parsée depuis `hooks.log` (format `[ts] hook X START ... [ts] hook X EXIT=N`) → fiable.

### Erreurs

Sources :
1. `debug_raw.event.type === "system" && subtype === "notification" && priority === "immediate"` → kind `notification`
2. `debug_raw.event.type === "result" && is_error === true` → kind `turn_error`
3. `system.task_notification.status === "failed"` → kind `task_failed`
4. Lignes `hooks.log` matching `EXIT=2` **à l'exclusion** des hooks PreToolUse bloquants intentionnels. Liste explicite des hooks dont `EXIT=2` est un comportement attendu (bloquer une commande dangereuse) : `block-bash-file-write.sh`, `block-bash-validation.sh`, `circuit-breaker.sh`, `silent-mode-check.sh`. Tout autre hook avec `EXIT=2` est une vraie erreur → kind `hook_failed`.

Pas d'incorporation du stderr CLI au premier jet (nécessiterait un nouveau type d'event `stderr` dans le log serveur ; différé).

### Retries

Détection par règles, dans l'ordre (premier match gagne) :
1. `task_started.description` match `/\((retry|after [^)]+)\)\s*$/i` → `matchMethod: "suffix-parens-retry"`
2. `task_notification.status === "failed"` puis dans les 5 min suivantes, un `task_started` avec description dont le préfixe commun avec la description failed dépasse 80 % → `matchMethod: "failure-followed-by-similar"`
3. Deux `task_started` identiques (même description) espacés de 5 min au plus → `matchMethod: "duplicate-description-5min"`

La détection est **heuristique** — c'est documenté dans le code et dans le tooltip UI.

### Rules

Heuristique : `tool_use{name:"Read", input.file_path ~= /\.claude\/rules\/[^/]+\.md$/}` → incrémente le compteur de la rule. Attribution à l'agentType de la phase portant le Read.

**Note UI** (pied de section) : *« Détection basée sur les lectures de `.claude/rules/*.md` dans la session ; un agent peut appliquer une rule sans la relire. »*

## Contenu des sections UI

Voir aussi les extraits rendus dans la conversation de design (sections 3 à 7).

1. **Header résumé** — ligne KPI (durée totale, agents, ops, tokens, coût, erreurs, retries) + pastilles team + mini-barre de répartition temporelle
2. **Chronologie 2 niveaux** — phases ordonnées chronologiquement, chacune dépliable en sous-timeline (tool calls, skills, hooks corrélés)
3. **Top opérations** — 3 leaderboards top 5 : agents les plus longs, tool calls les plus longs (Bash/Read fiables, autres `~`), outils les plus utilisés
4. **Skills / hooks / rules** — 3 sous-listes triées par count décroissant ; les hooks incluent les counts `ok/fail/skip` et un flag `blocking` pour les PreToolUse bloquants intentionnels ; la section rules porte une note de limitation explicite
5. **Erreurs & retries** — section dédiée en bas, tri chronologique, entrées dépliables avec contexte + payload tail + lien croisé erreur↔retry et scroll vers la chronologie

## Edge cases

### Côté client

- Fetch KO → panel montre erreur + boutons Retry / Retour au chat.
- Pas de session_id (premier chargement) → bouton reste invisible (`hasUserMessage === false` déjà couvre).
- `working` devient `true` pendant que le panel est ouvert → on reste en mode stats, le bouton Retour reste disponible.
- Réouverture du panel après retour → fetch frais, pas de state persistant.

### Côté serveur

- Log file manquant → 404 `{"error": "session_log_not_found"}`.
- sessionId inconnu (avant 1ère question) → 204 No Content.
- JSONL malformé → skip ligne, log côté serveur, on continue.
- hooks.log absent → section hooks rendue avec placeholder « Aucun hook déclenché pendant cette session ».
- Log volumineux → streaming readline, agrégation O(N), pas de lecture complète en mémoire.

## Testing

- `chat-service/test/stats.test.js` — tests unitaires contre `aggregateSession` avec fixtures :
  - `simple-quick-edit.jsonl` — 1 turn, pas d'agent
  - `single-team-single-ticket.jsonl` — 1 TeamCreate, flow normal sans retry
  - `parallel-two-teams.jsonl` — adapté du log réel du 2026-04-23 (2 TeamCreate, 12+ agents, 1 retry `Merge TASK-004 (retry)`, conflits)
  - `malformed-lines.jsonl` — lignes corrompues intercalées, pour la résilience
- Fixtures `hooks.log.*` associées pour la corrélation.
- Assertions : shape top-level, counts exacts, résolution team via `tool_use_id`, durées, détection retries par chaque `matchMethod`, filtrage des hooks PreToolUse bloquants de la section erreurs.
- 1 test d'intégration HTTP minimal : serveur sur port éphémère, fixture préchargée, `GET /api/stats?sessionId=<id>`, check 200 + shape.
- Pas de test UI automatisé au premier jet. Validation manuelle via browser avec fixtures connues.

## Hors scope (v2 possible)

- Corrélation avec `git log` de la session (commits produits).
- Corrélation avec `docs/tickets/*.json` (statut final des tickets).
- Ratio travail-utile/retries par agent.
- Cache serveur pour sessions déjà agrégées.
- Export du JSON agrégé (téléchargement).
- Historique cross-session (liste des sessions passées, drill-in).
- Test UI automatisé (Playwright).
