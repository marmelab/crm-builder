# Session handoff — 2026-04-28 — Phase 6 detour + architectural pivot needed

**Branch:** `fix/agent-teams-real-communication` (9 commits ahead of origin/main).
**Container utilisé pour les tests:** `atomic-crm-validate` (image `atomic-crm-dev:validate-2026-04-28-agent-teams`, ports 6175/9082/7684, sessions dans `./sessions-validate/`).

## Ce qui est committé (Phases 0–5)

| # | Commit | Phase |
|---|---|---|
| 901adb8 | chore(devcontainer): add VSCode devcontainer setup | — |
| 2970429 | docs(superpowers): add Phase 0 validation findings | Phase 0 |
| a4669b0 | docs(superpowers): record Q1b deeper probe — W1 confirmed | Phase 0 |
| 79dfa34 | feat(skill): rewrite agent-team skill for peer-to-peer flow | Phase 1 |
| 227a14f | feat(agents): add SendMessage tool, align prompts with agent-team skill v2 | Phase 2 |
| 3a87b09 | feat(hooks): replace 5 SubagentStop hooks with one PreToolUse SendMessage gate | Phase 3 |
| f5c1803 | feat(chat-service): inject CLAUDE_SESSION_ID into the claude -p spawn env | Phase 4 |
| a8ff47b | fix(stats): index agent phases by task_id, group SendMessage-resume activations | Phase 5 |
| 6943bce → 0d0e8c3 | 4 commits de fix R-1/R-2/R-3 sur le skill | Phase 6 detour |

## Phase 6 partielle : ce qu'on a appris

### Régressions trouvées et fixées

- **R-1 (`name@team` rejected)** : ✅ fixé. SendMessage `to:` accepte bare names quand 1 seule team en scope, `name@team` requis pour multi-team. Skill et agents alignés.
- **R-2a (TeamDelete `{}`)** : ⚠️ fonctionne mais avec subtilité — accepté quand 1 seule team. Multi-team requiert `{team_name: "..."}` explicite.
- **R-2b (TeamDelete laisse `inboxes/`)** : ✅ confirmé via Phase 0 W1b. Bash rm `-rf .../teams/ticket-{TASK,task}-XXX` mandatory en safety net.

### Diagnostics du flow

- **`task_type: "in_process_teammate"`** : les agents tournent dans le MÊME process Claude que le lead, partagent son contexte.
- **Inboxes lifecycle** : `/home/developer/.claude/teams/<team>/inboxes/<member>.json` contient un array de messages. `read:true` → fichier supprimé par le runtime quand consommé. `read:false` → préservé en safety (ne perd pas de data).
- **Embryons** : ce sont les messages `read:false` (ex `shutdown_approved` du merger qui revient au team-lead mais que le lead n'a pas le temps de lire).
- **`<teammate-message>` blocks** : Phase 0 W1b a confirmé qu'ils sont délivrés au lead lors du turn suivant après yield. **Mais en mode `-p`, il n'y a pas de turn suivant** — d'où le hang qu'on a observé en run #7.

### LE finding critique : on n'est pas en vrai team-agent mode

Le runtime Claude Code injecte ce message dans le stream du lead quand un teammate va idle alors qu'on est en mode `-p` :

> "you're in non-interactive mode, you cannot return a response to the user until your team is shut down. Use requestShutdown to gracefully terminate teammates first."

**Cause** : `claude -p` est un spawn fini (single-prompt → single-response → exit). Le runtime sait que le process doit eventually terminer, donc force le wrap-up avant l'exit. Mais nos teammates async ont besoin de plus de temps que ça.

**Trigger** : confirmé par le claude-code-guide agent — ce n'est PAS le flag `-p` spécifiquement, c'est la combinaison "lead idle + teammates spawned + process en non-interactive mode". Le runtime enforce graceful team shutdown avant que le process puisse exit.

## Recommandation architecturale

Confirmé via consultation du claude-code-guide :

> **Agent teams in the CLI are experimental and designed for interactive terminal use (in-process or tmux split panes). For a programmatic chat service with real async team workflows, the Agent SDK is the production-ready pattern.**

→ Refondre [chat-service/lib/server/claude-spawn.js](../../chat-service/lib/server/claude-spawn.js) pour passer du `spawn('claude', ['-p', ...])` à `query()` du `@anthropic-ai/claude-agent-sdk`.

Ce qui carry-over (= toujours valide) :
- ✅ Skill v2 (protocole peer-to-peer)
- ✅ Agent definitions (developer, QR, TV, merger, orchestrator)
- ✅ PreToolUse / SendMessage hook validate-before-review
- ✅ Stats panel adaptation (task_id, activations bands)

Ce qui devient caduc :
- ❌ Phase 4 (`CLAUDE_SESSION_ID` injection) — SDK gère les sessions différemment
- ❌ Phase 3 hacks (TeamDelete + Bash rm + shutdown_request workarounds)
- ❌ Le mécanisme spawn-per-message de chat-service

## Décision proposée (pas encore validée)

**Option A** (mon vote) : commit l'état intermédiaire avec ce handoff, ouvre une nouvelle branche `feat/agent-sdk-migration` avec sa propre spec + plan. Phases 6 et 7 de la branche actuelle deviennent "n/a" (à valider sur la nouvelle branche).

**Option B** : finir Phase 6/7 sur la branche actuelle malgré les races, pivot SDK plus tard.

**Option C** : pivot SDK directement sur cette branche — gros élargissement de scope.

## Pour la prochaine session

1. Trancher A/B/C avec l'utilisateur
2. Si A : créer la branche `feat/agent-sdk-migration`, écrire spec + plan, commencer la refonte chat-service
3. Si A : ce branch-là devient "frozen" — préparer le PR pour les commits 901adb8 → 0d0e8c3 avec un body qui explique que c'est le 1er pas du pivot SDK
4. Documenter dans CLAUDE.md le fait qu'on est passé en SDK + nouveau workflow chat-service

## Container state (pour reprise)

Container `atomic-crm-validate` contient :
- Working tree de la branche au moment du build
- `/home/developer/.claude/teams/` peut avoir des orphelins de runs précédents : `quick-change-primary-color-green`, `test-multi`, `ticket-task-003`, `ticket-task-004` (anciens) + `ticket-TASK-001/002/003/005` (créés/effacés pendant les runs Phase 6)
- `/app` à jour : merge commits `f9b1211`, `6d04ea0`, `7742acb`, `847753f` (les 4 runs simple e2e ont effectivement merged)

## Sessions e2e produites (sessions-validate/)

| Session | Run | Outcome |
|---|---|---|
| 151970ae-... | run #1 simple (avant fix) | ✅ merge ; ❌ R-1 + R-2 broken |
| 7f3e049a-... | run #3 (R-1 fix) | ✅ merge ; ✅ R-1 ; ⚠️ R-2 wrong-case rm |
| 4a83fdf5-... | run #4 (dual-case fix) | ✅ merge ; ✅ R-1 ; ✅ rm correct ; ❌ team_dir leak (TeamDelete avant rm) |
| ddf454d4-... | run #5 (order fix TeamDelete→rm) | ✅ merge ; ✅ tout clean |
| 68bd8966-... | run #6 (capture inboxes) | ⚠️ embryo `team-lead.json` shutdown_approved unread |
| c2b84c2d-... | run #5b (re-verif) | ✅ clean |
| 7570c375-... | run #7 (graceful shutdown) | ❌ **hang** — yield-for-replies infini en `-p` mode |

## Coût total des runs

Estimé ~6-8 runs simple à $0.50-1 chacun = **~$5 d'API** sur ces explorations Phase 6.

---

**Pour rouvrir cette conversation dans Claude extension**, copie ce fichier en référence + lis les commits depuis 901adb8.
