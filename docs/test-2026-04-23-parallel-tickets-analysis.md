# Test parallel tickets — badge new + compteur notes (2026-04-23)

**Session log** : [chat-logs/session-2026-04-23T07-52-18-515Z.jsonl](../chat-logs/session-2026-04-23T07-52-18-515Z.jsonl)

**Prompt utilisateur** : *"ajoute deux indicateurs visuels : (1) un badge 'new' sur les contacts créés il y a moins de 7 jours, et (2) un compteur de notes sur chaque carte de deal dans le Kanban."*

**Contexte** : premier test explicitement conçu pour exercer le parallélisme multi-tickets (2 ajouts indépendants sur 2 entités différentes). Test lancé après :
- Unification simple + complex paths dans le même worktree/merger flow
- Refactor chat-orchestrator ↔ agent-team skill (source unique par concern)
- Nouvelle règle "BATCH ALL 2N tool_use IN ONE MESSAGE" avec exemples ✅/❌
- Ajout de la Mode 2 reflection obligatoire avant merger
- Hook PreToolUse `block-bash-file-write` pour empêcher les `cat > file`

**Verdict** : **run cassé, kill manuel nécessaire, 0 ticket mergé**. Mais très instructif — révèle 3 bugs concrets à corriger.

---

## Chronologie

| UTC | Δ | Acteur | Action | Notes |
|---|---|---|---|---|
| 07:52:20 | 0 | user | QUICK_EDIT | |
| 07:52:31 | +11s | orchestrator | *"What would you like to change..."* | anglais par défaut ⚠️ (pas encore d'input user pour détecter le français) |
| 07:52:34 | +3s | user | Prompt FR : badge new + compteur notes | |
| 07:52:50 | +16s | orchestrator | *"C'est une modification qui touche plusieurs parties..."* | ✅ template forbidden-words respecté |
| 07:52:56 | +6s | orchestrator | *"Je vérifie d'abord l'état du projet avant de planifier."* | Read project-context |
| 07:53:19 | +23s | orchestrator | *"Le plan de base est déjà partiellement en place. Je lance la planification détaillée."* | |
| 07:53:26 | +7s | → planner | Dispatch | Durée : **3m 15s** |
| 07:56:41 | — | orchestrator | *"Le plan est prêt : les deux indicateurs peuvent être développés en parallèle. Je les lance simultanément."* | ✅ |
| 07:56:47 | +6s | orchestrator | *"Les deux étapes sont prêtes et peuvent avancer en parallèle, je les lance."* | ⚠️ doublon cosmétique du message précédent |
| 07:56:52 | +5s | orchestrator | TeamCreate `ticket-TASK-003` | |
| 07:56:53 | +1s | orchestrator | TeamCreate `ticket-TASK-004` | |
| 07:56:55 | +2s | → developer TASK-003 opus | Dispatch | 1 tool_use par message (pas le même message que TeamCreate) |
| 07:56:56 | +1s | → developer TASK-004 opus | Dispatch | idem |
| ~07:57 → ~08:20 | **23m 9s** | — | **SILENCE** — les 2 devs bossent en parallèle dans leurs worktrees | Voir section circuit breaker |
| 08:20:05 | — | orchestrator | *"Je vérifie l'état des deux étapes et je reprends là où elles se sont arrêtées."* | ⚠️ "reprends là où elles se sont arrêtées" = indicateur clair que quelque chose a cassé |
| 08:20:06 | +1s | → quality-reviewer TASK-003 sonnet | Dispatch (review du code dev1) | |
| 08:20:07 | +1s | → test-validator TASK-003 haiku | Dispatch (2 messages séparés de qualreviewer) | |
| 08:20:13 | +6s | → developer TASK-004 **sonnet** | Fix dispatch (original opus bloqué) | sonnet pour continuer moins cher |
| 08:20 → kill | ~13m | — | Dev TASK-004 sonnet **stuck dans un vitest hang** | Vitest `--run` dans worktree, process 15s CPU en 13 min = bloqué |
| — | — | — | **Kill manuel + cleanup worktrees** (user intervention) | |

**Durée totale observée (avant kill)** : ~40 min
**Coût observé avant kill** : $0.06 initial + quelque chose d'indéterminé (pas de RESULT final de completion)

---

## Ce qui a fonctionné ✅

### 1. Planning parallèle par le planner

Tickets créés avec **déclaration correcte des non-dépendances** :

```
TASK-003  deps=[]  parallel_safe=true  →  badge new sur contacts
TASK-004  deps=[]  parallel_safe=true  →  compteur notes sur deal card
```

Le planner a correctement identifié que les 2 features sont **indépendantes** (entités différentes, fichiers différents). ✅

### 2. Dispatches parallèles à l'échelle container

Les 2 dev dispatches (07:56:55 et 07:56:56) sont séparés de 1 seconde seulement. Leurs processus ont démarré dans la même seconde. Les 2 worktrees ont été créés en parallèle (voir `ls /worktrees/` qui montrait TASK-003 ET TASK-004 actifs pendant la phase silence).

Techniquement **pas de multi-tool-use dans un seul message** (comme dans les tests précédents — limite sonnet confirmée), mais le parallélisme **s'est effectivement produit** côté processus : les 2 devs ont bossé concurremment pendant 23 min.

### 3. Messages user-facing corrects

Tous les messages utilisateur respectent plain language :
- Pas de path, pas de "TASK-", pas de mention d'agent
- Les 2 templates "en parallèle" ont été utilisés
- Aucune fuite technique

### 4. Worktree scope respecté

Dans le subset de bash observés (avant circuit breaker), zero violation `/app/src` : tous les `cd /worktrees/TASK-XXX &&` corrects.

### 5. Hook `block-bash-file-write` actif (et silencieux)

Aucun blocage log dans hooks.log → les devs n'ont pas tenté de `cat >` cette fois. Le hook est en place prêt à bloquer quand utile.

---

## Ce qui a cassé 🔴

### Bug #1 — Circuit breaker à 30 Bash : trop bas pour dev complexe

**Preuve** : counters observés `count=30, 31, 32` pour 2 subagents distincts → **2 devs bloqués** par la limite.

**Décomposition d'un dev complex** (d'après l'observation de ce run) :
- 1 Bash : worktree setup (`git worktree add + ln -s node_modules + cd`)
- 2-3 Bash : exploration (find, ls)
- 3-5 Bash : typecheck (avant + après modifs)
- 3-5 Bash : vitest runs (plusieurs iterations)
- 2 Bash : prettier check + apply
- 2-3 Bash : git add + git commit
- 3-5 Bash : e2e spec exploration + validation
- **Total : 15-25 Bash minimum pour un ticket simple**

Avec un feature UI qui nécessite plusieurs retries (typecheck fail, prettier fix, test fix), ça monte facilement à 30-40 Bash. La limite à 30 **garrote les devs avant qu'ils finissent leur travail légitime**.

**Pré-existant** : ce bug existait mais on ne le voyait pas sur les tests simples. Apparaît dès qu'un dev fait un vrai travail complet avec tests.

**Fix** : bump à **60 Bash par subagent** dans [claudeConfig/.claude/hooks/circuit-breaker.sh](../claudeConfig/.claude/hooks/circuit-breaker.sh). Reste protecteur contre les loops infinis (qui font 100+) mais permet le travail légitime.

---

### Bug #2 — activeAgents counter dérive dans chat-service

**Observation utilisateur** : l'UI a affiché **11 agents en parallèle** à un moment donné, alors qu'il n'y avait **1 à 3 subagents réellement actifs**.

**Analyse** :
- Server.js incrémente `activeAgents` sur chaque event `task_started` et décrémente sur `task_notification` avec status `completed`
- MAIS Claude Code émet `task_started` pour **beaucoup de choses internes** (pas juste les sous-agents) :
  - Chaque Bash tool call émet un task_started
  - Chaque Agent dispatch émet un task_started
  - Chaque sous-sous-agent dans un team émet task_started

**Compte observé dans le log** : 28 `task_started` vs 17 `task_notification completed` → delta de 11 (d'où le "11 agents").

**Réalité** : seulement **6 subagent uniques** spawnés (1 planner + 3 dev + 1 quality-reviewer + 1 test-validator), **dont jamais plus de 2 vraiment actifs simultanément**.

**Fix** : dans [chat-service/server.js](../chat-service/server.js), re-implémenter le compteur pour tracker **uniquement les `Agent` tool_uses** (et leur résolution via tool_result), pas les `task_started` génériques. Décremention à la réception du tool_result du Agent dispatch.

---

### Bug #3 — Vitest hang en parallèle avec node_modules symlinké

**Preuve** : vitest PID 22435 lancé à 08:20, toujours running à 08:33 (13 min), mais seulement **15 s de CPU consommées** → complètement bloqué.

Le developer TASK-004 polling l'output file qui est resté à **0 octet** pendant tout le hang.

**Hypothèses** :
1. **Vitest concurrency** — 2 vitest `--run` lancés simultanément dans 2 worktrees partageant `/app/node_modules` via symlink. Locks ou cache shared concurrents → deadlock.
2. **Port conflict** — vitest browser mode ou workers pourraient tenter de lock un port shared
3. **Ressources container** — CPU / RAM saturés par les 2 vitest + esbuild + typescript server

**Pour le vérifier** : relancer en séquentiel avec isolation (node_modules copié au lieu de symlinké) et voir si le hang disparaît.

**Mitigation court terme** :
- Ajouter un **timeout de hang** dans les Bash tool calls qui poll une output file (ex: si `until grep` tourne > 5 min, bail)
- OU explicitement désactiver le parallélisme test : imposer `run_in_background: false` + timeout strict sur les vitest runs
- OU dev.md interdit `npx vitest` dans un worktree parallélisé — demande au test-validator de le faire séquentiellement sur main post-merge

---

### Bug #4 — Pas de détection de hang côté orchestrator

**Constat** : le TASK-004 dev sonnet est parti polling une output 0-byte pendant 13 min, et l'orchestrator n'a rien fait (il attendait le tool_result du sous-agent, qui ne revenait pas).

Si **je** n'avais pas tué manuellement, le test aurait continué à ne rien produire, **consommant du temps et potentiellement du token** (l'orchestrator ne coûte rien tant qu'il ne tourne pas, mais le subagent bloqué continue de brûler des quotas API si ses `until` loops émettent des output qu'il lit).

**Fix à explorer** :
- Timeout par subagent (ex: 15 min max par dev, après quoi le dispatch est considéré failed)
- Watchdog côté chat-service qui compte le time depuis le dernier Bash activity et alerte
- Utiliser `TaskStop` sur un subagent visibly stuck (côté orchestrator)

---

## Metrics

| Métrique | Valeur |
|---|---|
| Durée avant kill | ~40 min |
| Coût avant kill | indéterminé (pas de RESULT final, estimé > $4) |
| Tickets créés | 2 (TASK-003, TASK-004) |
| Tickets mergés | **0** |
| Agent dispatches | 6 |
| TeamCreate | 2 |
| TeamDelete | **0** (jamais déclenché) |
| Total Bash | 106 |
| Total Read/Edit/Write | 64+10+4 = 78 |
| Mode 2 reflections écrites | **0** (jamais atteint cette phase) |
| Circuit breaker hits | 3+ (counts 30, 31, 32 confirmés) |
| Worktrees orphelins au kill | 2 |

---

## Comparaison avec run précédent (priority, 2026-04-22)

| Métrique | Run priority (réussi) | **Run parallel (cassé)** |
|---|---|---|
| Tickets | 2 séquentiels (TASK-002 dep TASK-001) | 2 parallèles (pas de dep) |
| Durée | 22 min | ~40 min avant kill |
| Coût | $3.90 | indéterminé (>$4 probable) |
| Tickets mergés | 2/2 ✅ | 0/2 ❌ |
| Reviewers parallel | oui (timing) | oui pour TASK-003 seulement |
| Reflections | 0 (avant le fix) | 0 (Mode 2 jamais atteint) |
| Merger | 2/2 ✅ | 0/2 ❌ |
| Worktree pollution | aucune | aucune (avant kill) |
| Circuit breaker hits | 0 | 2+ |
| Hang | non | oui (vitest) |

**Le run parallèle est plus lourd car** :
- 2 devs concurrents consomment plus de Bash (chacun sa stack de typecheck/test/commit)
- Les vitest parallèles en worktrees symlinkés se bloquent mutuellement
- Les 2 devs atteignent tous deux le circuit breaker avant de finir

**Le run séquentiel fonctionne parce que** :
- Un seul dev à la fois, son budget de 30 Bash suffit
- Pas de contention sur node_modules ni sur resources

---

## Fixes à appliquer (ordonnés)

### Priority 🔴 — bloquants pour run parallel

1. **Bump circuit-breaker à 60** dans [circuit-breaker.sh:8](../claudeConfig/.claude/hooks/circuit-breaker.sh#L8). `ITERATION_LIMIT=60`. Reste protecteur contre loops (>100), mais permet le dev complex avec tests.

2. **Fix activeAgents counter** dans [chat-service/server.js](../chat-service/server.js) :
   - Tracker uniquement les `Agent` tool_uses
   - Incrémenter sur Agent dispatch, décrémenter sur tool_result du dispatch
   - Ne plus lire `task_started` comme source

3. **Investiguer + fixer vitest hang en parallèle** :
   - Reproduire avec `npx vitest --run` dans 2 worktrees simultanés
   - Si confirmé, changer approche : soit copier `node_modules` au lieu de symlink, soit interdire vitest en // via rule dans developer.md

### Priority 🟠 — détection de hang

4. **Watchdog sur subagent** : côté chat-service, tracker la latence depuis le dernier Bash / Edit de chaque subagent. Si > 10 min sans nouvelle activité, emit un warning dans le log. Si > 20 min, proposer `TaskStop` à l'orchestrator.

### Priority 🟡 — hygiène

5. **Éviter le doublon user-facing** (*"en parallèle, je les lance simultanément"* puis *"en parallèle, je les lance"*). Réduire à **un seul** message par transition de phase dans chat-orchestrator.md templates.

---

## Leçons

1. **Parallèle != gratuit** — 2 devs concurrents n'est pas juste "2 fois plus vite". Il y a des side effects sur le sandbox (CPU, RAM, node_modules partagé, ports). Le vitest hang est probablement un symptôme.

2. **Circuit breaker générique = garrot sur tâches réelles**. 30 était calibré pour des simple changes. Un dev complexe avec tests légitime a besoin de 40-50 Bash. Le chiffre doit matcher le workload attendu.

3. **Stats counter = code fragile** — tracker des events Claude Code génériques (task_started) pour inférer "agents actifs" est instable. Il faut soit tracker les Agent tool_uses explicitement, soit ne pas afficher de compteur "agents" du tout.

4. **Pas de hang detection = run infini** — un subagent bloqué dans un `until grep` attend le même state forever. Sans watchdog, le test aurait consommé tokens + temps indéfiniment.

5. **Le Mode 2 reflection n'a jamais été exercé** — le fix n'a pas pu être validé parce qu'on n'a pas atteint la phase APPROVED. Il faudra un run qui se termine vraiment.

---

## Prochain test

Une fois les 3 priorités 🔴 corrigées, relancer le **même prompt** (badge new + compteur notes) pour comparer. Si ça passe propre :
- Valider que Mode 2 reflection est dispatché
- Valider que merger × 2 marche
- Confirmer que le stats counter est stable

Sinon on en profite pour isoler le bug suivant.
