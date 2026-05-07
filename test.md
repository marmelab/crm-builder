* save token & context : quand c'est possible, run background processes en dehors de claude pour ne pas avoir l'output entier, il faudrait vérifier quels output sortent le plus de context (on peut utiliser tmux pour sortir les process)

* utilisation de /loop pour contrôler les agents, et vérifier ou ils en sont ?

* mettre en place outupStyle ? https://code.claude.com/docs/en/output-styles

* to discuss with françois
* -  stop -> clean worktrees / sessions / etc.
* -  tester "stop" sur grosse task

* ajout de tests automatisés sur la CI github (jobs)

* impossibilité de merge si la CI est KO

* lorsqu'on quitte une session vides (vide = sans message utilisateur ou uniquement le message "quick modif"/"full setup") on doit la supprimer
* on unMount on supprime la NouvelleDiscussion ? Est ce que ça fonctionne au refresh aussi ?

* gestion des tests e2e lors des devs. Comme on est en mode démo, ils ont tendance à être laxiste dessus alors que reviewer en veut.

* deux tendances sur équipe d'agents : spawn tout au démarrage mais reviewers et merger invalident leur cache car attendent leur tour (au bout de 5min d'inactivité, invalidité cache) ou les spawn au moment ou on en a besoin.

* case 1 : 54k in 3k out 0.445$ 3min englishCrmMessages 1line
* case 2 : 260k in 8k out 1.133$ 4min index.css 7lines
* case 4 : 299k in 16k out 1.905$ 6min

V2 agentic team :
* case 1 : 21k 0.288$ 2min21 
* case 2 : 
* case 4 : 

* enlever silent-mode-check
