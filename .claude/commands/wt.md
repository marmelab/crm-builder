---
description: Crée un worktree Git pour une nouvelle feature et l'ajoute au workspace VS Code
allowed-tools: Bash
---

Crée un worktree Git en utilisant le script `wt` disponible dans le PATH du conteneur.

## Utilisation

`/worktree <nom-feature> [--base <branche>]`

Exemples :
- `/worktree add-login`
- `/worktree fix-payment --base origin/develop`
- `/worktree clean <nom-feature>`
- `/worktree list`

## Comportement

### Cas `/worktree <nom-feature>` (création)

Lance directement sans chercher le script :

```bash
wt $ARGUMENTS
```

C'est tout. Le script gère le fetch, la création de branche, le worktree et la mise à jour du `.code-workspace`.

Après succès, rappelle à l'utilisateur :
> Recharge VS Code : `Ctrl+Shift+P` → `Developer: Reload Window`

### Cas `/worktree clean <nom-feature>`

```bash
wt-clean <nom-feature>
```

### Cas `/worktree list`

```bash
git worktree list
```

## En cas d'erreur

Si `wt` est introuvable (exit code 127), indique que le devcontainer doit être rebuild pour que `post-create.sh` recrée les symlinks :
> `wt` n'est pas dans le PATH. Rebuild le devcontainer pour réinstaller les symlinks.

Ne cherche pas le script manuellement. Ne propose pas d'alternatives. Indique juste l'erreur.
