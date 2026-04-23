# Test complex — priority field on deals (2026-04-22 evening)

**Session log** : [chat-logs/session-2026-04-22T15-30-33-266Z.jsonl](../chat-logs/session-2026-04-22T15-30-33-266Z.jsonl)

**Prompt utilisateur** : *"add a 'priority' field (low/medium/high) to the deals entity, shown in the edit form and the deal card"*

**Contexte** : premier test complexe end-to-end après stabilisation (fix hooks scopés /worktrees/ uniquement, fix permissions /app/docs via entrypoint chown, unification simple+complex path, named volume pour crm-docs).

---

## Verdict

**Réussite complète** : 2 tickets mergés, zero pollution de master, zero scope violation, feature visible dans le CRM. Par rapport au test régression précédent (couleur + tiktok, 43 min, 0 ticket mergé, $6.52) : **même budget temps, full delivery**.

- **Durée totale** : 22 min 12 s (15:31:30 → 15:53:42)
- **Coût** : $3.90
- **Tickets mergés** : 2/2 (TASK-001 données, TASK-002 UI)
- **Workflow exercé** : planner → dev(opus) → reviewers → dev(sonnet) fix → reviewers round 2 → merger → dev(opus) → reviewers → merger

---

## Chronologie détaillée

| UTC | Δ | Acteur | Action | Notes |
|---|---|---|---|---|
| 15:30:49 | 0 | user | QUICK_EDIT | |
| 15:31:05 | +16s | orchestrator | *"Bonjour ! Qu'est-ce que vous souhaitez modifier..."* | FR, plain language ✅ |
| 15:31:30 | +25s | user | Request : priority field | |
| 15:31:45 | +15s | orchestrator | *"C'est une modification qui touche plusieurs parties..."* | Classifie complex ✅ |
| 15:31:49 | +4s | orchestrator | *"Je m'en occupe — je planifie d'abord..."* | |
| 15:32:12 | +23s | → planner (sonnet) | Dispatch | Durée : 1m 07s |
| 15:33:19 | | orchestrator | *"La planification est faite : deux étapes, la première pour les données, la deuxième pour l'affichage."* | 2 tickets créés ✅ |
| 15:33:25 | | orchestrator | *"Je lance la première étape — mise en place des données."* | |
| 15:33:26 | | orchestrator | TeamCreate `ticket-TASK-001` | |
| 15:33:31 | | → developer (opus) | TASK-001 (data layer) | Durée : 4m 14s |
| 15:37:45 | | orchestrator | *"La première étape est implémentée. Je vérifie que tout est correct."* | |
| 15:37:49 | +4s | → quality-reviewer (sonnet) | Review TASK-001 | verdict : BLOCKED (1 issue) |
| 15:37:52 | +3s | → test-validator (haiku) | Validate TASK-001 | ⚠️ **pas parallèle** — 2 messages assistant séparés |
| 15:39:27 | | orchestrator | *"Un point à corriger avant de continuer — je m'en occupe."* | |
| 15:39:32 | | → developer (**sonnet**) | Fix TASK-001 | Switch model pour fix léger ✅ |
| 15:42:09 | | orchestrator | *"Je re-vérifie après correction."* | |
| 15:42:13 | | → quality-reviewer (sonnet) | Review round 2 | verdict : APPROVED |
| 15:42:15 | +2s | → test-validator (haiku) | Validate round 2 | idem, 2 messages séparés |
| 15:43:31 | | orchestrator | *"Les deux vérifications sont validées. Je finalise la première étape."* | |
| 15:43:33 | | → merger (haiku) | Merge TASK-001 | Durée : ~30s |
| 15:44:06 | | orchestrator | TeamDelete + *"Parfait, la première étape est intégrée. Je lance maintenant la deuxième étape..."* | |
| 15:44:07 | +1s | orchestrator | TeamCreate `ticket-TASK-002` | |
| 15:44:15 | +8s | → developer (opus) | TASK-002 (UI) | Durée : 6m 21s |
| 15:50:36 | | orchestrator | *"Implémentation terminée. Je vérifie tout en parallèle."* | "parallèle" est un abus, voir plus bas |
| 15:50:40 | | → quality-reviewer (sonnet) | Review TASK-002 | APPROVED |
| 15:50:43 | +3s | → test-validator (haiku) | Validate TASK-002 | APPROVED |
| 15:52:59 | | orchestrator | *"Tout est validé. Je finalise la deuxième étape."* | |
| 15:53:00 | | → merger (haiku) | Merge TASK-002 | |
| 15:53:38 | | orchestrator | TeamDelete | |
| 15:53:42 | | orchestrator | Message final complet et clair (voir plus bas) | |
| 15:53:43 | | status | working=false | |

**Durée par phase** :
- Planner : 1 min 07 s
- TASK-001 data layer (dev + reviews + fix + reviews + merge) : 10 min 42 s
- TASK-002 UI (dev + reviews + merge) : 9 min 23 s

---

## Ce qui a bien fonctionné ✅

### 1. Messages user-facing parfaits

Tous les messages envoyés à l'utilisateur respectent la règle "plain language" :
- *"C'est une modification qui touche plusieurs parties du CRM"* — pas "complex"
- *"La planification est faite : deux étapes, la première pour les données, la deuxième pour l'affichage"* — pas "planner", pas "tickets", pas "TASK-001/002"
- *"Un point à corriger"* — pas "BLOCKED", pas "quality-reviewer found issues"
- *"Les deux vérifications"* — référence implicite aux 2 reviewers, sans les nommer
- *"Je finalise"* — code pour "merger", intuitif

**Message final** (user sees this in chat) :
> *"C'est fait ! Le champ Priorité (basse / moyenne / haute) a été ajouté aux affaires :*
> - *Un menu déroulant apparaît dans le formulaire de création et d'édition d'une affaire*
> - *Un badge coloré (gris / bleu / rouge) s'affiche directement sur chaque carte du tableau Kanban*
> - *Les données de démonstration..."*

Zero path, zero command, zero "TASK-" leak, zero "Supabase/React/etc." leak. **Exactement ce qu'on veut.**

### 2. Workflow complet respecté

Séquence observée identique au flow documenté dans [agent-team/SKILL.md](../claudeConfig/.claude/skills/agent-team/SKILL.md) :
```
TeamCreate(ticket-TASK-001)
  → developer(opus)
  → quality-reviewer + test-validator
  → [BLOCKED] → developer(sonnet) fix → reviewers round 2 → APPROVED
  → merger(haiku)
  → TeamDelete
```
Puis idem pour TASK-002. **Aucun agent sauté, aucun loop infini, aucun merger oublié.**

### 3. Worktree scope parfaitement respecté

Analyse programmatique des 104 Bash calls du session log :
- **82 calls** préfixés `cd /worktrees/...` ou `git worktree add ...` ✅
- **0 calls** avec `cd /app` depuis un subagent (hors merger qui doit opérer dans /app pour merger) ✅
- **22 calls** sans path (grep, ls, git status sans cd) — acceptables, opérations read-only

**0 violation de worktree-scope**. Les règles de [rules/worktree-scope.md](../claudeConfig/.claude/rules/worktree-scope.md) et les hooks scopés au `/worktrees/*` ont tenu.

### 4. Modèles routés correctement

| Agent | Modèle | Usage | Appropriation |
|---|---|---|---|
| planner | sonnet (default) | 1 dispatch | ✅ |
| developer TASK-001 initial | opus | implémentation complexe | ✅ |
| developer TASK-001 fix | **sonnet** | correction légère suite à review | ✅ orchestrator a downgradé automatiquement |
| developer TASK-002 | opus | UI implémentation | ✅ |
| quality-reviewer × 3 | sonnet | review sémantique | ✅ |
| test-validator × 3 | haiku | validation rapide | ✅ |
| merger × 2 | haiku | merge mécanique | ✅ |

**Routage modèle cohérent avec les coûts**. Le switch opus→sonnet pour le fix du dev est une optimisation qu'on n'avait pas explicitement demandée — c'est sonnet (orchestrator) qui a décidé, bonne décision émergente.

### 5. Clean merge history

```
a87be24 feat(TASK-002): Display and edit priority field...     ← merger TASK-002
20d7d37 feat(TASK-002): show priority badge on deal Kanban     ← dev TASK-002 commit 2
4c2ccff feat(TASK-002): add priority SelectInput to deal form  ← dev TASK-002 commit 1
a303c4a feat(TASK-001): Add priority field to Deal type...     ← merger TASK-001
c166876 fix(TASK-001): make priority optional on Deal type...  ← dev TASK-001 fix
ae24eae feat(TASK-001): add priority field to Deal type...     ← dev TASK-001 initial
a4ce037 Initial commit
```

Chaque commit tagué `(TASK-XXX)`, merger commits identifiables, historique lisible. Worktrees + branches supprimés à la fin.

### 6. Infrastructure clean

- `/worktrees/` vide après le run ✅
- Pas de branches feature orphelines ✅
- `/app/src/...` aucun fichier modifié (pas de pollution base branch) ✅
- 2 ticket JSONs écrits dans `/app/docs/tickets/` ✅

---

## Ce qui peut être amélioré 🟠

### 1. Parallélisme reviewers toujours KO (régression persistante)

Extraction : **0 message assistant avec plusieurs `tool_use` blocks**. Chaque Agent/TeamCreate est émis dans son propre tour.

Exemples concrets de dispatches qui devraient être parallèles mais ne le sont pas :
- 15:37:49 quality-reviewer → 15:37:52 test-validator (3s d'écart = 2 turns séparés)
- 15:42:13 quality-reviewer → 15:42:15 test-validator (2s = 2 turns)
- 15:50:40 quality-reviewer → 15:50:43 test-validator (3s = 2 turns)

**Coût observable** : les reviewers attendent quand même la fin du turn précédent pour démarrer, perdant 5-15s par cycle. Sur 3 cycles, ~30s perdues. Pas catastrophique, mais c'est de la latence gratuite.

La règle dans [chat-orchestrator.md](../claudeConfig/.claude/agents/chat-orchestrator.md) avec les exemples ✅/❌ n'est pas respectée par sonnet. **Piste** : peut-être qu'il faut que le prompt orchestrator mentionne explicitement les deux tools dans un BULLET LIST et demande de les émettre dans une tool array, pas juste "in the same message".

### 2. Reflections jamais écrites

`/app/docs/reflections/` est vide à la fin. Mode 2 de [developer.md](../claudeConfig/.claude/agents/developer.md) dit :

> *"After all reviews are complete: 1. Invoke `Skill({ skill: "reflection-writing" })` as your first tool call in Mode 2..."*

Le developer est supposé écrire `docs/reflections/TASK-XXX-reflection.md` après review + avant merge. **Ça n'a pas été fait** pour TASK-001 ni TASK-002.

Cause probable : l'orchestrator dispatche directement merger après review APPROVED, sans re-dispatcher developer en Mode 2. [SKILL.md:56](../claudeConfig/.claude/skills/agent-team/SKILL.md#L56) dit bien :

> *"All APPROVED: → DEVELOPER (mode: reflection) writes docs/reflections/TASK-XXX-reflection.md → MERGER..."*

**L'orchestrator saute l'étape reflection**. Pas grave pour le run lui-même, mais c'est perdre la capitalisation — les reflections sont destinées à être lues par les dev futurs pour éviter de re-trébucher sur les mêmes cailloux.

**Fix à envisager** : renforcer dans chat-orchestrator.md "AVANT merger, dispatch developer en Mode 2 reflection". Ou rendre la reflection directement intégrée au merger.

### 3. Fichier temp orphelin

```
$ ls /app/docs/tickets/
TASK-001.json
TASK-002.json
TASK-002.json.tmp   ← 0 octet, orphelin
```

Le developer TASK-002 a créé un fichier `.tmp` via un Bash `cat > /tmp/task-002-update.json` puis n'a pas nettoyé. Violation mineure de [developer.md](../claudeConfig/.claude/agents/developer.md)'s "HARD RULE" (File editing doit passer par Edit/Write tool, pas Bash redirection).

**Fix** : hook PreToolUse qui bloque `cat > *`, `echo > *`, `>> *` avec exit 2 + message "use Edit/Write tool".

### 4. 889 lignes de log pour 2 tickets

Le session log fait 877 Ko pour une demande de ~30 mots. C'est raisonnable (streaming JSON verbose), mais les "debug_raw" events doublent le volume. Si on ne debug pas une session, on pourrait filtrer côté server.js.

---

## Comparaison avec les tests précédents

| Métrique | Round 1 fail (couleur+tiktok) | Round 2 simple (Hot Contacts→My Friends) | **Ce run (priority)** |
|---|---|---|---|
| Type | Complex | Simple | **Complex** |
| Durée | 43 min | 3 min 33 s | **22 min 12 s** |
| Coût | $6.52 | $0.27 | **$3.90** |
| Tickets prévus | 2 | 1 | **2** |
| Tickets mergés | 0 | 1 | **2** |
| Reviewers dispatchés | sans parallélisme | N/A (simple skippe) | sans parallélisme |
| Merger | jamais | ✅ | ✅ × 2 |
| /app pollué | ✗ 20 fichiers | ✅ propre | ✅ propre |
| Worktrees orphelins | 1 | 0 | 0 |
| Message user final | contenait paths + bash | clean | **parfaitement clean** |

---

## Leçons

1. **Le flow est maintenant fiable sur complex**. Ce run est une baseline stable pour évaluer les optimisations futures.
2. **La classification "deux étapes : données + affichage"** est une décomposition naturelle pour ce genre de feature. Le planner a bien fait son job.
3. **Le fix-en-sonnet après BLOCKED** est une bonne optimisation émergente : pas besoin d'opus pour corriger une doc manquante ou un import oublié.
4. **Le parallélisme des reviewers reste un objectif non atteint** — à creuser côté prompt engineering du chat-orchestrator, ou accepter que sonnet ne fera pas.
5. **La reflection est skipée par défaut** — à renforcer si on veut exploiter cette capitalisation.
6. **22 min / $3.90 pour un ticket complex "priority field"** est raisonnable. La question économique devient : est-ce que ça vaut $3.90 pour l'utilisateur Pro ? Pour un vrai user non-technique qui ne saurait pas le faire à la main en moins d'une heure, oui.

---

## Prochains tests suggérés

1. **Tester un ticket BLOQUÉ non trivial** (ex: erreur typecheck réelle, pas juste "manque un test") → voir comment le dev+reviewer loop se comporte au-delà d'une itération
2. **Tester un ticket avec migration SQL** en mode full — exercer merger + SubagentStop hooks sur Supabase
3. **Tester deux demandes user consécutives** (même session, pas de down) — valider que les tickets n'interfèrent pas, que `/app/docs/tickets/` accumule correctement
4. **Tester un kill/interrupt** mid-work — valider que l'orchestrator gère la reprise (pas encore implémenté côté server.js)
