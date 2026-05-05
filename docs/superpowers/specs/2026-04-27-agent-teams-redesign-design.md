# Agent-teams redesign — real peer-to-peer communication

**Date** : 2026-04-27
**Status** : Spec draft, à valider
**Auteur** : Jerome (avec assistance Claude)
**Branche cible** : `fix/agent-teams-real-communication` (à créer depuis `main`)

## Contexte

Le CRM-builder a activé `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` depuis le 9 avril, mais l'usage actuel est **purement cosmétique** :

- Le `chat-orchestrator` appelle `TeamCreate` puis dispatch developer/quality-reviewer/test-validator/merger via `Agent({subagent_type: "...", team_name: "..."})`.
- Empiriquement (vérifié sur 4 teams encore présentes dans `~/.claude/teams/<name>/config.json`) **seul `team-lead` est enregistré comme member**. Les autres restent des **task subagents** (id hex random, one-shot, dormants après run).
- **Aucun agent n'a `SendMessage` dans ses tools** sauf le chat-orchestrator. Sur 54 sessions d'historique, **zéro SendMessage cross-agent** (parent_tool_use_id != null).
- L'architecture est en réalité **hub-and-spoke** : reviewer → orchestrator → developer pour le moindre fix-cycle. Pas de communication peer-to-peer.

L'intention initiale d'activer agent-teams était d'exploiter cette communication peer-to-peer pour réduire les allers-retours et auto-séquencer le pipeline. Ce document décrit la refonte qui matérialise enfin cette intention.

## Goals

1. **Réduire la latence du fix-cycle reviewer↔developer** en supprimant l'orchestrator comme intermédiaire (objectif (1)).
2. **Pipeline auto-séquencé** : le lead spawn la team puis reste passif jusqu'au final ; les agents s'enchaînent eux-mêmes (objectif (4)).
3. **IDs déterministes** : tous les agents de la team ont des IDs prédictibles `name@team` (pas hex random), discoverable par tous les autres via leur prompt initial.
4. **Cleanup déterministe** : à la fin du ticket, les transcripts sont effectivement supprimés (résout le bug de fuite intra-session : aujourd'hui les agents dormants persistent 30 jours via `cleanupPeriodDays`).

## Non-goals (out of scope)

- **Communication reviewer ↔ reviewer** : pas nécessaire (le user a confirmé). Reviewers fonctionnent indépendamment, dialoguent uniquement avec dev.
- **Refonte des agents non-team** : `planner`, `architect`, `devops`, `project-manager` restent orchestrator-spawned task subagents classiques.
- **Multi-tickets / waves** : reste orchestré par le lead via TeamCreate en série. Une team par ticket.
- **UX chat UI** : aucun changement côté frontend au-delà de la stats panel.
- **Hooks PreToolUse/Bash actuels** (silent-mode-check, circuit-breaker, block-bash-file-write, block-bash-validation) : inchangés.

---

## Section 1 — Architecture cible (haut niveau)

```
┌─────────────────────────── ticket-TASK-XXX team ───────────────────────────┐
│                                                                             │
│   ┌───────────────┐       ┌───────────────────┐       ┌──────────────────┐  │
│   │  developer@   │ ←───→ │ quality-reviewer@ │       │                  │  │
│   │  team-XXX     │       │     team-XXX      │       │   merger@        │  │
│   │               │ ←───→ │                   │       │   team-XXX       │  │
│   │ pivot         │       │ test-validator@   │       │                  │  │
│   │ (P3 counter)  │       │     team-XXX      │       │                  │  │
│   └──────┬────────┘       └───────────────────┘       └────────┬─────────┘  │
│          │                                                     ▲            │
│          │  SendMessage(merger, "all approved + reflected")    │            │
│          └─────────────────────────────────────────────────────┘            │
│                                                                             │
│                                       │                                     │
│                                       ▼ SendMessage(lead, "merged X")       │
└──────────────────────────────────────────────────┬──────────────────────────┘
                                                   │
                                                   ▼
                                  ┌───────────────────────────┐
                                  │ team-lead@team-XXX        │
                                  │ (chat-orchestrator)       │
                                  │ SPAWN puis CLEANUP only.  │
                                  │ User-facing UX otherwise. │
                                  └───────────────────────────┘
```

**Principe** : un seul tour CLI d'orchestrator pour tout le ticket. Lead spawn les 4 agents au démarrage (avec IDs `name@team` déterministes), envoie le go au dev, puis attend le SendMessage final du merger. Pendant ce temps : dev↔reviewers en P2P, dev gère son fix-loop, dev fait reflection (Mode 2), dev pousse au merger, merger merge, merger pinge lead, lead nuke les transcripts et répond à l'user.

**Modes** :
- **Simple mode** (no-reviewers) : lead spawn dev + merger seulement. Dev → directement SendMessage(merger). Pas de reflection.
- **Complex mode** : tous les 4 agents (dev + 2 reviewers + merger). Reflection en Mode 2 dans le dev.

---

## Section 2 — Rôles, modèles, outils par agent

| Agent | name@team | Modèle | Tools clés | Rôle |
|---|---|---|---|---|
| **chat-orchestrator** | `team-lead@<team>` | sonnet | `TeamCreate, TeamDelete, Agent, SendMessage, Skill, Read, Bash` | UX user, spawn initial, cleanup final |
| **developer** | `developer@<team>` | opus | `Read, Edit, Write, Bash, Glob, Grep, Skill, SendMessage` | Implémente, fix-cycles avec reviewers, P3 counter, Mode 2 reflection, push au merger |
| **quality-reviewer** | `quality-reviewer@<team>` | sonnet | `Read, Bash, Glob, Grep, Skill, SendMessage` | Lit le diff du dev, verdict APPROVED/BLOCKED, dialogue avec dev |
| **test-validator** | `test-validator@<team>` | **sonnet** | `Read, Bash, Glob, Grep, Skill, SendMessage` | Vérifie tests/e2e/typecheck **+ pertinence** des assertions, dialogue avec dev |
| **merger** | `merger@<team>` | haiku | `Bash, Read, SendMessage` | git merge --no-ff, cleanup worktree, ping lead |

### Changements vs aujourd'hui

1. **Tous gagnent `SendMessage`** dans leurs tools — c'est la base de la communication P2P. Aujourd'hui seul l'orchestrator a SendMessage.
2. **Tous gardent leur `subagent_type`** existant et reçoivent en plus un `name:` field au spawn. C'est ce qui leur donne l'ID stable `name@team`. **À vérifier en Phase 0** que `subagent_type + name` génère bien `name@team` (vérifié pour `general-purpose`, à confirmer pour types nommés).
3. **test-validator passe haiku → sonnet** : son scope s'étend à juger la **pertinence** des tests (les assertions couvrent-elles les failure modes ?), ce que haiku rate.
4. **dev reste opus** : son rôle s'élargit (reflection en plus, fix-loop multi-cycle, dialogue actif), donc capacité de raisonnement importante.
5. **quality-reviewer reste sonnet** : son boulot devient plus interactif (expliquer pourquoi BLOCKED, juger les fix proposés), il faut de la nuance.
6. **merger reste haiku** : rôle mécanique inchangé (git merge + ping lead).

### Agents non-team inchangés

`planner`, `architect`, `devops`, `project-manager` ne sont pas dans une team-ticket. Ils gardent leur fonctionnement actuel (orchestrator-spawned, task subagent classique, hex id).

---

## Section 3 — Flow concret

### 3.1 Happy path (complex mode, 0 BLOCKED)

```
T+0    user: "Build TASK-XXX"
T+0    lead: TeamCreate(team_name: "ticket-TASK-XXX")
       lead: spawn 4 agents en parallèle (1 message, 4 tool_use blocks):
         Agent(developer,        name: "developer",        team_name)
         Agent(quality-reviewer, name: "quality-reviewer", team_name)
         Agent(test-validator,   name: "test-validator",   team_name)
         Agent(merger,           name: "merger",           team_name)

T+0    lead: SendMessage(developer@team, "GO — Implement TASK-XXX. After
              reviewers approve, write reflection (Mode 2), then SendMessage
              merger@team to merge. Reviewers: [quality-reviewer@team,
              test-validator@team]. Merger: merger@team.")
T+0    lead: réplique à user "On démarre TASK-XXX..." et entre dans
              attente de SendMessage entrant (mécanisme à valider — voir 4.1).

T+0..N dev: lit le ticket, fait son implémentation dans le worktree,
            commit, puis:
       dev: SendMessage(quality-reviewer@team, "ready, please review")
       dev: SendMessage(test-validator@team,   "ready, please validate")
       (P3 counter init: approvals_needed = 2, approvals_received = 0)

T+N    quality-reviewer: SendMessage(developer@team, "APPROVED")
T+N+ε  test-validator:   SendMessage(developer@team, "APPROVED")

       dev: P3 counter atteint 2/2. Bascule en Mode 2:
            - lit /app/docs/reflections/ pour pattern matching
            - écrit /worktrees/TASK-XXX/docs/reflections/TASK-XXX-reflection.md
            - commit reflection
       dev: SendMessage(merger@team, "all reviewers approved + reflection
            committed, please merge")

T+M    merger: cd /app, git merge --no-ff <branch>, cleanup worktree, etc.
       merger: SendMessage(team-lead@team, "merged X")

T+M    lead: reçoit le SendMessage final
       lead: TeamDelete + filesystem cleanup (rm subagents/*)
       lead: réplique à user "TASK-XXX done, merge commit abc123."
       CLI exit.
```

### 3.2 Fix-cycle (BLOCKED par un reviewer)

```
T+N    test-validator: SendMessage(developer@team, "BLOCKED:
                         - missing e2e for filter X
                         - assertion in test Y is wrong, expected Z")
       quality-reviewer: SendMessage(developer@team, "APPROVED")  (déjà arrivé)

       dev: P3 counter à 1/2 mais reçoit BLOCKED → counter reset à 0/2.
       dev: applique les fixes dans le worktree, commit.
       dev: re-notifie TOUS les reviewers (R1 — l'approval précédent
            de quality est invalidé) :
              SendMessage(quality-reviewer@team, "fixed, please re-review")
              SendMessage(test-validator@team,   "fixed, please re-validate")

T+N+1  quality-reviewer: SendMessage(developer@team, "APPROVED")
T+N+1  test-validator:    SendMessage(developer@team, "APPROVED")
       dev: counter 2/2 → reflection → SendMessage(merger).
       (suite identique au happy path)
```

### 3.3 Prompt initial de chaque agent

Chaque agent reçoit en prompt initial (au spawn) :
```
ROLE: <developer | quality-reviewer | test-validator | merger>
TEAM: ticket-TASK-XXX
WORKTREE: /worktrees/TASK-XXX
TICKET_FILE: <session_dir>/TASK-XXX.json (ou inline pour simple mode)
TEAMMATES:
  developer@ticket-TASK-XXX
  quality-reviewer@ticket-TASK-XXX
  test-validator@ticket-TASK-XXX
  merger@ticket-TASK-XXX
  team-lead@ticket-TASK-XXX
PROTOCOL: <role-specific instructions: who to message when, what verdict format>
```

Le prompt est court — la logique du flow est dans le **skill agent-team v2** (réécrit), que chaque agent invoke via `Skill({skill: "agent-team"})` au démarrage.

### 3.4 Simple mode (pas de reviewers)

Le pipeline dégénère naturellement :

```
lead: TeamCreate
lead: spawn dev + merger seulement (2 agents, pas 4)
lead: SendMessage(developer@team, "GO — task: <inline>; merger: merger@team;
                                   no reviewers; no reflection")
dev: implement, commit, SendMessage(merger@team, "ready")
merger: merge, SendMessage(team-lead, "merged X")
lead: cleanup + reply user
```

Pas de reflection en simple mode (cohérent avec aujourd'hui).

---

## Section 4 — Lifecycle, cleanup et failure paths

### 4.1 Mécanisme "lead attend le SendMessage final"

Modèle Claude Code : un seul tour CLI par message user. Le tour est **long-running** (tout le pipeline tourne dedans, comme aujourd'hui avec les Agent synchrones).

Question mécanique à valider en **Phase 0** : quel mécanisme fait que le lead, après son `SendMessage(developer, "GO")`, **reste actif** jusqu'à recevoir le `SendMessage(team-lead, "merged X")` du merger ? Trois hypothèses :

- **(W1)** SendMessage du sub-agent vers `team-lead@<team>` arrive comme `task_notification` ou similar event dans le stream du lead. Le LLM du lead voit ça et ré-infère naturellement.
- **(W2)** Le lead doit explicitement faire du polling via `TaskOutput({task_id: merger@...})` ou checker son inbox (`~/.claude/teams/<team>/inboxes/team-lead.json` qu'on a vu sur disque).
- **(W3)** Mécanisme caché plus opaque (ex: les events SendMessage entrants déclenchent automatiquement une nouvelle inférence du lead).

Si (W1) : zéro changement de prompt nécessaire. Si (W2) : le prompt du lead inclut une instruction "poll TaskOutput jusqu'à merger done". Si (W3) : on documente le comportement et on s'y appuie.

### 4.2 Cleanup au end-of-team

Après le `SendMessage(team-lead, "merged X")` reçu, le lead exécute :

```bash
# subagent transcripts (la vraie libération — pas couverte par TeamDelete)
rm -f /home/developer/.claude/projects/-app/$CLAUDE_SESSION_ID/subagents/agent-developer@<team>.jsonl
rm -f /home/developer/.claude/projects/-app/$CLAUDE_SESSION_ID/subagents/agent-developer@<team>.meta.json
# idem pour quality-reviewer@, test-validator@, merger@
rm -f /tmp/claude-1001/-app/$CLAUDE_SESSION_ID/tasks/*.output
```

Puis :
```
TeamDelete({team_name: "<team>"})
```

(qui cleanup `~/.claude/teams/<name>/` et `~/.claude/tasks/<name>/`).

**À valider (Phase 0 Q3)** : `$CLAUDE_SESSION_ID` est-il accessible au lead via env var ou doit-on l'injecter via le chat-service dans `claude -p` ? Solution de repli : le chat-service injecte `CLAUDE_SESSION_ID=<id>` dans l'env du `claude -p` qu'il spawn (trivial à ajouter dans server.js).

**Pourquoi le `rm` filesystem en plus de TeamDelete** : empirically vérifié — TeamDelete ne touche pas les transcripts subagents. Sans ce `rm`, les agents restent "résumables" par SendMessage pendant 30 jours (`cleanupPeriodDays`).

### 4.3 Failure paths

| Scénario | Détection | Réaction |
|---|---|---|
| Reviewer silencieux > 3 min | dev a un timeout dans son prompt: "if no reply in 180s, SendMessage(team-lead, 'stuck on reviewer X')" | lead intervient: SendMessage de relance, ou abort avec cleanup |
| Dev en boucle infinie de fix (>5 cycles) | dev counter de cycles dans son prompt: "if cycles > 5 with no convergence, SendMessage(team-lead, 'stuck')" | lead reformule l'attente ou abort |
| Merger échoue (merge conflict) | merger SendMessage(team-lead, "merge failed: <reason>") au lieu de "merged X" | lead remet le dev en piste OU abort propre |
| Hook `stop-hook-error` (cf. session de4b5b2b) | event `stop-hook-error` arrive dans le stream du lead (déjà visible aujourd'hui) | lead voit, peut décider d'abort ou de continuer si non-blocking |
| User STOP pendant le pipeline | chat-service interrupt actuel ([server.js:632](chat-service/server.js#L632), état → `cancelled`) | chat-service fait le cleanup filesystem brutal des `subagents/*` du claudeSessionId courant, sans attendre le lead |

### 4.4 Hooks — nouveau modèle `PreToolUse / SendMessage`

#### Pourquoi changer

Les hooks `SubagentStop / matcher: developer` actuels firent à **chaque pause** du dev. En α le dev pause après chaque SendMessage — donc les hooks tourneraient 5-10× par ticket dont 90% inutilement (pause "j'ai reçu BLOCKED, je vais lire" → pas de commit nouveau, hook qui re-vérifie pour rien).

#### Nouveau design

Hook PreToolUse qui intercepte le SendMessage du dev **avant qu'il parte vers un reviewer**, valide, bloque le SendMessage en cas d'échec.

```
settings.json:
"PreToolUse": [
  {
    "matcher": "SendMessage",
    "hooks": [
      { "command": ".claude/hooks/validate-before-review.sh", "timeout": 180 }
    ]
  }
]
```

Le script `validate-before-review.sh` :
1. Lit stdin (Claude Code injecte le tool input JSON, dont `tool_input.to`)
2. Si `tool_input.to` ne match pas `quality-reviewer@*` ou `test-validator@*` ou `merger@*` → exit 0 (skip)
3. Sinon → run la chaîne actuelle : typecheck, unit-app, unit-functions, e2e, prettier
4. Tout pass → exit 0 → SendMessage parte normalement
5. Au moins un fail → exit 2 → SendMessage bloqué, le dev voit le stderr en `tool_use_error`, fixe, retry

#### Pourquoi inclure `merger@*` dans le matcher

En simple mode, dev → merger directement. Sans reviewers, on n'a pas de gate pré-merge si on ne match que les reviewers. En complex mode, c'est redondant (reviewers ont validé) mais le coût est ~zéro car typecheck/tests skippent quand le diff n'a pas changé.

#### Suppression des hooks SubagentStop

On retire les 5 hooks `SubagentStop / matcher: developer` actuels — remplacés en bloc par le PreToolUse SendMessage. Un seul hook au lieu de 5, comportement plus prévisible.

#### Bug `stop-hook-error` à débugger en Phase 0

Reste à débugger en Phase 0 indépendamment de cette refonte. Sans ce fix, même les hooks PreToolUse pourraient échouer silencieusement.

---

## Section 5 — Impact sur la stats panel

### 5.1 Bug existant à fixer

Le bug "agent unknown" (vu dans la session de4b5b2b) vient du mapping `tool_use_id → subagent_type` ([stats.js:121-125](chat-service/lib/stats.js#L121-L125)) qui ne reconnaît pas les SendMessage-resume.

Avec α, le problème devient **systémique** : chaque agent va recevoir N SendMessage pendant son lifecycle (= N task_started events avec N tool_use_ids différents). Sans fix, la panel afficherait 4 agents "named" + 8-15 phases "unknown".

### 5.2 Fix : indexer par task_id, pas par tool_use_id

`task_id` reste **stable** sur tout le lifecycle d'un agent (un seul task_id pour developer, peu importe combien de fois SendMessage le résume). `tool_use_id` change à chaque resume.

```js
// Avant (cassé) :
agentTypeByToolId.set(b.id, b.input.subagent_type);
// agentType = agentTypeByToolId.get(ev.tool_use_id) → "unknown" pour les resumes

// Après :
const agentTypeByTaskId = new Map();
// 1er passage : Agent spawn → on connaît task_id (depuis task_started qui suit)
//               ET subagent_type → mapping établi à la 1ère apparition
// Tous les task_started suivants pour le même task_id (resumes) lookup directement.
```

Avec `name@team`, c'est encore plus simple : le `task_id = name@team` directement. Pas besoin de chercher.

### 5.3 Restructuration de la phase model

Aujourd'hui : 1 phase = 1 agent (extracted from `task_started` event with task_type=local_agent).

Avec α : 1 agent **a plusieurs activations** (1 par message reçu). On veut une seule phase par agent, avec activations comme children.

```
Phase: developer@ticket-TASK-XXX
├─ activation 1: 12:01-12:03 [3 commits]
│  ├─ Read package.json
│  ├─ Edit src/x.ts
│  └─ Bash git commit
├─ SendMessage(quality-reviewer@..., "ready")    ← outgoing event
├─ SendMessage(test-validator@..., "ready")      ← outgoing event
├─ <inbox: BLOCKED from test-validator>          ← incoming event
├─ activation 2: 12:04-12:05 [fix]
│  ├─ Edit src/x.ts (test fix)
│  └─ Bash git commit
└─ ...
```

Modifs concrètes dans stats.js :
1. `extractPhases()` : grouper par `task_id` au lieu de générer une phase par `task_started`.
2. `populateChildrenAndCounts()` : ajouter un type d'event `incoming_message` / `outgoing_message` pour les SendMessage entrants/sortants.
3. UI : afficher les activations comme bandes de temps dans la timeline de l'agent. Les SendMessage cross-agent comme **edges** entre deux agents (visualisation graph) ou comme markers temporels.

### 5.4 Lead phase quasi-vide

Le lead aura une phase courte (TeamCreate + 4 spawns + initial SendMessage à T+0) puis un grand vide jusqu'au cleanup final. C'est **correct** — il reflète le fait que le lead est passif.

### 5.5 Effort

Plus important que le simple fix du bug "unknown". ~300 lignes diff dans stats.js + adaptation frontend pour les bandes d'activation. **Reportable** : peut être fait en parallèle ou même décalé en Phase 5 si la priorité c'est de faire tourner agent-teams.

---

## Section 6 — Risques, questions ouvertes, et plan de migration

### 6.1 Risques principaux

| Risque | Impact | Mitigation |
|---|---|---|
| Agent-teams est `EXPERIMENTAL` chez Anthropic — comportement peut changer | Refonte invalide en cas de breaking change | Documenter les hypothèses ; capturer les versions Claude Code testées (2.1.118 actuellement) ; tests d'intégration re-lançables |
| Mécanisme "lead reçoit SendMessage entrant" (W1/W2/W3) non vérifié | Si pas comme on suppose, redesign mineur du lead | **Phase 0** valide empiriquement avant tout commit de prod code |
| `subagent_type + name` → `name@team` non vérifié pour types nommés | Si ça donne hex au lieu de name@team, IDs non-déterministes, design alpha s'écroule | **Phase 0** valide empiriquement |
| Bug `stop-hook-error` toujours pas root-causé | Hooks pollués, bloquent silencieusement | **Phase 0** débugge d'abord le crash actuel |
| Filesystem cleanup peut racer avec agents pas totalement dormants | Erreurs ou résidus | Cleanup uniquement après merger SendMessage(lead) — donc tout le monde est en attente passive |
| Logique de timeout cross-agent | Pipeline qui hang | Timeouts dans les prompts + watchdog côté chat-service comme failsafe |

### 6.2 Questions ouvertes (Phase 0)

1. **Q1 — Mécanisme W?** : comment exactement le lead "voit-il" un SendMessage entrant pendant qu'il est en attente ? Test ciblé.
2. **Q2 — `subagent_type:developer + name:"developer"`** : ça génère bien `developer@team` ou ça reste hex ? Test ciblé.
3. **Q3 — `CLAUDE_SESSION_ID`** : accessible au lead via env var, ou injection via chat-service ?
4. **Q4 — `stop-hook-error`** : pourquoi les hooks crashent dans la session de4b5b2b ? Re-run en mode debug avec `bash -x`.
5. **Q5 — Stats panel** : Phase 1 ou Phase 5 ? Recommandation : Phase 5 (pas bloquant).

### 6.3 Plan de migration

**Branche** : `fix/agent-teams-real-communication` depuis `main`.

**Phases** :
- **Phase 0 — Validation empirique** (1-2h) : 4 tests ciblés en conteneur isolé pour répondre Q1-Q4. Documenter les findings dans `docs/superpowers/runs/<date>-agent-teams-validation.md`.
- **Phase 1 — Skill agent-team v2** : réécrire [SKILL.md](claudeConfig/.claude/skills/agent-team/SKILL.md) avec le nouveau flow (TeamCreate, 4 spawns, P3, R1, K1, cleanup).
- **Phase 2 — Agents : tools + prompts** : ajouter `SendMessage` dans tools de developer, quality-reviewer, test-validator, merger. Update markdown de chacun pour décrire le nouveau protocole. Inclut le passage de test-validator de haiku à sonnet.
- **Phase 3 — Hook PreToolUse / SendMessage** : nouveau script `validate-before-review.sh` ; mise à jour [settings.json](claudeConfig/.claude/settings.json) (suppression des 5 SubagentStop, ajout du PreToolUse).
- **Phase 4 — chat-orchestrator + chat-service** : update [chat-orchestrator.md](claudeConfig/.claude/agents/chat-orchestrator.md) pour le nouveau flow ; injecter `CLAUDE_SESSION_ID` dans `claude -p` côté server.js si nécessaire ; éventuel watchdog pour timeouts.
- **Phase 5 — Stats panel adaptation** : fix bug "unknown" + restructuration phase model. Reportable.
- **Phase 6 — Tests end-to-end** : run un ticket simple puis un ticket complex (avec BLOCKED puis APPROVED). Capturer logs et comparer aux baselines existantes.
- **Phase 7 — Doc + merge** : update [CLAUDE.md](CLAUDE.md), ouvrir PR, review, merge.

### 6.4 Out of scope explicite (rappel)

- `planner`, `architect`, `devops`, `project-manager` ne deviennent pas des team members.
- Pas de refonte du flow multi-tickets (waves) — orchestré par lead/planner via TeamCreate en série, une team par ticket.
- Pas de changement UX côté chat UI au-delà de la stats panel.
- Reflection skill et hooks PreToolUse/Bash actuels (silent-mode-check, etc.) restent inchangés.

---

## Annexe — Référence aux décisions de design

Ce spec consolide les décisions prises par le user lors du brainstorming :

| Décision | Choix | Justification courte |
|---|---|---|
| **Goals** | (1) latence reviewer↔dev + (4) lead passif | reviewers entre eux ne se parlent pas, peer-to-peer ciblé |
| **Fix-cycle ownership** | (A) reviewer → dev directement | vrai P2P, élimine le hop par lead |
| **Pipeline transitions** | (α) self-routing complet | lead vraiment passif, transitions auto |
| **Multi-reviewers** | (P3) dev compte les approvals | pas d'agent supplémentaire, état chez le pivot |
| **Spawn timing** | (i) all-spawned-upfront | IDs déterministes, lead vraiment passif après spawn |
| **Re-review on fix** | (R1) re-notifier tous reviewers | sound, pas de risque de merge non-validé |
| **Reflection** | (K1) intégré dans le dev | pas d'agent dédié, contexte déjà chargé |
| **test-validator model** | sonnet (pas haiku) | pertinence des tests = jugement sémantique |
| **Hooks** | PreToolUse / SendMessage (matcher reviewers + merger) | gate au bon moment, pas à chaque pause LLM |
