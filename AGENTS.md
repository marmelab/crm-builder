# AGENTS.md

### Worktree Management (Agent Workflow)

```bash
make spin TASK=XXX NAME=branch-name  # Create worktree + branch + node_modules symlink
make merge TASK=XXX                  # Rebase onto master + push + open PR (requires gh CLI)
make clean TASK=XXX NAME=branch-name # Delete the worktree after confirmed merge
```

## Agent Team

> Full protocol in the `agent-team` skill (workflow, routing, tmux spawn, reflection loop, cross-cutting rules):
> invoke with `Skill({ skill: "agent-team" })` at the start of a dispatch session.
>
> Silent mode (Playwright headless, Vite without --open, Vitest without browser.ui) is automatically enforced by `.claude/hooks/silent-mode-check.sh`.
