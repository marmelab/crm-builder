# SIMPLE Flow Merger Reliability Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 bugs in the SIMPLE+POST-DEV flow that cause a blocked merger, duplicate merger agents, duplicate migration reviewers, and ticket status never updating.

**Architecture:** All changes are in a single file (`chat-orchestrator.md`). Three targeted edits: a pre-written flag before the S-MERGE merger dispatch, a ONE-call constraint in PD-MIG-REVIEW, and TICKETS_DIR added to both merger prompt templates.

**Tech Stack:** Markdown prompt file for Claude agent (`claudeConfig/.claude/agents/chat-orchestrator.md`)

---

## File map

| File | Change |
|------|--------|
| `claudeConfig/.claude/agents/chat-orchestrator.md` | STATE S-MERGE: pre-write flag + TICKETS_DIR in template |
| `claudeConfig/.claude/agents/chat-orchestrator.md` | STATE PD-MIG-REVIEW: ONE Agent call constraint |
| `claudeConfig/.claude/agents/chat-orchestrator.md` | STATE PD-MIG-MERGE: TICKETS_DIR in merger prompt |

---

### Task 1 — STATE S-MERGE: pre-write merger flag before dispatch

**Files:**
- Modify: `claudeConfig/.claude/agents/chat-orchestrator.md:327-335`

The goal is to add a `Bash("touch ...")` call *before* the `Agent({subagent_type: "merger", ...})` dispatch so the `member-idle-gate` hook finds the bypass flag on the merger's very first tool call, regardless of what that call is.

- [ ] **Step 1: Open the file and locate STATE S-MERGE step 3**

The section to change is at line ~327. Current content of step 3:

```
3. If dev returned `DONE: branch=<X>...` and (review skipped OR review `APPROVED`) → dispatch merger (no `team_name`, no SendMessage):
   ```
   Agent({
     subagent_type: "merger",
     description: "Merge SIMPLE branch <X>",
     prompt: "<SIMPLE merger protocol — see below>"
   })
   ```
4. One text line: *"Wrapping up..."*
```

- [ ] **Step 2: Add the Bash pre-write before the Agent dispatch**

Replace the step 3 block with:

```
3. If dev returned `DONE: branch=<X>...` and (review skipped OR review `APPROVED`):
   ```
   Bash("touch /tmp/notified-merger-<SESSION_SHORT_ID>-simple")
   Agent({
     subagent_type: "merger",
     description: "Merge SIMPLE branch <X>",
     prompt: "<SIMPLE merger protocol — see below>"
   })
   ```
4. One text line: *"Wrapping up..."*
```

- [ ] **Step 3: Verify the edit looks correct**

```bash
grep -A 10 "STATE S-MERGE" claudeConfig/.claude/agents/chat-orchestrator.md | grep -A 5 "touch /tmp"
```

Expected: shows the `touch /tmp/notified-merger-<SESSION_SHORT_ID>-simple` line inside step 3.

- [ ] **Step 4: Commit**

```bash
git add claudeConfig/.claude/agents/chat-orchestrator.md
git commit -m "fix(simple-flow): pre-write merger gate flag before S-MERGE dispatch"
```

---

### Task 2 — STATE S-MERGE: add TICKETS_DIR to the merger prompt template

**Files:**
- Modify: `claudeConfig/.claude/agents/chat-orchestrator.md:341-354`

The merger's Step 3 does `ls ${TICKETS_DIR}/TASK-SIMPLE-*.json` to update ticket status but TICKETS_DIR is missing from the prompt. The note "(return text output only — no ticket to update)" is also wrong and should be removed.

- [ ] **Step 1: Locate the SIMPLE merger prompt template**

The template starts at line ~344 and currently reads:

```
ROLE: merger (SIMPLE mode — single-shot, no team)
BRANCH_NAME: simple/<SESSION_SHORT_ID>
WORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/simple

Follow the WORKFLOW in your agent file (merger.md). Use the SIMPLE-mode columns
(return text output only — no ticket to update).
Output: "DONE: commit=<short sha>. files=[<paths>]" OR "FAILED: <reason>"
```

- [ ] **Step 2: Add TICKETS_DIR and fix the misleading note**

Replace with:

```
ROLE: merger (SIMPLE mode — single-shot, no team)
BRANCH_NAME: simple/<SESSION_SHORT_ID>
WORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/simple
TICKETS_DIR: <absolute per-session path>

Follow the WORKFLOW in your agent file (merger.md). Use the SIMPLE-mode columns.
Output: "DONE: commit=<short sha>. files=[<paths>]" OR "FAILED: <reason>"
```

- [ ] **Step 3: Verify**

```bash
grep -A 8 "SIMPLE merger prompt template" claudeConfig/.claude/agents/chat-orchestrator.md
```

Expected output contains `TICKETS_DIR: <absolute per-session path>` and does NOT contain "no ticket to update".

- [ ] **Step 4: Commit**

```bash
git add claudeConfig/.claude/agents/chat-orchestrator.md
git commit -m "fix(simple-flow): pass TICKETS_DIR to S-MERGE merger so it can update ticket status"
```

---

### Task 3 — STATE PD-MIG-REVIEW: ONE Agent call constraint

**Files:**
- Modify: `claudeConfig/.claude/agents/chat-orchestrator.md:604-607`

The current text at line 606 is:

```
Dispatch ONE quality-reviewer (no team) with `MODE: migration-review` and the migration file paths. **End turn.**
```

- [ ] **Step 1: Add the CRITICAL constraint before the dispatch instruction**

Replace line 606 with:

```
CRITICAL: ONE Agent call only. Dispatch once, end the turn, wait for the result.

Dispatch ONE quality-reviewer (no team) with `MODE: migration-review` and the migration file paths. **End turn.**
```

- [ ] **Step 2: Verify**

```bash
grep -B 2 -A 2 "ONE Agent call only" claudeConfig/.claude/agents/chat-orchestrator.md
```

Expected: shows the CRITICAL line directly above the "Dispatch ONE quality-reviewer" line.

- [ ] **Step 3: Commit**

```bash
git add claudeConfig/.claude/agents/chat-orchestrator.md
git commit -m "fix(simple-flow): enforce single migration reviewer dispatch in PD-MIG-REVIEW"
```

---

### Task 4 — STATE PD-MIG-MERGE: add TICKETS_DIR to merger prompt

**Files:**
- Modify: `claudeConfig/.claude/agents/chat-orchestrator.md:609-612`

The current text at line 611 is a one-liner with no prompt template:

```
Dispatch the SIMPLE merger for branch `simple/<SESSION_SHORT_ID>` (it does Stage A into the session branch + promotion to main). **End turn.**
```

- [ ] **Step 1: Expand to include an explicit prompt template**

Replace lines 609-612 with:

```
### STATE PD-MIG-MERGE — merge + promote

Dispatch the SIMPLE merger for branch `simple/<SESSION_SHORT_ID>` (it does Stage A into the session branch + promotion to main):

```
Bash("touch /tmp/notified-merger-<SESSION_SHORT_ID>-simple")
Agent({
  subagent_type: "merger",
  description: "Merge SIMPLE branch simple/<SESSION_SHORT_ID> with migration",
  prompt: "ROLE: merger (SIMPLE mode — single-shot, no team)\nBRANCH_NAME: simple/<SESSION_SHORT_ID>\nWORKTREE_PATH: /app/worktrees/<SESSION_SHORT_ID>/simple\nTICKETS_DIR: <absolute per-session path>\n\nFollow the WORKFLOW in your agent file (merger.md). Use the SIMPLE-mode columns.\nOutput: \"DONE: commit=<short sha>. files=[<paths>]\" OR \"FAILED: <reason>\""
})
```

**End turn.**
→ `DONE` → STATE PD-DEPLOY. `FAILED`/`promote conflict` → STATE PD-PROMOTE-FIX.
```

Note: the `Bash("touch ...")` here is a safety net — by the time PD-MIG-MERGE runs, the flag from S-MERGE already exists. But re-touching it is idempotent and ensures correctness even in edge cases where S-MERGE didn't run (e.g. a cosmetic SIMPLE that skipped S-MERGE but somehow reached PD-MIG-MERGE).

- [ ] **Step 2: Verify**

```bash
grep -A 12 "STATE PD-MIG-MERGE" claudeConfig/.claude/agents/chat-orchestrator.md
```

Expected: shows the Bash + Agent dispatch with TICKETS_DIR in the prompt.

- [ ] **Step 3: Final check — all 4 fixes present**

```bash
grep -n "touch /tmp/notified-merger\|ONE Agent call only\|TICKETS_DIR" claudeConfig/.claude/agents/chat-orchestrator.md
```

Expected: at least 5 matches — 2× `touch /tmp/notified-merger` (S-MERGE + PD-MIG-MERGE), 1× `ONE Agent call only`, 2× `TICKETS_DIR` in merger templates (S-MERGE template block + PD-MIG-MERGE prompt string).

- [ ] **Step 4: Commit**

```bash
git add claudeConfig/.claude/agents/chat-orchestrator.md
git commit -m "fix(simple-flow): add TICKETS_DIR and pre-write flag to PD-MIG-MERGE merger prompt"
```
