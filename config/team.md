# Equipe CRM Builder

> **Vous n'avez pas besoin de lire ce fichier pour utiliser le système.**
> Consultez le [README.md](README.md) pour un guide simple.
> Ce document décrit le fonctionnement interne de l'équipe d'agents.

---

## Comment ca fonctionne pour vous

Vous discutez avec **un seul interlocuteur** : le Chef de projet.
Il vous pose des questions sur votre activité, valide vos choix,
et coordonne toute l'équipe technique en coulisses.

Vous n'avez jamais besoin de parler aux autres agents directement.
Le Chef de projet vous tient informé de l'avancement.

```
    Vous
     │
     ▼
Chef de projet ← votre seul interlocuteur
     │
     ▼
  Equipe technique (automatique, en coulisses)
     │
     ▼
  Votre CRM en ligne
```

---

## Structure de l'équipe (détail technique)

| # | Rôle | Ce qu'il fait | Quand il intervient |
|---|------|---------------|---------------------|
| 1 | Chef de projet | Comprend vos besoins, valide la spec | Au début, et en cas de problème |
| 2 | DevOps | Crée l'infrastructure (code, base de données, hébergement) | Après validation de la spec |
| 3 | Codeur | Découpe le travail en tâches et supervise le développement | Après l'infrastructure |
| 4 | Développeur | Ecrit le code de chaque fonctionnalité | Pour chaque tâche |
| 5 | Relecteur | Vérifie la qualité du code | Après chaque développement |
| 6 | Sécurité | Vérifie qu'il n'y a pas de faille | En parallèle du relecteur |
| 7 | Testeur QA | Vérifie que tout fonctionne correctement | Après relecture + sécurité |
| 8 | Documentaliste | Met à jour la documentation | Après chaque livraison |

## Ordre d'exécution

```
Chef de projet → DevOps → Codeur ──► Développeur
                                         │
                               ┌─────────┴─────────┐
                            Relecteur           Sécurité
                               └─────────┬─────────┘
                                      Testeur QA
                                         │
                                       Merge
                                         │
                                    Documentaliste
```

---

## Règles internes

> Les règles ci-dessous sont destinées aux agents, pas aux utilisateurs.

1. `project-context.json` est la source de vérité — tout agent qui le modifie
   doit logger la modification avec un timestamp ISO 8601 et son `agent_id`.

2. Aucun agent ne dépasse **2 tentatives autonomes** sur une erreur avant
   d'escalader au Chef de projet via le format suivant :
   ```json
   {
     "escalation": true,
     "agent_id": "...",
     "ticket_id": "...",
     "attempt": 2,
     "error": "message exact",
     "context": "description courte de l'état courant"
   }
   ```

3. Le Chef de projet est le **seul** à pouvoir marquer `"validated": true`
   et `"phase_status.*.status": "done"`.

4. Les sous-agents (4, 5, 6, 7, 8) ne communiquent **jamais** directement
   avec l'utilisateur — tout transite par le Codeur, puis le Chef si besoin.

5. L'Agent 5 (Relecteur) et l'Agent 6 (Sécurité) s'exécutent **en parallèle**
   sur le même diff. L'Agent 7 (Testeur) ne démarre qu'après réception des
   deux rapports.

6. Un ticket ne peut être mergé que si les trois sous-agents retournent
   `"status": "approved"`.

7. En cas de reprise de session, le Chef relit le `project-context.json`
   existant, identifie le `current_ticket` et le `last_checkpoint`,
   et reprend sans re-interviewer l'utilisateur.

## Fichiers de l'équipe

- `README.md` — Guide utilisateur (commencez ici)
- `team.md` — Ce fichier (fonctionnement interne)
- `agents/agent1-chef.md` — Chef de projet
- `agents/agent2-devops.md` — DevOps
- `agents/agent3-codeur.md` — Codeur
- `agents/agent4-developpeur.md` — Développeur
- `agents/agent5-review.md` — Relecteur
- `agents/agent6-security.md` — Sécurité
- `agents/agent7-qa.md` — Testeur QA
- `agents/agent8-doc.md` — Documentaliste
- `project-context.template.json` — Template de contexte projet
