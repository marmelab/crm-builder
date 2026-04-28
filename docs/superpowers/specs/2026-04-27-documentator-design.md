# Documentator — Design (Phase 1)

**Date** : 2026-04-27
**Status** : Spec draft, à valider
**Auteur** : Jerome (avec assistance Claude)

## Contexte

L'équipe agentique du CRM-builder produit aujourd'hui des `reflections` post-implémentation (skill `reflection-writing`, écrites par DEVELOPER dans `docs/reflections/TASK-XXX-reflection.md`). Ces reflections sont **lues uniquement par DEVELOPER** avant les futures implémentations dans le même domaine.

C'est une boucle fermée et limitée :
- Seul DEVELOPER bénéficie des leçons (pas planner, architect, reviewer)
- Le format est narratif par ticket, **non agrégé** : si le même problème apparaît 7 fois, on a 7 reflections distinctes, jamais de synthèse
- Les signaux objectifs (échecs de hooks, retries d'agents, frictions inter-agents, friction côté user) ne sont **jamais analysés**
- Aucun mécanisme ne détecte de pattern récurrent ni n'argumente pour un changement structurel

Ce document décrit la **phase 1** d'un système qui comble ce manque : un agent `documentator` qui observe l'activité de l'équipe, détecte des patterns récurrents, et produit un rapport structuré pour le mainteneur.

## Goal de la phase 1

Construire un **synthétiseur read-only** qui :

1. Lit 5 sources de signaux objectifs (détaillées plus bas)
2. Détecte les patterns récurrents (friction qui revient avec la même signature)
3. Maintient un ledger `docs/learnings/patterns.md` avec compteurs et evidence trail
4. Pour chaque pattern, propose une action **suffisamment spécifique pour être appliquée verbatim** (mais ne l'applique pas)
5. Tourne quotidiennement via cron, en s'auto-skippant si aucune nouvelle activité

Le mainteneur lit le ledger et juge la qualité des détections **et** des actions proposées. Cette phase sert à calibrer la confiance avant de passer à la phase 2 (acting).

## Out of scope (phase 2 et au-delà)

- **Application des actions proposées** : aucune mutation de `claudeConfig/.claude/` en phase 1, ni création de hook/rule/skill, ni commit. Les actions sont décrites dans `patterns.md` mais pas exécutées.
- **Lecture de `patterns.md` par d'autres agents** : `patterns.md` est destiné à un **lecteur humain**. Aucun agent (planner, architect, developer, reviewer) ne le charge dans son contexte. Évite token bloat et risques de contradiction avec leurs instructions.
- **Promotion vers le repo upstream Marmelab** : exclu. En production, chaque déploiement client diverge sur son propre fork.

Note importante : les modifications d'agent prompts ne sont **pas** out-of-scope. Elles sont traitées comme les autres types d'action en phase 2, avec simplement un seuil de compteur plus élevé. Le blast radius d'un prompt edit est plus grand qu'une règle (plus de texte, plus d'interactions possibles), mais la nature de l'action est la même : modifier un texte qui influence un comportement. Pas de raison de les bannir indéfiniment.

## Sources analysées

Le documentator lit ces 5 sources à chaque run :

| Source | Path | Extraction |
|---|---|---|
| Reflections | `/app/docs/reflections/*.md` | Friction auto-rapportée par DEVELOPER, thèmes récurrents |
| Hook logs | `/chat-service/logs/hooks.log` (cf. `chat-service/server.js:259`) | Hooks qui bloquent un handoff, fréquence par hook et par agent |
| Session logs | `/chat-service/logs/<session>/log.jsonl` | Retries détectés par les heuristiques de `lib/stats.js` (suffix `(retry)`, triggered-by-error, descriptions consécutives proches) |
| Stats timeline | `lib/stats.js` (export d'une fonction réutilisable) | Top N phases longues, top N phases coûteuses, errors catégorisées |
| Frictions user | `/chat-service/logs/<session>/log.jsonl` (tours user) | Heuristiques : négations explicites ("non", "pas comme ça"), restatement (re-mention des mêmes nouns < N tours plus tard), ratio user-turns / merged-tickets élevé |

Pour chaque source, documentator extrait des **events** datés et signés (un identifiant stable du pattern : ex. `e2e-test-fail-after-migration`, `developer-retry-on-typecheck`, `user-reformulation-auth`).

Quand un event partage la signature d'un pattern existant dans `patterns.md`, le compteur s'incrémente. Sinon, un nouveau pattern est créé.

## Format de `docs/learnings/patterns.md`

Chaque entrée auto-contenue, idempotente à amender, structurée pour pouvoir être consommée par un humain ET par une future logique d'application :

```markdown
## P-007 — Tests e2e échouent car RLS non rechargée après migration

- **Status** : observed (phase 1 ne met jamais autre chose)
- **Occurrences** : 7
- **Premier vu** : 2026-04-12 (TASK-031)
- **Dernier vu** : 2026-04-25 (TASK-067)
- **Evidence** : TASK-031, TASK-044, TASK-052, TASK-058, TASK-061, TASK-065, TASK-067
- **Symptôme** : test e2e renvoie 403 sur endpoint protégé après ajout d'une policy
- **Hypothèse** : `supabase db reset` non relancé après modif de `supabase/migrations/*`

### Action proposée (non appliquée en phase 1)

- **Type** : new hook
- **Files Touched** :
  - `claudeConfig/.claude/hooks/learned-P007-check-rls-reset.sh` (created)
  - `claudeConfig/.claude/settings.json` (modified — section `hooks.PostToolUse`)
- **Depends on** : (aucun)
- **Trigger** : `PostToolUse` / `Edit` / `supabase/migrations/**`
- **Settings.json patch** :

  ```json
  {
    "hooks": {
      "PostToolUse": [
        {
          "matcher": "Edit",
          "hooks": [{"type": "command", "command": "/home/developer/.claude/hooks/learned-P007-check-rls-reset.sh"}]
        }
      ]
    }
  }
  ```

- **Contenu du script** :

  ```bash
  #!/bin/bash
  if grep -qiE "(POLICY|RLS)" "$CLAUDE_FILE_PATHS"; then
    echo "Reminder: run 'supabase db reset' before next test run." >&2
  fi
  ```

### Promotion criteria pour phase 2

- Occurrences ≥ 10
- Type d'action autorisé pour auto-apply au moment de la promotion
- Aucun pattern existant ne touche déjà au même fichier produit
```

**Champs obligatoires** d'une entrée :
- `Status` (toujours `observed` en phase 1)
- `Occurrences`, `Premier vu`, `Dernier vu`
- `Evidence` (liste de TASK-XXX ou session IDs)
- `Symptôme` (descriptif court)
- `Hypothèse` (cause supposée, peut évoluer)
- Une section `Action proposée` qui prend l'une des deux formes :
  - **Forme appliquable** : `Type` (skill-extension / new-hook / new-rule / new-skill / modify-existing / agent-prompt-edit), `Files Touched` (paths + created/modified), `Depends on` (autres P-XXX dont ce pattern dépend, vide si aucun), et le contenu directement applicable (script complet, JSON patch complet, ou diff sur fichier existant)
  - **Forme escalation** : `Type: escalation`, suivi d'une explication courte de pourquoi aucun levier additif ne capture le pattern

La forme escalation correspond à la 5e priorité de la hiérarchie discutée en brainstorming. Elle évite de forcer le documentator à inventer une règle bancale juste pour "produire quelque chose".

### Convention de naming et traçabilité

Documentator peut **créer** ou **modifier** des fichiers de config (hooks, rules, skills, agents). Les deux cas sont traités différemment pour la traçabilité :

**Pour les fichiers créés** par documentator, naming standard :
- `claudeConfig/.claude/hooks/learned-P007-check-rls-reset.sh`
- `claudeConfig/.claude/rules/learned-P012-validate-form-input.md`
- `claudeConfig/.claude/skills/learned-P018-handling-supabase-migrations/SKILL.md`

Le préfixe `learned-P<id>-` permet : identification visuelle immédiate de la provenance, lien direct vers l'entrée du ledger qui justifie le fichier, et nettoyage trivial si un pattern est retiré. On reste dans les dossiers Claude par défaut, pas de sous-dossier `learned/` séparé.

**Pour les fichiers modifiés** (un fichier existant — qu'il soit Marmelab-shipped ou produit par un pattern antérieur), pas de renommage. La modification est tracée dans l'entrée du pattern via le champ `Files Touched`.

**Champ `Files Touched`** : ajouté à chaque entrée du ledger, liste les paths que l'action toucherait :

```markdown
- **Files Touched** :
  - `claudeConfig/.claude/rules/learned-P007-rls-check.md` (created)
  - `claudeConfig/.claude/agents/developer.md` (modified, lines 42-58)
```

**Quand un nouvel event veut toucher un fichier déjà listé dans `Files Touched` d'un autre pattern**, deux cas :

1. **L'event est une variante du même pattern** (signature similaire, même symptôme générique) → documentator **amende l'entrée existante** : incrémente le compteur, étend l'evidence, raffine l'action si besoin. Pas de nouveau pattern. C'est le cas le plus fréquent — évite la duplication.

2. **L'event est un pattern distinct mais qui dépend d'un autre** → documentator crée une nouvelle entrée P-XXX **avec un champ `Depends on: P-007`** explicite. Cette dépendance est utilisée au moment du rollback.

**Rollback honnête** : on s'appuie sur git, pas de magie. `git revert <commit-de-P007>` enlève le fichier produit + l'entrée du ledger. Si un autre pattern P-012 dépend de P-007, soit on revert P-012 d'abord (chemin propre), soit le revert de P-007 produit un conflit que l'opérateur résout manuellement. Le champ `Depends on` rend la dépendance visible avant de tirer sur la gâchette.

Si documentator estime qu'un pattern existant est devenu obsolète (le symptôme a disparu pendant N runs consécutifs), il peut proposer un retrait via une nouvelle entrée `Type: retire-pattern, Target: P-007` plutôt qu'en éditant directement l'ancienne entrée.

## L'agent documentator

Fichier : `claudeConfig/.claude/agents/documentator.md`

Frontmatter (proposé) :

```yaml
---
name: documentator
description: Read-only synthesizer that detects recurring friction patterns across reflections, hooks, sessions and stats, and maintains the patterns ledger.
model: sonnet
tools: [Read, Write, Edit, Glob, Grep, Bash]
skills: []
---
```

**Modèle** : sonnet. Pas opus parce qu'il s'agit principalement de synthèse + edit ciblé sur un fichier markdown. Pas haiku parce qu'il faut du raisonnement pour identifier la signature d'un pattern et formuler une action proposée appliquable.

**Tools** : Write/Edit pour `patterns.md`, Read/Glob/Grep pour explorer les 5 sources. Bash réservé à un usage très étroit : `git log`, `git show` pour cross-référencer un commit avec un TASK-XXX au moment de la rédaction du ledger.

**Restriction Bash via hook** (en phase 1, pas attendre la phase 2) : un hook `PreToolUse / Bash` filtre les commandes de documentator par whitelist regex et bloque tout le reste. Trop de cas passés où un agent utilise Bash pour faire "tout et n'importe quoi" — on cadre dès le départ.

Whitelist proposée pour documentator :
- `^git log( |$)`
- `^git show( |$)`
- `^ls ` (lecture seule, pas d'options destructrices)
- `^wc -l `

Tout le reste est rejeté avec un message orientant vers Read/Glob/Grep. Hook : `claudeConfig/.claude/hooks/restrict-documentator-bash.sh`. Activé conditionnellement dans `settings.json` selon l'agent appelant (matcher `documentator`).

**Prose du prompt** : décrit le job, les 5 sources, les règles de signature, le format obligatoire d'une entrée, la hiérarchie des leviers du moins invasif au plus invasif (skill extension < new hook < new rule < new skill < modify existing < agent-prompt-edit, escalation comme porte de sortie quand aucun ne s'applique), la convention de naming `learned-P<id>-` pour les fichiers créés, le champ `Files Touched` et la logique d'amendement vs nouveau pattern vs `Depends on`, et l'interdiction explicite d'écrire dans `claudeConfig/.claude/` en phase 1 (read-only en phase 1, l'unique sortie est `docs/learnings/patterns.md`).

## Déclencheur : node-cron dans chat-service

Fichier modifié : `chat-service/server.js` (ou nouveau `chat-service/lib/documentator-cron.js` importé depuis server.js).

Mécanisme :

1. Au boot du chat-service, planification d'un cron quotidien (ex. `0 3 * * *`) via `node-cron`.
2. À chaque tick :
   - Vérifier l'activité depuis le dernier run (timestamp stocké dans `docs/learnings/runs/last-run.txt`).
   - Si aucune session terminée depuis le dernier run → log et skip.
   - Sinon : `child_process.spawn('claude', [...args])` avec le prompt du documentator (même mécanisme que le spawn user-driven existant).
   - Stream de la réponse loggué dans `docs/learnings/runs/YYYY-MM-DD-run.md` (audit trail).
   - Mise à jour de `last-run.txt` à la fin.
3. Endpoint `POST /api/documentator/run` qui déclenche le même flow manuellement (utile pour tester, et placeholder pour le futur trigger "session déployée en prod").

**Pas de daemon séparé**, pas de cron système, pas de programme supervisord supplémentaire. Coût d'ajout : ~30 lignes JS + une dépendance `node-cron`.

## Workflow complet

```
[supervisord] ──spawns──> chat-service
                              │
                              │ at boot:
                              ├──> node-cron schedules daily run
                              │
                              │ at 03:00 daily (or manual via /api/documentator/run):
                              ├──> check last-run.txt vs activity
                              │     if no activity since last run → skip
                              │     else:
                              ├──> spawn('claude', […documentator agent…])
                              │     │
                              │     ├── reads: reflections, hooks.log, session logs, stats, user friction
                              │     ├── extracts: events with stable signatures
                              │     ├── reads: docs/learnings/patterns.md
                              │     ├── for each event:
                              │     │     ├── matches existing pattern? increment counter
                              │     │     └── new signature? create new pattern entry
                              │     └── writes: docs/learnings/patterns.md
                              │
                              ├──> writes: docs/learnings/runs/2026-04-27-run.md (audit)
                              └──> updates: docs/learnings/runs/last-run.txt
```

## Validation criteria pour passer à la phase 2

La phase 1 est considérée comme validée quand, sur **3 runs consécutifs sans intervention sur le prompt du documentator** :

- ≥ 80% des patterns détectés sont confirmés comme étant de vrais patterns (pas du bruit, pas du faux positif)
- ≥ 70% des actions proposées sont jugées "j'aurais appliqué ça" par Marmelab
- Aucune contradiction détectée entre actions proposées par documentator et règles existantes du base config
- Le ledger reste lisible (pas d'explosion combinatoire, pas de patterns dupliqués sous des signatures différentes)

Si ces critères sont rencontrés, la phase 2 peut être planifiée.

## Phase 2 future — hooks de design

Pour ne pas se peindre dans un coin, la phase 1 prévoit déjà :

1. **Le compteur sert de gate naturel** — la phase 2 utilisera `Occurrences ≥ N` (probablement 10) avant d'auto-appliquer une action. Le ledger est déjà structuré pour ça.

2. **Les actions sont déjà appliquables verbatim** — le format `Action proposée` contient le contenu exact du script, le path, le patch settings.json. La phase 2 = "exécuter le bloc Action proposée", pas "re-dériver quoi faire".

3. **Promotion graduelle par type d'action** envisagée, du moins au plus risqué (donc seuils de compteur croissants) :
   - skill extension (modif d'une skill existante)
   - new hook
   - new rule
   - new skill
   - modify existing rule / hook / skill (Marmelab-shipped ou learned-)
   - agent-prompt-edit
   - Chaque catégorie a son propre seuil dans `settings.local.json`. Activation indépendante par catégorie, pas en bloc. Une catégorie peut rester en mode "propose only, requires human review" même quand les autres sont en auto-apply.

4. **Réversibilité par commit atomique** — chaque action de phase 2 = un commit git distinct, avec message standardisé `[documentator] apply P-XXX: <slug>`. `git revert <sha>` enlève le fichier produit (ou annule la modification) + l'entrée du ledger en un seul coup. Si une autre entrée a un `Depends on: P-XXX`, le revert peut produire un conflit : c'est rendu visible par le ledger, à l'opérateur de décider l'ordre de revert.

5. **Persistance et propagation des fichiers produits** — le mécanisme exact dépend du flow de déploiement client (qui n'existe pas encore). Pistes à arbitrer en temps voulu :
   - **Dev local** : `claudeConfig/.claude` est bind-mounté `:ro` aujourd'hui — il faudra retirer le `:ro` (au moins sur `hooks/`, `rules/`, `skills/`) pour que documentator puisse écrire en phase 2. Trade-off à assumer.
   - **Production client** : documentator commit dans le fork client (le repo qui sert de source de vérité au déploiement). Demande des credentials git dans le container.
   - Aucune décision en phase 1 — le scope phase 1 ne touche que `docs/learnings/`, donc la question ne se pose pas encore.

Ces 5 points ne sont **pas implémentés en phase 1** mais le format de `patterns.md` les rend triviaux à brancher.

## Open questions (à trancher avant phase 2, pas avant phase 1)

- Heuristiques de friction user : seuils exacts (combien de mots de "négation", combien de tours pour considérer une session comme frictionnelle) — à affiner à partir des données réelles produites par les premiers runs.
- En phase 2, où vivent les commits de documentator ? Overlay volume seulement ? Push vers le fork client ? Question à reposer quand le flow de déploiement client existera.

## Fichiers créés / modifiés en phase 1

- `claudeConfig/.claude/agents/documentator.md` (nouveau)
- `claudeConfig/.claude/hooks/restrict-documentator-bash.sh` (nouveau)
- `claudeConfig/.claude/settings.json` (modification : enregistrement du PreToolUse hook conditionnel sur agent=documentator)
- `chat-service/server.js` (modification : enregistrement du cron, endpoint manuel)
- `chat-service/lib/documentator-cron.js` (nouveau, ~50 lignes)
- `chat-service/package.json` (ajout dépendance `node-cron`)
- `docs/learnings/patterns.md` (créé vide initialement, populated par documentator)
- `docs/learnings/runs/.gitkeep`
- `docs/learnings/runs/last-run.txt` (créé au premier run, gitignored ou versionné selon préférence)
