# claude-mods

[![tests](https://github.com/DarkSawOktay/claude-mods/actions/workflows/tests.yml/badge.svg)](https://github.com/DarkSawOktay/claude-mods/actions/workflows/tests.yml)
[![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Mods for [Claude Code](https://claude.com/claude-code): small plugins that put on screen what you would otherwise keep asking Claude. One folder per mod; install only the ones you want. Every mod speaks **English or French**.

| Mod | What it shows | Commands |
|---|---|---|
| [`suivi-conso`](suivi-conso) — usage | 5-hour and weekly quota left, context in tokens, session cost (API equivalent), when the quota runs out at the current pace, what cost the most, tips to save usage, 7-day history. Also provides the shared themes | `/conso`, `/conso band`, `/theme-mods <theme>` |
| [`ou-on-en-est`](ou-on-en-est) — where things stand | For each repo: branch, uncommitted, unpushed, to pull, PR and CI. On your server: the deployed commit against main, changes made in place, whether your pages answer. Notes per repo | `/ou-on-en-est`, `/ou-on-en-est note <repo> <text>` |
| [`garde-prod`](garde-prod) — production guard | Every command that touches production or is risky (`push --force`, secrets, `rm -rf`…), a fresh database backup before a production write (can refuse without one), and refused commands kept ready to run yourself with `!` | `/prod` |
| [`apk-fraicheur`](apk-fraicheur) — APK freshness | Is the Android APK up to date with the code? Build in progress and its duration, failure or out-of-memory flagged at once, size, copy to another folder | `/apk`, `/apk copy` |

A band above the prompt (terminal and desktop) gives the essentials; each command opens a pane with the details, which also works on mobile.

```
5 h ███████░░░ 62% left │ 7 d 42% │ ctx 342 k / 1 M │ ≈ $4.82   /conso
PROD ×2 · backup ✓ 21:10 · 1 run yourself (/prod)
APK v4 · 14:52 ✗ stale: 2 commits since the build · 96 MB
```

## Requirements

- A recent Claude Code (tested with 2.1), in the terminal or the desktop app.
- `git` for `ou-on-en-est` and `apk-fraicheur`; a signed-in `gh` to see PRs and CI; key-based `ssh` to follow a server.

## Install

```bash
git clone https://github.com/DarkSawOktay/claude-mods ~/claude-mods
```

In `~/.claude/settings.json` (your user settings, not a project's), one path per mod you want, separated by `:`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/claude-mods/suivi-conso:~/claude-mods/ou-on-en-est:~/claude-mods/garde-prod:~/claude-mods/apk-fraicheur"
  }
}
```

To try one mod once: `claude --plugin-dir ~/claude-mods/garde-prod`. To update: `git pull` in `~/claude-mods`; Claude Code reloads a mod when its files change.

## Settings

In `/config`, or under `pluginConfigs` in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "suivi-conso": { "options": { "language": "en" } },
    "garde-prod": { "options": { "language": "en", "prodHosts": "example.com,203.0.113.7", "requireBackup": true } },
    "ou-on-en-est": { "options": { "language": "en", "vpsHost": "deploy@example.com", "vpsRepos": "api=/srv/api", "healthUrls": "https://example.com/" } },
    "apk-fraicheur": { "options": { "language": "en", "appDir": "/home/me/projects/my-app", "copyTo": "/mnt/c/Users/me/Downloads" } }
  }
}
```

Every mod has `language`: `fr` (default) or `en`.

**`garde-prod`**
- `prodHosts`: production hostnames or IPs. Without them, only risky commands are flagged.
- `backupPattern`: regular expression for your own backup command, on top of `pg_dump`, `mysqldump`, `mongodump`.
- `backupMaxAgeMinutes` (120): how old a backup may be and still cover a write.
- `requireBackup` (off): refuse a production database write without a recent backup. Claude gets the reason and takes the backup first.

**`ou-on-en-est`**
- `projectsRoot`: every git repo directly inside is tracked. Empty: the current project and the repos next to it.
- `extraRepos`: other paths, comma-separated.
- `vpsHost`, `vpsRepos`: your server (key-based ssh) and `name=path` for each deployed repo. Read-only: a single `ssh` running `git rev-parse` and `git status`, every 10 minutes and on each `/ou-on-en-est`.
- `healthUrls`: pages whose HTTP status is shown.

**`apk-fraicheur`**
- `appDir`: the project followed when the current folder is not an Android app.
- `copyTo`: where `/apk copy` puts the APK.

## Themes

`/theme-mods graphite | olive | crepuscule | papier | contraste` (provided by `suivi-conso`). The choice is kept across sessions and written to `~/.claude/mods-theme`, which every mod reads. The rest of Claude Code follows `/theme`.

## What the mods do and don't do

- They read: git, `gh`, the files of your project, and with `ou-on-en-est` one read-only `ssh` and `curl` per check. `ou-on-en-est` also runs `git fetch`, which only updates remote-tracking branches.
- They never change your code, your branches or your server. `/apk copy` copies the APK when you ask. `garde-prod` with `requireBackup` on refuses a production database write until a backup exists; that is the only time a mod blocks anything.
- Nothing leaves your machine: no telemetry, no third-party service.

## Develop

```bash
claude plugin validate <mod>
claude plugin test <mod>
```

Rules of the repo, so that every mod can be published:
- nothing specific to one install in the code: servers, paths and names go through `userConfig`;
- every visible text goes through the mod's `messages(lang)` table, in French and English;
- calculations live in `hooks/logic.ts`, with no engine call, tested on their own; rendering lives in `hooks/register.tsx`, tested on at least two surfaces;
- a band above the prompt stacks with the other mods' (`next(e)` drawn below);
- read-only by default: a mod that refuses or changes something does so behind an explicit setting.

Issues and pull requests are welcome.

## License

[MIT](LICENSE) © Oktay Gençer

---

[Version française](README.fr.md)
