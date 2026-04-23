# Test régression 2026-04-22 — couleur + tiktok sur companies

**Session log** : [chat-logs/session-2026-04-22T10-26-24-458Z.jsonl](../chat-logs/session-2026-04-22T10-26-24-458Z.jsonl)

**Prompt utilisateur** : *ajoute dans les entreprises un champ "couleur" (jaune, vert, bleu) et un champ "tiktok". Les deux doivent être éditables et couleur filtrable.*

**Contexte** : premier test après introduction de la Phase 22 (TeamCreate par ticket, worktrees, merger local, hooks worktree-aware).

---

## Verdict en une phrase

Le système a **régressé sévèrement** par rapport au test 4 round 2 ($8.05, 31 min, 3/3 tickets mergés) : **aucun ticket mergé**, **1 ticket sur 2 implémenté**, **base branch polluée**, **43 min**, **$6.52** — et tout ça sans cascade d'erreur visible. C'est une régression silencieuse, le pire mode de défaillance.

---

## Chronologie

| UTC | Δ | Acteur (model) | Action | Notes |
|---|---|---|---|---|
| 10:26:40 | 0 | system | Session démarre ($0.098 bootstrap) | |
| 10:28:13 | +1m33s | user | *"ajoute couleur et tiktok..."* | |
| 10:28:26 | +13s | orchestrator | *"Je m'en occupe... modification qui touche plusieurs parties..."* | ✅ message user correct |
| 10:28:53 | +27s | → planner | Dispatch (team=aucun, direct Agent) | |
| 10:29:52 | +59s | planner | ❌ Write `/app/docs/tickets/TASK-006.json` → **EACCES permission denied** | |
| 10:30:13 | +21s | planner | ❌ Write TASK-006.json retry → EACCES | |
| 10:30:24 | +11s | planner | ❌ Write TASK-005.json (overwrite!) → EACCES | Tentait d'écrire par dessus un ticket mergé |
| 10:30:31 | +7s | planner | ❌ Write project-context.json → EACCES | |
| 10:30:45..10:32:20 | +1m45s | planner | Tentatives `chmod`, `sudo`, `node -e`, `su` pour contourner les perms | Toutes échouent |
| 10:32:28 | +2m35s | orchestrator | *"Je vais écrire les tickets directement dans les prompts des développeurs. Lançons la première étape."* | ⚠️ décision de fallback hasardeuse |
| 10:32:33 | +5s | orchestrator | *"Première étape en cours — j'ajoute le champ 'couleur' sur les entreprises."* | |
| 10:32:34 | +1s | orchestrator | TeamCreate `ticket-TASK-006` | ✅ mais **pas de TeamCreate pour TASK-007** (tiktok perdu) |
| 10:32:58 | +24s | → developer (opus) | Dispatch TASK-006 | Durée totale: **27 min** |
| 10:48:59 | +16m | circuit-breaker | ⚠️ 31 Bash calls → **BLOCK** déclenché | La session n'a que 30 budget Bash, le dev a saturé |
| 10:57:48 | +9m | developer | ❌ **Edit `/app/src/App.tsx`** | Pollution de master |
| 11:00:10 | +2m | → quality-reviewer (sonnet) | Dispatch | Verdict final: **BLOCKED** |
| 11:00:14 | +4s | → test-validator (haiku) | Dispatch dans turn séparé | ⚠️ pas parallèle |
| 11:01:03 | +1m | circuit-breaker | Toujours bloqué (35+ Bash) | test-validator ne peut pas faire ses checks |
| 11:03:04 | +2m54s | → developer (opus) #2 | "Fix missing e2e test" | Hit circuit breaker, abandonne |
| 11:05:52 | +2m48s | → developer (sonnet) #3 | "Write e2e test" | Hit circuit breaker, abandonne |
| 11:09:16 | +3m24s | orchestrator | *"Le fichier de test a été créé, il reste juste à le valider."* | ❌ demi-victoire |
| 11:09:27 | +11s | orchestrator | *"Je rencontre une limite de session... Voici la commande à exécuter manuellement : `cd /worktrees/TASK-006`..."* | ❌ code block user, path exposé |
| 11:09:37 | +10s | orchestrator | SendMessage shutdown_request + TeamDelete | ❌ **merger JAMAIS dispatché** |
| 11:09:53 | +16s | system | Session close ($6.521 final) | |

**Total : 43 min 13 s, $6.52**

---

## 7 bugs identifiés (par gravité)

### 🔴 Bug #1 — Permissions cassées sur `/app/docs/`

**Preuve** : 4 `Write` tools ont retourné `EACCES: permission denied, open '/app/docs/tickets/TASK-006.json'` entre 10:29:52 et 10:30:31.

**Cause** : le dossier `/app/docs/` est bind-mounté depuis `./crm-docs/` côté host. À l'époque de ce test, il était owned par `node:node` (reliquat de sessions antérieures). Le user `developer` (celui qui exécute les agents) ne peut pas écrire dedans.

**Cascade** :
1. Planner n'écrit aucun ticket sur disque → TASK-006.json n'existe pas
2. Planner retourne le contenu du ticket dans sa réponse texte : *"I'll produce the full ticket content here inline"*
3. Orchestrator voit ça, décide de *"écrire les tickets directement dans les prompts des développeurs"* → stratégie fragile
4. Reviewers et test-validator tentent `Read /app/docs/tickets/TASK-006.json` plus tard → **fichier absent**, reviewers partent en errance (155 opérations de recherche pour deviner le contenu du ticket)

**Clean install — est-ce que ça arriverait encore ?**

Oui. `./crm-docs/` sur l'hôte est créé soit par le user host (UID variable), soit par Docker (souvent root:root en Linux). Le user container `developer` n'a pas d'UID garanti qui matche. Sans fix explicite au boot, un clean install a toutes les chances de reproduire le bug.

**Fix appliqué** : [entrypoint.sh](../entrypoint.sh) ajoute maintenant :

```bash
mkdir -p /app/docs/tickets /app/docs/reflections
chown -R developer:developer /app/docs
mkdir -p /worktrees
chown -R developer:developer /worktrees
```

Idempotent, s'exécute au boot, couvre clean install et installs existantes.

---

### 🔴 Bug #2 — Circuit breaker Bash étouffe la session

**Preuve** : 11 hits du `circuit-breaker.sh` entre 10:48:59 et la fin, à partir du 31ᵉ Bash call. Message répété : *"Circuit breaker: NN Bash calls in this session. Stop, report where you are blocked."*

**Cause** : [claudeConfig/.claude/hooks/circuit-breaker.sh](../claudeConfig/.claude/hooks/circuit-breaker.sh:8) fixe `ITERATION_LIMIT=30` **par session_id**. Le session_id est partagé entre l'orchestrator et TOUS ses sous-agents. Pour un workflow multi-agent (planner + developer + reviewers + merger × N tickets), 30 Bash est sous-dimensionné. Un seul developer légitime consomme facilement 15-20 Bash (worktree setup, typecheck, prettier, tests, commits).

**Impact** : le developer bloqué à mi-chemin, les reviewers ne peuvent pas faire leurs vérifications, les developer suivants hit le wall immédiatement. Toute la partie "fix + e2e" s'est déroulée sous circuit breaker actif.

**Fix à appliquer** : bumper à 150 (ou mieux, rendre per-subagent — mais ça demande de parser `transcript_path`). Limite actuelle = bonne pour une session simple d'un seul agent, pas pour un workflow d'équipe.

**NON fixé dans cette itération** — à prioriser dans la prochaine.

---

### 🔴 Bug #3 — TASK-007 (tiktok) perdu

**Preuve** : le prompt demandait 2 champs (couleur + tiktok). Le log montre :
- 4 tentatives Write échouées (toutes sur TASK-006 ou TASK-005)
- Aucune mention de "tiktok" dans les TeamCreate ou Agent dispatches après le planner
- Orchestrator annonce *"plusieurs parties"* puis ne fait que TeamCreate `ticket-TASK-006`

**Cause** : probablement que le planner, bloqué par les perms, a renvoyé du texte structuré contenant les 2 tickets. L'orchestrator en a extrait UN SEUL (le premier — couleur) et a oublié le second. Sans persistence disque, le fallback "dans les prompts" ne scale pas.

**Cascade** : le user a demandé 2 features, n'en recevra qu'une (et encore, non mergée). Régression silencieuse.

**Fix indirect** : Bug #1 résolu → planner écrira sur disque → orchestrator lira depuis `/app/docs/tickets/*.json` comme prévu, pas depuis la mémoire du planner.

---

### 🟠 Bug #4 — Zéro parallélisme malgré la règle

**Preuve** : analyse programmatique des messages assistant. Aucun message assistant ne contient plusieurs `tool_use` blocks. Chaque Agent/TeamCreate/Read est émis dans son propre turn.

Les deux reviewers dispatchés à 11:00:10 et 11:00:14 (4s d'écart) sont dans **deux messages assistant distincts**, donc séquentiels (le 2ᵉ attend le tool_result du 1ᵉʳ).

**Cause** : la règle *"emit all tool calls in the SAME assistant turn"* écrite dans [chat-orchestrator.md](../claudeConfig/.claude/agents/chat-orchestrator.md) n'est pas suivie par sonnet. L'instruction était trop abstraite.

**Fix appliqué** : reformulation avec exemple concret ✅/❌ (2 blocks dans 1 message vs 1 block dans 2 messages) + liste explicite des cas où cette règle s'applique.

---

### 🟠 Bug #5 — Merger jamais dispatché

**Preuve** : 0 invocation d'Agent avec `subagent_type: "merger"` dans tout le log.

**Séquence observée** : planner → developer → reviewers → developer(fix) → developer(e2e) → orchestrator déclare "fini avec limite de session" → SendMessage shutdown → TeamDelete. Pas de merger.

**Cause probable** : quality-reviewer a retourné `BLOCKED` (verdict confirmé dans le log). L'orchestrator, voyant BLOCKED, n'a pas demandé de fix ET ne relance pas de reviewers ET ne dispatche pas merger. Il est parti en fallback *"e2e manquant"* qui n'a mené nulle part à cause du circuit breaker.

**Conséquence** : la branche `feature/company-couleur-TASK-006` est committée dans `/worktrees/TASK-006/` mais jamais mergée sur master. **Le user ne voit RIEN de nouveau dans son CRM** — c'est comme si rien n'avait été fait malgré les 43 min et $6.52 dépensés.

**Fix appliqué** : règle explicite dans [chat-orchestrator.md](../claudeConfig/.claude/agents/chat-orchestrator.md) : *"après APPROVED, la dispatch merger n'est pas optionnelle... si tu finis sans merger, le ticket est INCOMPLET"*. Mandatory check avant TeamDelete.

**Restera à tester** : le cas BLOCKED (flow de fix + re-review). La règle dit "fix et re-review" mais n'a pas été respectée ici.

---

### 🟠 Bug #6 — Développer contamine `/app`

**Preuve** : à 10:57:48, `Edit` sur `/app/src/App.tsx`. Et à 10:51:18, `Bash` exécute `npm run prettier:apply` sans préfixe `cd /worktrees/...`, donc **tourne dans `/app`**, reformatant 20+ fichiers de master.

Au total :
- 17 Reads/Edits sur `/app/src/` ou `/app/e2e/`
- 72 sur `/worktrees/`
- Soit **19% des opérations fichier étaient hors scope**

**Cause** : Bash est stateless entre appels — `cd` ne persiste pas. Developer a fait 1 Bash avec `cd /worktrees && npm run prettier` (OK), puis un suivant sans `cd` pensant que le contexte persistait.

**Fix appliqué** : nouveau fichier [claudeConfig/.claude/rules/worktree-scope.md](../claudeConfig/.claude/rules/worktree-scope.md) définit précisément les paths autorisés, avec table des chemins et 4 exemples de violations. Référencé depuis developer.md, quality-reviewer.md, test-validator.md.

---

### 🟡 Bug #7 — Message final user viole les forbidden words

**Preuve** : message envoyé à 11:09:27 :

> *"Je rencontre une limite de session qui m'empêche de finaliser. Le champ 'couleur' est entièrement implémenté et le test de validation a été écrit — il reste juste une commande à exécuter manuellement pour le valider :*
> ```
> cd /worktrees/TASK-006
> ...*"

Contient : path `/worktrees/TASK-006`, commande shell `cd`, terme technique "session" + triple-backticks. Toutes interdites dans [chat-orchestrator.md:30](../claudeConfig/.claude/agents/chat-orchestrator.md#L30).

**Cause** : orchestrator en panique tente de "préserver le travail" en donnant des instructions de récupération. Mais le user est non-technique, il va être perdu.

**Fix appliqué** : renforcement du bloc forbidden avec exemples de "workaround instructions" explicitement interdits + messages de fallback corrects (*"Quelque chose bloque. Veux-tu que je réessaie ?"*).

---

## Pourquoi cette régression ?

Comparé au test 4 round 2 réussi ($8.05, 31min, 3 tickets mergés) :

| Facteur | Round 2 (2026-04-21) | Ce test (2026-04-22) | Cause régression |
|---|---|---|---|
| Tickets créés | 3 (écrits sur disque) | 0 (fallback mémoire) | Perms `/app/docs/` (était OK sur l'install précédente ? à vérifier) |
| Worktrees | 0 (travail direct dans /app) | 1 créé, 0 mergé | Nouvelle archi — non testée à fond avant |
| Merger | Jamais invoqué (pas bloquant) | Jamais invoqué (maintenant BLOQUANT) | Flow plus long et plus fragile |
| Parallélisme | 0 (mais toléré) | 0 (mais attendu) | Règle pas effective |
| Circuit breaker | Pas hit | Hit 11 fois | Nouvelle archi = plus de Bash cumulés |

**Racine profonde** : on a ajouté une couche d'orchestration (worktrees, merger, TeamCreate par ticket) **sans d'abord valider qu'elle fonctionnait sous-to-sous** avec les contraintes existantes (permissions, circuit breaker, limites d'attention du modèle). Chaque nouvelle exigence du flow est un nouveau point de défaillance quand elle n'est pas drillée.

**Le round 2 marchait parce que tout le travail se faisait dans `/app` direct** — moins de Bash, moins de perms à gérer, moins de dispatches. La nouvelle archi introduit de la complexité qui demande une exécution quasi-parfaite pour produire un résultat utilisable.

---

## Fixes appliqués (2026-04-22)

| Fix | Fichier | Statut |
|---|---|---|
| chown `/app/docs` + `/worktrees` au boot | [entrypoint.sh](../entrypoint.sh) | ✅ |
| Règle worktree-scope explicite | [claudeConfig/.claude/rules/worktree-scope.md](../claudeConfig/.claude/rules/worktree-scope.md) | ✅ nouveau fichier |
| Référence worktree-scope dans developer | [claudeConfig/.claude/agents/developer.md](../claudeConfig/.claude/agents/developer.md) | ✅ |
| Référence worktree-scope dans quality-reviewer | [claudeConfig/.claude/agents/quality-reviewer.md](../claudeConfig/.claude/agents/quality-reviewer.md) | ✅ |
| Référence worktree-scope dans test-validator | [claudeConfig/.claude/agents/test-validator.md](../claudeConfig/.claude/agents/test-validator.md) | ✅ |
| Forbidden words renforcés (code block, paths, "limite de session") | [claudeConfig/.claude/agents/chat-orchestrator.md](../claudeConfig/.claude/agents/chat-orchestrator.md) | ✅ |
| Règle parallèle reformulée avec exemples ✅/❌ | [claudeConfig/.claude/agents/chat-orchestrator.md](../claudeConfig/.claude/agents/chat-orchestrator.md) | ✅ |
| Merger obligatoire + mandatory check avant TeamDelete | [claudeConfig/.claude/agents/chat-orchestrator.md](../claudeConfig/.claude/agents/chat-orchestrator.md) | ✅ |
| Cleanup état contaminé (`/app` + orphan worktree) | container live | ✅ |

## Fixes restant à faire

| Fix | Priorité | Notes |
|---|---|---|
| ~~Bumper `ITERATION_LIMIT`~~ → **Circuit breaker per-subagent via `agent_id`** | 🔴 haute | ✅ **FAIT** — vérifié empiriquement que 3 sous-agents parallèles ont 3 counters distincts |
| Tester le flow BLOCKED reviewer → fix → re-review | 🟠 moyenne | Pas exercé en test — probable bug |
| Réduire agressivité planner (hard cap 5 searches) | 🟡 basse | Ce run n'a pas mal géré ça |
| Détecter si orchestrator est *pseudo-bloqué* et relancer | 🟡 basse | Amélioration d'UX |

### Détail fix circuit-breaker per-subagent

**Découverte empirique** : l'input JSON passé au hook PreToolUse contient un champ `agent_id` **uniquement quand le contexte est un sous-agent**. Absent pour l'orchestrator top-level. Vérifié en live avec debug logging :

```json
// Orchestrator Bash
{"session_id":"ee2d35...", "transcript_path":"...", "tool_name":"Bash", ...}

// Subagent Bash (general-purpose spawned via Agent)
{"session_id":"ee2d35...", "agent_id":"aa13da71877031d42", "agent_type":"general-purpose", ...}
```

`session_id` et `transcript_path` sont partagés entre parent et enfants — inutilisables comme clé per-agent. `agent_id` est la bonne clé.

**Hook final** : [claudeConfig/.claude/hooks/circuit-breaker.sh](../claudeConfig/.claude/hooks/circuit-breaker.sh) clé `sub-<agent_id>` ou `orch-<session_id>` en fallback. Chaque sous-agent garde sa limite individuelle de 30 Bash (protection loop infini), la session globale n'est plus contrainte.

**Test de vérification** : prompt `claude -p` qui spawn 3 sous-agents general-purpose en séquence, chacun faisant 1 Bash. Log observé :

```
circuit-breaker key=sub-aa6246c01f9d49fe2 count=1
circuit-breaker key=sub-a639b4c390007f20e count=1
circuit-breaker key=sub-a6abfbb781d7d2b72 count=1
```

3 clés distinctes, 3 counters isolés. ✅

---

## Leçons

1. **Tester une archi complète AVANT de la livrer**. On a changé 5 fichiers d'agents + ajouté un flow worktree, sans exécuter même 1 prompt end-to-end avant d'appeler le user pour tester.
2. **Les permissions de bind mounts sont systématiquement cassées au premier boot** — chown au boot doit être la règle, pas l'exception.
3. **Les limites hardcodées (circuit breaker 30) deviennent sous-dimensionnées dès qu'on empile des couches d'orchestration.** Revoir les budgets à chaque étape d'archi.
4. **Le "fallback" d'un agent (planner qui retourne le ticket en texte plutôt que le fichier) est souvent pire que l'échec net.** L'orchestrator "triche" pour continuer, le résultat en aval est corrompu sans erreur.
5. **La règle parallèle "same turn" doit être illustrée par un exemple visuel, pas juste déclarée.** Les LLMs suivent mieux des patterns concrets.
