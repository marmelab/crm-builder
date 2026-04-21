# Test 4 Round 2 — medium-new-field (2026-04-21) — Chronologie forensique

**Session log** : [chat-logs/session-2026-04-21T12-39-47-045Z.jsonl](../chat-logs/session-2026-04-21T12-39-47-045Z.jsonl)
**Prompt utilisateur** : *ajoute dans companies un critère d'importance par rapport à mon business (très lié, lié, neutre, lointain). Il doit être éditable et filtrable*
**Mode** : QUICK_EDIT (demo / FakeRest)
**Wall time** : 31 min 10 s (12:39:47 → 13:10:57 UTC)
**Coût réel** : **$8.05** (dernier `total_cost_usd` du stream)
**Tickets créés** : TASK-006..008 (3 au lieu de 5 comme round 1)
**Phases exercées** : 15 (hooks) · 17 (rewake) · 18 (files_to_modify + coarse-over-fine + mandatory skill) · 19 (prettier hook + reflection skill) · 20 (model routing)

---

## Chronologie des dispatches

| Start UTC | Δ | Agent (model) | Travail | ID |
|-----------|-----|---------------|---------|-----|
| 12:42:01 | **1m54s** | planner (sonnet) | 3 tickets + project-context + files_to_modify populé partout | gkeGeef1 |
| 12:44:12 | **4m55s** | developer (**opus**) | TASK-006 — Deal type + FakeRest seed + dealPriorities config | 2KpR6Kdi |
| 12:49:27 | 46s | quality-reviewer (sonnet) | Review TASK-006 | reXJcRD1 |
| 12:49:31 | 1m13s | test-validator (haiku) | Validate TASK-006 | P64dBVP8 |
| 12:51:05 | **6m02s** | developer (**opus**) | TASK-007 — Form + i18n (en+fr) | 25N3W9z6 |
| 12:57:21 | 55s | quality-reviewer (sonnet) | Review TASK-007 | h9DSPryT |
| 12:57:24 | 1m39s | test-validator (haiku) | Validate TASK-007 | LdTUFumn |
| 12:59:19 | **9m35s** 🔥 | developer (**opus**) | TASK-008 — Filter + e2e spec + reflection | 21TFEqCt |
| 13:09:05 | 1m00s | quality-reviewer (sonnet) | Review TASK-008 | wUC4Hc8C |
| 13:09:08 | 1m28s | test-validator (haiku) | Validate TASK-008 | GkVGBAdK |

### Top 3 étapes les plus longues
1. **dev-TASK-008 → 9m35s** — 27 Read + 16 Bash + 10 Grep + 5 Edit + 3 Skill + 2 Glob + 2 Write. Charge la plus lourde des 3 dispatches car inclut : filter component + e2e spec (nouvelle) + reflection. Les 3 skills (frontend-dev, e2e-conventions, reflection-writing) ajoutent ~20 s de latence mais correspondent à l'intention de Phase 18/19.
2. **dev-TASK-007 → 6m02s** — 15 Read + 8 Edit + 7 Grep + 7 Bash + 2 Write. Traduit en 2 langues (en + fr) + crée un helper `getTranslatedCompanyImportanceLabel.ts` → expansion naturelle du scope.
3. **dev-TASK-006 → 4m55s** — 13 Edit + 11 Read + 11 Bash + 2 Grep. Data layer (type + config + FakeRest seed). Beaucoup de Bash (probablement typecheck intermédiaires avant le hook final).

---

## Comptage par type

| Métrique | Valeur |
|----------|--------|
| Total events | 863 |
| Messages user | 2 (QUICK_EDIT + prompt) |
| Agent tool calls | 10 (planner 1, developer 3, quality-reviewer 3, test-validator 3) |
| Dispatches parallèles (même assistant message) | **0** (reste une dette) |
| Skill invocations | 4 : `agent-team` (orchestrator) + `frontend-dev` + `e2e-conventions` + `reflection-writing` (tous dans dev-TASK-008) |
| Fichiers code édités (uniques) | 10 src/ + 1 e2e + 3 tickets + 2 reflections |
| Hook batches fired | 3 (après chaque dev stop) |
| Hook EXIT=2 (rewake) | 0 |
| `stop-hook-error` | 0 |

### Fichiers édités par ticket

| Ticket | Fichiers code (hors ticket/reflection) |
|--------|----------------------------------------|
| TASK-006 | `types.ts`, `root/ConfigurationContext.tsx`, `root/CRM.tsx`, `root/defaultConfiguration.ts`, `providers/fakerest/dataGenerator/companies.ts` |
| TASK-007 | `companies/CompanyAside.tsx`, `companies/CompanyInputs.tsx`, `companies/getTranslatedCompanyImportanceLabel.ts` *(nouveau)*, `providers/commons/englishCrmMessages.ts`, `providers/commons/frenchCrmMessages.ts` |
| TASK-008 | `companies/CompanyListFilter.tsx`, `e2e/companies-importance.spec.ts` *(nouveau)* |

---

## Skills : 1/3 developers les ont invoquées

| Dispatch | Skills invoquées |
|----------|-----------------|
| dev-TASK-006 (data layer, types) | ❌ aucune — probablement considéré trop simple par l'agent malgré le MANDATORY FIRST ACTION |
| dev-TASK-007 (form + i18n) | ❌ aucune — même problème, alors que `frontend-dev` serait pertinent |
| dev-TASK-008 (filter + e2e + reflection) | ✅ `frontend-dev` + `e2e-conventions` + `reflection-writing` |

**Observation** : la MANDATORY FIRST ACTION de developer.md est suivie quand l'intention est claire (e2e + reflection dans TASK-008), mais ignorée pour les tickets "purement code" où l'agent estime pouvoir se passer du pattern-loader. Règle à durcir si on veut 3/3.

---

## Hooks : parfaitement silencieux

3 batches, timestamps approximatifs :
- ~12:48:00 — après dev-TASK-006 → typecheck/prettier/unit-app/unit-fn tous exit 0
- ~12:56:00 — après dev-TASK-007 → idem
- ~13:08:00 — après dev-TASK-008 → idem

Aucun exit 2, aucun rewake déclenché. Le code produit par les 3 dev dispatches typecheck d'emblée, prettier d'emblée, tests passent. Contre-exemple direct au round 1 (TASK-003fix, 2m54s perdu).

---

## User-facing messages (review)

Messages envoyés au chat UI pendant le run :

| Timing | Contenu | Verdict |
|--------|---------|---------|
| — | "What would you like to change?" | ✅ |
| — | "C'est une modification complexe — je vais planifier et coordonner ça proprement." | ✅ |
| — | "Je m'en occupe, je commence par analyser votre demande et créer un plan de travail." | ✅ |
| — | "Le plan est prêt : 3 étapes. Je commence la réalisation." | ✅ |
| — | "Je lance la première étape (couche données)." | 🟠 "couche données" est technique — le user ne comprend probablement pas |
| — | "Je lance les vérifications en parallèle." | ✅ |
| — | "**TASK-006 approuvé**. Je passe à la deuxième étape : le formulaire d'édition." | ❌ **"TASK-006" est interdit** (technical identifier) |
| — | "Les avertissements **LinkedIn** sont pré-existants et sans rapport. Je lance les vérifications de **TASK-007**." | ❌ "TASK-007" interdit + "LinkedIn avertissements" trop technique |
| — | "**TASK-007 approuvé**. Je lance la dernière étape : les filtres." | ❌ "TASK-007" interdit |
| — | "C'est fait ! J'ai ajouté le critère d'importance..." | ✅ Message final propre |

**À corriger** dans [chat-orchestrator.md](../claudeConfig/.claude/agents/chat-orchestrator.md) : renforcer l'interdiction d'exposer les IDs de ticket (TASK-XXX). Préférer "l'étape 1", "l'étape 2", "l'étape finale" dans les messages user.

---

## Comparaison vs Round 1

| Métrique | Round 1 | Round 2 | Δ |
|----------|---------|---------|---|
| Durée | 35 min | **31 min** | -11% 🟢 |
| Coût | $11.22 | **$8.05** | -28% 🟢 |
| Tickets | 5 | **3** | -40% 🟢 |
| Dispatches Agent | 14 | **10** | -29% 🟢 |
| Skills invoquées | 0 | **4** | +∞ 🟢 |
| `stop-hook-error` | 6 | **0** | -100% 🟢 |
| Round developer-fix | 1 (TASK-003fix) | **0** | -100% 🟢 |
| Fichiers `files_to_modify` dans tickets | 0 | **9 total** (4+4+1) | +∞ 🟢 |

---

## Pistes d'amélioration encore ouvertes

1. **Zéro dispatch parallèle** — quality-reviewer et test-validator restent émis en 2 messages assistant successifs (3-4s d'écart), pas dans un batch. Identifié Phase 14, non adressé.
2. **Skills non invoquées sur TASK-006 et TASK-007** — 2/3 developers sautent la MANDATORY FIRST ACTION quand ils estiment la tâche "trop simple". Sonnet/Opus jugent différemment peut-être.
3. **User-facing messages leaks** — "TASK-006 approuvé" etc. font leaks d'IDs techniques. Fix dans chat-orchestrator.md.
4. **dev-TASK-008 à 9m35s** — 27 Reads est beaucoup même pour un ticket filter+e2e. Piste : préloader le skill avant le Read burst via instruction explicite dans le prompt du dispatch orchestrator.
5. **Stats compteur** — coût affiché $103 au lieu de $8 (bug accumulation `+=` sur `total_cost_usd` cumulatif). Tokens 2.2M dominé par cache_read répété, peu informatif pour l'utilisateur. À corriger côté server.js + chat.js.
