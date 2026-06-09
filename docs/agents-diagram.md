# Agent Workflow Diagram

> **Legend** — applies to all diagrams below
> - 🔵 `([...])` stadium → **agent** (spawned subprocess)
> - 🟡 `{{...}}` hexagon → **hook** (auto-triggered by harness)
> - 🟣 `{...}` diamond → **decision**
> - 🟢 `([...])` green stadium → **chat-service** internal logic (not an agent)

---

## 1. Classification — entry point

Every user message enters here. First match wins.

```mermaid
flowchart LR
 
    classDef agent fill:#2563EB,stroke:#1E40AF,color:#fff
    classDef hook fill:#D97706,stroke:#92400E,color:#000
    classDef decision fill:#6D28D9,stroke:#4C1D95,color:#fff
 
    classDef terminal fill:#1F2937,stroke:#111827,color:#fff

 U([User User message]):::terminal --> C{Classify\nfirst match wins}:::decision

 C -->|intent:recovery| R1["-> #2 RECOVERY"]
 C -->|intent:rollback-conflict| R2["-> #3 ROLLBACK-CONFLICT"]
 C -->|intent:setup| R3["-> #4 SETUP"]
 C -->|mode-switch| R4["-> #5 MODE-SWITCH"]
 C -->|remember / document| R5["-> #6 MEMORY"]
 C -->|SIMPLE| R6["-> #7 SIMPLE path"]
 C -->|COMPLEX| R7["-> #8 COMPLEX path"]
```

---

## 2. RECOVERY

Triggered when chat-service injects `<intent>recovery</intent>` on resume (crash or usage limit).

```mermaid
flowchart TD
 
    classDef agent fill:#2563EB,stroke:#1E40AF,color:#fff
    classDef hook fill:#D97706,stroke:#92400E,color:#000
    classDef decision fill:#6D28D9,stroke:#4C1D95,color:#fff
 
    classDef terminal fill:#1F2937,stroke:#111827,color:#fff
 
    classDef promote fill:#059669,stroke:#065F46,color:#fff
    START([intent:recovery]):::terminal
 START --> INSPECT["Orchestrator reads disk\nls TASK-*.json\ngit log session-base..session/SID\nls worktrees/SID/ - git status per task worktree"]

 INSPECT --> CASE{Sub-case?}:::decision

 CASE -->|"no tickets\nno worktrees"| RETRY["Re-enter #1 classification\nwith original request"]

 CASE -->|">=1 ticket status != merged"| H_WIPE{{Pre/TeamCreate\nteamcreate-wipe-orphan.sh}}:::hook --> RC_TEAM["TeamCreate tickets-SID"]
 RC_TEAM --> RC_DISP["Re-dispatch for each non-merged ticket:\n- developer-TASK-XXX\n- quality-reviewer-TASK-XXX\n- test-validator-TASK-XXX\n+ merger (shared)\nGO prompt includes RESUME flag"]
 RC_DISP --> RC_WAIT["STATE C - passive wait\n(same as normal COMPLEX wave)\n-> #8 COMPLEX path from STATE C"]

 CASE -->|"all merged\nnot yet promoted"| RC_PROMOTE["Skip to Stage B\n-> #8 COMPLEX path from STATE D"]:::promote
```

---

## 3. ROLLBACK-CONFLICT

Triggered when `git revert` failed with a merge conflict. chat-service injects `<intent>rollback-conflict</intent>` with `BASE_BRANCH`, `FAILED_COMMIT`, `COMMITS_TO_REVERT`.

```mermaid
flowchart TD
 
    classDef agent fill:#2563EB,stroke:#1E40AF,color:#fff
    classDef hook fill:#D97706,stroke:#92400E,color:#000
    classDef decision fill:#6D28D9,stroke:#4C1D95,color:#fff
 
    classDef terminal fill:#1F2937,stroke:#111827,color:#fff
 
    classDef promote fill:#059669,stroke:#065F46,color:#fff
    START([intent:rollback-conflict]):::terminal
 START --> READ["Read turn payload\nBASE_BRANCH . FAILED_COMMIT . COMMITS_TO_REVERT"]

    H_START{{SubagentStart\nsetup-worktree.sh\ncreates worktrees/SID/simple + hard-links node_modules}}:::hook
 READ --> H_START

 H_START --> DEV(["simple-developer\nROLLBACK_CONFLICT mode"]):::agent
 DEV --> WORK["git revert -m 1 sha for each commit\nresolve conflicts manually\nworktrees/SID/simple"]

 WORK --> H_STOP
    H_STOP{{SubagentStop x 5\ntypecheck . prettier . unit-app . unit-fn . e2e\nblocks on failure}}:::hook

 H_STOP --> DIFF{supabase/\nin diff?}:::decision
 DIFF -->|yes| QR(["quality-reviewer - SIMPLE mode\nsingle-shot, no team"]):::agent
 DIFF -->|no| MG

 QR -->|APPROVED| MG
 QR -->|BLOCKED| DEV

 MG(["merger - ROLLBACK mode\nSubagentStart: setup-worktree.sh"]):::agent
 MG --> H_MG_STOP{{SubagentStop\ncleanup-worktree.sh}}:::hook --> SKIP["Stage A skipped\ngit merge --no-ff branch -> main directly\nsession/SID untouched\nflock /app/.promote.lock"]:::promote
 SKIP --> DONE(["DONE DONE - no POST-DEV\nsession rollback never triggers migration"]):::terminal
```

---

## 4. SETUP

Triggered on first turn with `<intent>setup</intent>` or natural-language "define my business".

```mermaid
flowchart TD
 
    classDef agent fill:#2563EB,stroke:#1E40AF,color:#fff
    classDef decision fill:#6D28D9,stroke:#4C1D95,color:#fff
 
    classDef terminal fill:#1F2937,stroke:#111827,color:#fff

    START([intent:setup]):::terminal
 START --> SKILL["Orchestrator calls Skill: setup-interview\nloads domain list + JSON schema + validation protocol"]

 SKILL --> LOOP["SETUP-INTERVIEW loop\nOrchestrator only - no agent dispatched\nReads & writes /app/docs/project-context.json\nAsks one domain at a time"]
 LOOP -->|"next turn: user answers\nordinate bounces any side-request"| LOOP
 LOOP -->|VALIDATED| PLAN(["planner\nSETUP_MODE=true\nreads project-context.json\nproduces scaffolding tickets"]):::agent

 PLAN --> TICKETS["Scaffolding tickets JSON\n(TASK-XXX . waves . file hints)"]
 TICKETS --> COMPLEX["-> #8 COMPLEX path from STATE B\n(same wave loop as a normal COMPLEX request)"]
 COMPLEX --> DONE(["DONE SETUP-DONE recap\nthen POST-DEV satisfaction widget\n-> #9 POST-DEV"]):::terminal
```

---

## 5. MODE-SWITCH

```mermaid
flowchart LR
 
    classDef terminal fill:#1F2937,stroke:#111827,color:#fff

    START([mode-switch request]):::terminal
 START --> BASH["Orchestrator - Bash only\nswitch demo <-> real data\nno agent dispatched"]
 BASH --> DONE(["DONE MS-DONE"]):::terminal
```

---

## 6. MEMORY / DOCUMENT

Two independent triggers — Mode 1 is orchestrator-driven, Mode 2 is chat-service-driven.

```mermaid
flowchart TD

    classDef agent fill:#2563EB,stroke:#1E40AF,color:#fff
    classDef decision fill:#6D28D9,stroke:#4C1D95,color:#fff
    classDef terminal fill:#1F2937,stroke:#111827,color:#fff
    classDef svc fill:#16A34A,stroke:#14532D,color:#fff

    subgraph MODE1 ["Mode 1 - Pattern capture (user request)"]
        direction TB
        U1([User: remember this / document this rule]):::terminal
        D1(["documentator - Mode 1\nreads session logs + ADRs + patterns ledger\nwrites rules/skills/hooks/agents\nto ~/.claude/local/<type>/<slug>.md\nindexes in /app/docs/learnings/patterns.md"]):::agent
        DONE1(["DONE M-DONE\n(response visible in chat)"]):::terminal
        U1 --> D1 --> DONE1
    end

    subgraph MODE2 ["Mode 2 - Business-knowledge synthesis (automatic, silent)"]
        direction TB
        T1(["chat-service - turn.js\nturn lands on completed\n+ sessionHasMergedTickets = true"]):::svc
        T2(["scheduleDocumentatorRun\n30s debounce timer\n(reset if user sends another message before timer fires)"]):::svc
        BUSY{runtime\nbusy?}:::decision
        T3(["documentator - Mode 2\nreads log.jsonl + git diff vs origin/main\nappends bullets to /app/MEMORY.md\n5 min hard ceiling\noutput -> documentator.log (silent, never broadcast)"]):::agent
        DONE2(["DONE meta.json stamped\ndocumentatorLastRunAt + exit code"]):::terminal
        T1 --> T2 --> BUSY
        BUSY -->|"yes - new turn started\nbefore timer fired"| SKIP2["skip\nnext completed turn\nwill re-schedule"]
        BUSY -->|no| T3 --> DONE2
    end
```

---

## 7. SIMPLE path

Cosmetic change OR single-field add/remove on an existing entity. No team, no planner.

```mermaid
flowchart TD
 
    classDef agent fill:#2563EB,stroke:#1E40AF,color:#fff
    classDef hook fill:#D97706,stroke:#92400E,color:#000
    classDef decision fill:#6D28D9,stroke:#4C1D95,color:#fff
 
    classDef terminal fill:#1F2937,stroke:#111827,color:#fff
 
    classDef promote fill:#059669,stroke:#065F46,color:#fff
    START([SIMPLE request]):::terminal

    H_START{{SubagentStart\nsetup-worktree.sh\ncreates worktrees/SID/simple\nhard-links node_modules}}:::hook
 START --> H_START

 H_START --> DEV(["simple-developer"]):::agent
 DEV --> IMPL["implement change\ngit add -A && git commit"]

 IMPL --> H_STOP
    H_STOP{{SubagentStop x 5 - sequential, blocks on failure\n1. typecheck  120s\n2. prettier   60s\n3. unit-app   180s\n4. unit-fn    180s\n5. e2e        600s}}:::hook

 H_STOP --> DIFF{supabase/\nin diff?}:::decision

 DIFF -->|no| MG
 DIFF -->|yes| QR(["quality-reviewer - SIMPLE mode\nsingle-shot, no team"]):::agent
 QR -->|APPROVED| MG
 QR -->|BLOCKED <=2x| FIX

    FIX(["simple-developer - fix cycle\nsame worktree, max 2 cycles"]):::agent
 FIX --> FIMPL["implement fix\ngit commit"]
 FIMPL --> H_FSTOP
    H_FSTOP{{SubagentStop x 5}}:::hook
 H_FSTOP --> QR

 MG(["merger - SIMPLE mode"]):::agent
 MG --> H_MG_STOP{{SubagentStop\ncleanup-worktree.sh}}:::hook --> SA["Stage A\ngit merge --no-ff SID/simple -> session/SID\nin _session worktree"]:::promote
 SA --> SB["Stage B - flock /app/.promote.lock\ngit checkout main . apply-app-variant.sh\ngit merge --no-ff session/SID -> main"]:::promote
 SB --> PD["-> #9 POST-DEV\n(only if supabase/ was touched)"]
```

---

## 8. COMPLEX path

Multi-ticket requests (2+ fields, new entity, cross-entity, new component, ambiguous). Also used by SETUP (#4) from STATE B onward.

### 8a. Wave loop

```mermaid
flowchart TD
 
    classDef agent fill:#2563EB,stroke:#1E40AF,color:#fff
    classDef hook fill:#D97706,stroke:#92400E,color:#000
    classDef decision fill:#6D28D9,stroke:#4C1D95,color:#fff
 
    classDef terminal fill:#1F2937,stroke:#111827,color:#fff
 
    classDef promote fill:#059669,stroke:#065F46,color:#fff
 START([COMPLEX request]):::terminal --> PLAN(["planner"]):::agent
 PLAN --> TICKETS["Tickets JSON\nTASK-XXX . waves . file hints\n(dependencies encoded in wave order)"]

 TICKETS --> STATE_B

    subgraph WAVE_LOOP ["Wave loop - repeats until all tickets dispatched"]
        direction TB

        STATE_B["STATE B\nPick next batch - <=5 unscheduled tickets"]
        H_WIPE{{Pre/TeamCreate\nteamcreate-wipe-orphan.sh}}:::hook
        TEAM["TeamCreate  tickets-SID\n3N+1 members total"]
        H_WS{{SubagentStart x N\nsetup-worktree.sh\ncreates worktrees/SID/TASK-XXX + hard-links node_modules}}:::hook
        DISPATCH["Dispatch per ticket (xN) + 1 shared merger\n---\n  developer-TASK-XXX        (Opus)   <- implements\n  quality-reviewer-TASK-XXX (Sonnet) <- code + security review\n  test-validator-TASK-XXX   (Haiku)  <- wiring + Playwright\n---\n  merger  (Haiku, shared singleton)   <- merges serially"]
        GO["SendMessage GO -> each developer\n(worktree path . branch . counterpart names)\nreviewer + test-validator idle until contacted"]
        STATE_C["STATE C - orchestrator passive\nmonitors SendMessage from merger:\n'merged TASK-XXX, commit=sha'\ncounts confirmations"]
        DONE_Q{All N merges\nconfirmed?}:::decision
        SHUTDOWN["STATE D  -  wave teardown\nSendMessage shutdown_request -> all 3N+1 members\nwait for shutdown_approved (or 60s timeout)"]
        H_TD_GATE{{Pre/TeamDelete\nteamdelete-gate.sh}}:::hook
        TEAMDEL["TeamDelete"]
        H_TD_CLEAN{{Post/TeamDelete\nteamdelete-cleanup.sh}}:::hook

 STATE_B --> H_WIPE --> TEAM --> DISPATCH --> H_WS --> GO --> STATE_C --> DONE_Q
 DONE_Q -->|"more unscheduled\ntickets"| SHUTDOWN --> H_TD_GATE --> TEAMDEL --> H_TD_CLEAN --> STATE_B
    end

 DONE_Q -->|last wave| PROMOTE_MSG["SendMessage merger\n'promote: session=SID'"]

 PROMOTE_MSG --> SA["Stage A already done per ticket\nStage B - flock /app/.promote.lock\ngit checkout main . apply-app-variant.sh\ngit merge --no-ff session/SID -> main"]:::promote

    H_MG_STOP{{SubagentStop/merger\ncleanup-worktree.sh}}:::hook
 SA --> H_MG_STOP

 H_MG_STOP --> PD["-> #9 POST-DEV"]
```

### 8b. Communication inside one wave — per-ticket agent lifecycle

```mermaid
sequenceDiagram
    participant O  as orchestrator
    participant D  as developer-TASK-XXX
    participant QR as quality-reviewer-TASK-XXX
    participant TV as test-validator-TASK-XXX
    participant MG as merger (shared)

    Note over O: TeamCreate done - all agents idle

    O->>D:  GO (worktree path, branch, reviewer+validator names)
    O->>QR: GO (idle - wait for "ready, please review")
    O->>TV: GO (idle - wait for "ready, please validate")
    O->>MG: GO (idle - wait for "ready: TASK-XXX")

    Note over D: SubagentStart fires -> setup-worktree.sh<br/>creates worktrees/SID/TASK-XXX + hard-links node_modules

    D->>D: implement changes in worktree
    D->>D: git add -A && git commit
    D->>D: git rebase session/SID

    Note over D: Pre/SendMessage hook: validate-before-review.sh<br/>typecheck (120s) + prettier (60s) + unit (180s) + e2e (600s)<br/>BLOCKS send on failure - developer must fix and retry

    D->>QR: ready, please review (branch name)
    D->>TV: ready, please validate (branch name)

    par QR reviews in parallel with TV
        QR->>QR: code quality + security (rubric A1-A8, B1-B7)
        QR-->>D: APPROVED  or  BLOCKED: file:line - what to fix
    and
        TV->>TV: integration wiring check + Playwright screenshots
        TV-->>D: GREEN  or  RED: issues list
    end

    alt any BLOCKED or RED
        D->>D: fix . commit . rebase
        Note over D: Pre/SendMessage hook fires again
        D->>QR: ready, please review
        D->>TV: ready, please validate
        QR-->>D: APPROVED
        TV-->>D: GREEN
    end

    D->>MG: ready: TASK-XXX  branch=SID/TASK-XXX  all approved

    Note over MG: Stage A - git merge --no-ff SID/TASK-XXX -> session/SID<br/>in _session worktree<br/>updates TASK-XXX.json status -> merged

    MG-->>O: merged TASK-XXX  commit=sha

    Note over O: STATE C - counts confirmations<br/>when all N confirmed -> STATE D (wave teardown) or promote
```

---

## 9. POST-DEV

Runs after every COMPLEX/SETUP session and after schema-touching SIMPLE. Entry point: promote completed.

```mermaid
flowchart TD
 
    classDef agent fill:#2563EB,stroke:#1E40AF,color:#fff
    classDef decision fill:#6D28D9,stroke:#4C1D95,color:#fff
 
    classDef terminal fill:#1F2937,stroke:#111827,color:#fff
 
    classDef postdev fill:#BE185D,stroke:#831843,color:#fff
    classDef promote fill:#059669,stroke:#065F46,color:#fff
    ENTRY(["promote done\n(from #7 SIMPLE or #8 COMPLEX)"]):::terminal

 ENTRY --> SAT["ASK_SATISFACTION widget\n(COMPLEX / SETUP only - skipped for SIMPLE)"]:::postdev
 SAT --> PEND{pending-deploys\nscript}:::decision

 PEND -->|"no schema changes"| DONE

 PEND -->|"session has schema diff\nvs session-base/SID"| MIG_DEV(["simple-developer\nMIGRATION MODE\nSkill: writing-migrations\ngenerates SQL from git diff session-base..session/SID"]):::agent

 MIG_DEV -->|NO_MIGRATION_NEEDED| DONE
 MIG_DEV -->|DONE| MIG_QR(["quality-reviewer\nMODE: migration-review"]):::agent

 MIG_QR -->|APPROVED| MIG_MG(["merger - SIMPLE mode\nbranch SID/simple -> session/SID -> main"]):::agent
 MIG_QR -->|BLOCKED| MIG_DEV

 MIG_MG --> DEPLOY["Bash apply-migrations\ntimeout 240s"]:::postdev
 DEPLOY --> DONE

    DONE(["DONE PD-DONE\nchat-service schedules documentator Mode 2\nwith 30s debounce -> see #6"]):::terminal
```

---

## 10. Hooks — full reference

### PreToolUse

| Hook | Filtered tool | Effect |
|---|---|---|
| `member-idle-gate` | Bash · Read · Grep · Glob · SendMessage | Blocks calls from agents not registered in the active team |
| `silent-mode-check` | Bash | Verifies agent is running headless |
| `circuit-breaker` | Bash | Detects runaway loops / timeouts |
| `block-bash-file-write` | Bash | Blocks `sed -i`, `echo >`, write redirections |
| `block-bash-validation` | Bash | Blocks manual typecheck/prettier/tests (SubagentStop owns these) |
| `block-orchestrator-merge` | Bash | Prevents orchestrator from calling `git merge` |
| `restrict-documentator-bash` | Bash | Limits documentator to `git log/show/diff/ls/wc` |
| `restrict-documentator-write` | Write · Edit | Limits documentator writes to `~/.claude/local/*` and `/app/MEMORY.md` |
| `block-migration-writes` | Write · Edit | Blocks `supabase/migrations/` except during PD-MIG-DEV |
| `block-premature-shutdowns` | SendMessage | Blocks `shutdown_request` until merger has confirmed all merges |
| **`validate-before-review`** | SendMessage | **Runs typecheck · prettier · unit · e2e before developer → reviewer/merger. Blocks on failure.** |
| `teamcreate-wipe-orphan` | TeamCreate | Removes orphan team of same name from a dead previous run |
| `teamdelete-gate` | TeamDelete | Guards against premature TeamDelete |

### SubagentStart

| Hook | Agent filter | Effect | Timeout |
|---|---|---|---|
| `setup-worktree.sh` | `developer` · `simple-developer` | Creates `/app/worktrees/SID/TASK/` + hard-links `node_modules` | 60s |

### SubagentStop

| Hook | Agent filter | Scripts (sequential) | Timeout |
|---|---|---|---|
| `cleanup-worktree.sh` | `merger` | Removes task + session worktrees | 30s |
| `typecheck-on-commit.sh` | `simple-developer` | TypeScript typecheck | 120s |
| `prettier-on-stop.sh` | `simple-developer` | Prettier | 60s |
| `run-unit-tests-app.sh` | `simple-developer` | Vitest — app | 180s |
| `run-unit-tests-functions.sh` | `simple-developer` | Vitest — functions | 180s |
| `run-e2e-tests.sh` | `simple-developer` | Playwright e2e | 600s |

### PostToolUse

| Hook | Tool | Effect |
|---|---|---|
| `teamdelete-cleanup.sh` | TeamDelete | Cleans up team state after deletion |

---

## 11. Branch & worktree topology

```
origin/main
    └── session/<SID>              ← forked at session start
            ├── session-base/<SID>      (anchor ref — never moves, used for migration diff)
            ├── <SID>/TASK-001          ← developer-TASK-001 branch
            ├── <SID>/TASK-002
            └── <SID>/simple            ← simple-developer branch

Worktrees on disk:
  /app/worktrees/<SID>/TASK-001/       (hard-links node_modules)
  /app/worktrees/<SID>/TASK-002/
  /app/worktrees/<SID>/simple/
  /app/worktrees/<SID>/_session/       (merger Stage A — checked out on session/<SID>)
  /app/worktrees/_deploy/              (deploy-time vite build only — isolated from dev server)

Merge path:
  <SID>/TASK-XXX  ──Stage A──►  session/<SID>  ──Stage B──►  main
                                (per ticket,                  (once per session,
                                 in _session wt)               under flock lock)
```
