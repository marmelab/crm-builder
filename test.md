* save token & context : quand c'est possible, run background processes en dehors de claude pour ne pas avoir l'output entier, il faudrait vérifier quels output sortent le plus de context (on peut utiliser tmux pour sortir les process)

* utilisation de /loop pour contrôler les agents, et vérifier ou ils en sont ?


* mettre en place outupStyle ? https://code.claude.com/docs/en/output-styles

* ajouter résultats attendus dans les cas de tests. Faire un diff pour baseline, puis pour chaque test un diff et faire un diff de diff à interpreter par un agent

* clean logs hooks

* refactor agents & skills (trop verbeux)

* refactor chat.js

* tests/ et test/ -> à renommer

******************************************************************************
* fr -> en

* nouveau status "en attente" s'il veut poser une question

* si tu quitte la discussion avec un message en attente
        * le visuel de "en attente" n'est plus
        * points de suspensions non présents
******************************************************************************

* to discuss with françois
* -  stop -> clean worktrees / sessions / etc.
* -  tester stop sur grosse task

