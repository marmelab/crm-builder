* save token & context : quand c'est possible, run background processes en dehors de claude pour ne pas avoir l'output entier, il faudrait vérifier quels output sortent le plus de context (on peut utiliser tmux pour sortir les process)

* utilisation de /loop pour contrôler les agents, et vérifier ou ils en sont ?


* mettre en place outupStyle ? https://code.claude.com/docs/en/output-styles

* ajouter résultats attendus dans les cas de tests. Faire un diff pour baseline, puis pour chaque test un diff et faire un diff de diff à interpreter par un agent

* clean logs hooks

* refactor agents & skills (trop verbeux)

* faire des bashs pour création/clean worktree, branche

* refactor chat.js

* refactor server.js

* tests/ et test/ -> à renommer

* to discuss with françois
* -  stop -> clean worktrees / sessions / etc.
* -  tester "stop" sur grosse task

* ajout de tests automatisés sur la CI github (jobs)
* -  ne pas run ceux qui nécéssitent une clé d'API
* impossibilité de merge si la CI est KO

* lors ce qu'on quitte une session vides (vide = sans message utilisateur ou uniquement le message "quick modif"/"full setup") on doit la supprimer
* on unMount on supprime la NouvelleDiscussion ? Est ce que ça fonctionne au refresh aussi ?

* enlever silent-mode-check

* Si j'envoie un message sans cliquer sur "Make a quick change/Set up from scratch", les boutons devraient disparaitre
