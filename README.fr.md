# claude-mods

[![tests](https://github.com/DarkSawOktay/claude-mods/actions/workflows/tests.yml/badge.svg)](https://github.com/DarkSawOktay/claude-mods/actions/workflows/tests.yml)
[![licence MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Mods pour [Claude Code](https://claude.com/claude-code) : de petits plugins qui affichent ce qu'on finirait sinon par demander à Claude. Un dossier par mod ; on n'installe que ceux qu'on veut. Chaque mod parle **français ou anglais**.

| Mod | Ce qu'il montre | Commandes |
|---|---|---|
| [`suivi-conso`](suivi-conso) | Quota 5 h et 7 j restant, contexte en tokens, coût de la session (équivalent API), heure d'épuisement prévue au rythme actuel, ce qui a le plus coûté, conseils pour économiser, historique sur 7 jours. Fournit aussi les thèmes communs | `/conso`, `/conso bande`, `/theme-mods <thème>` |
| [`ou-on-en-est`](ou-on-en-est) | Pour chaque dépôt : branche, non commité, non poussé, à récupérer, PR et CI. Sur le serveur : le commit déployé comparé à main, les modifs faites sur place, la réponse des pages. Notes par dépôt | `/ou-on-en-est`, `/ou-on-en-est note <dépôt> <texte>` |
| [`garde-prod`](garde-prod) | Chaque commande qui touche la production ou un geste risqué (`push --force`, secrets, `rm -rf`…), la sauvegarde de la base avant une écriture (refus possible sans sauvegarde), et les commandes refusées, prêtes à lancer soi-même avec `!` | `/prod` |
| [`apk-fraicheur`](apk-fraicheur) | L'APK Android est-il à jour avec le code ? Build en cours et sa durée, échec ou manque de mémoire signalé tout de suite, taille, copie vers un autre dossier | `/apk`, `/apk copier` |

Une bande au-dessus du prompt (terminal et ordinateur) donne l'essentiel ; chaque commande ouvre un panneau détaillé, qui marche aussi sur le téléphone.

```
5 h ███████░░░ 62 % restant │ 7 j 42 % │ ctx 342 k / 1 M │ ≈ 4,82 $   /conso
PROD ×2 · sauvegarde ✓ 21:10 · 1 à lancer toi-même (/prod)
APK v4 · 14:52 ✗ périmé : 2 commits depuis le build · 96 Mo
```

## Prérequis

- Claude Code récent (testé avec la version 2.1), dans le terminal ou l'application de bureau.
- `git` pour `ou-on-en-est` et `apk-fraicheur` ; `gh` connecté pour voir les PR et la CI ; un accès `ssh` par clé pour suivre un serveur.

## Installer

```bash
git clone https://github.com/DarkSawOktay/claude-mods ~/claude-mods
```

Dans `~/.claude/settings.json` (réglages personnels, pas ceux d'un projet), un chemin par mod voulu, séparés par `:` :

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/claude-mods/suivi-conso:~/claude-mods/ou-on-en-est:~/claude-mods/garde-prod:~/claude-mods/apk-fraicheur"
  }
}
```

Essai ponctuel : `claude --plugin-dir ~/claude-mods/garde-prod`. Mise à jour : `git pull` dans `~/claude-mods` ; Claude Code recharge un mod quand ses fichiers changent.

## Réglages

Dans `/config`, ou sous `pluginConfigs` dans `~/.claude/settings.json` :

```json
{
  "pluginConfigs": {
    "garde-prod": { "options": { "prodHosts": "mon-site.fr,203.0.113.7", "requireBackup": true } },
    "ou-on-en-est": { "options": { "vpsHost": "deploy@mon-site.fr", "vpsRepos": "api=/srv/api", "healthUrls": "https://mon-site.fr/" } },
    "apk-fraicheur": { "options": { "appDir": "/home/moi/projets/mon-app", "copyTo": "/mnt/c/Users/moi/Downloads" } }
  }
}
```

Chaque mod a `language` : `fr` (par défaut) ou `en`.

**`garde-prod`**
- `prodHosts` : noms d'hôte ou IP de production. Sans eux, seuls les gestes risqués sont repérés.
- `backupPattern` : expression régulière d'une sauvegarde maison, en plus de `pg_dump`, `mysqldump`, `mongodump`.
- `backupMaxAgeMinutes` (120) : âge maximal d'une sauvegarde pour couvrir une écriture.
- `requireBackup` (non) : refuser une écriture en base de prod sans sauvegarde récente. Claude reçoit la raison et fait la sauvegarde d'abord.

**`ou-on-en-est`**
- `projectsRoot` : chaque dépôt git directement dedans est suivi. Vide : le projet courant et ses voisins.
- `extraRepos` : autres chemins, séparés par des virgules.
- `vpsHost`, `vpsRepos` : le serveur (ssh par clé) et `nom=chemin` de chaque dépôt déployé. Lecture seule : un seul `ssh` avec `git rev-parse` et `git status`, toutes les 10 minutes et à chaque `/ou-on-en-est`.
- `healthUrls` : pages dont le code HTTP est affiché.

**`apk-fraicheur`**
- `appDir` : le projet suivi quand le dossier courant n'est pas une app Android.
- `copyTo` : où `/apk copier` dépose l'APK.

## Thèmes

`/theme-mods graphite | olive | crepuscule | papier | contraste` (fourni par `suivi-conso`). Le choix est gardé d'une session à l'autre et écrit dans `~/.claude/mods-theme`, que tous les mods lisent. Le reste de Claude Code suit `/theme`.

## Ce que les mods font et ne font pas

- Ils lisent : git, `gh`, les fichiers du projet, et pour `ou-on-en-est` un `ssh` et des `curl` en lecture seule à chaque vérification. `ou-on-en-est` lance aussi `git fetch`, qui ne met à jour que les branches distantes suivies.
- Ils ne modifient jamais ton code, tes branches ni ton serveur. `/apk copier` copie l'APK quand tu le demandes. `garde-prod` avec `requireBackup` refuse une écriture en base de prod tant qu'il n'y a pas de sauvegarde : c'est le seul cas où un mod bloque quelque chose.
- Rien ne sort de ta machine : pas de télémétrie, pas de service tiers.

## Développer

```bash
claude plugin validate <mod>
claude plugin test <mod>
```

Règles du dépôt, pour que chaque mod puisse être publié :
- rien de propre à une installation dans le code : serveurs, chemins et noms passent par `userConfig` ;
- chaque texte affiché passe par la table `messages(lang)` du mod, en français et en anglais ;
- les calculs dans `hooks/logic.ts`, sans appel à l'engine, testés seuls ; l'affichage dans `hooks/register.tsx`, testé sur au moins deux surfaces ;
- une bande au-dessus du prompt s'empile avec celles des autres mods (`next(e)` dessiné en dessous) ;
- lecture seule par défaut : un mod qui refuse ou modifie quelque chose le fait sur un réglage explicite.

Issues et pull requests bienvenues.

## Licence

[MIT](LICENSE) © Oktay Gençer

---

[English version](README.md)
