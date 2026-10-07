// Calculs purs du mod APK : rien ici ne touche à l'engine, tout se teste seul.
import type { Apk, Build, Freshness } from '../types'

export type Lang = 'fr' | 'en'

/** La langue d'un réglage : `en`, sinon le français. */
export function toLang(value: unknown): Lang {
  return value === 'en' ? 'en' : 'fr'
}

const plural = (n: number, word: string) => `${word}${n > 1 ? 's' : ''}`

/** Taille au-delà de laquelle l'envoi direct d'un fichier échoue (30 Mio). */
export const SEND_LIMIT_BYTES = 30 * 1024 * 1024

/** Où Gradle dépose les APK, du plus utile au moins utile. */
export const APK_DIRS = ['android/app/build/outputs/apk/release', 'android/app/build/outputs/apk/debug']

/** Dossiers de build à ignorer quand on cherche des fichiers modifiés. */
const BUILD_OUTPUT = /^(android\/app\/build|android\/build|android\/\.gradle|ios\/build|node_modules|\.expo)\//

/** `versionCode 4` (build.gradle) ou `"versionCode": 4` (app.json). */
export function parseVersionCode(text: string): number | null {
  const m = text.match(/versionCode["']?\s*[:=]?\s*(\d+)/)
  return m?.[1] ? Number(m[1]) : null
}

/** `versionName "1.1.0"` (build.gradle) ou `"version": "1.1.0"` (app.json). */
export function parseVersionName(text: string): string | null {
  const m = text.match(/versionName\s+["']([^"']+)["']/) ?? text.match(/"version"\s*:\s*"([^"]+)"/)
  return m?.[1] ?? null
}

/** Une commande qui lance un build Android. */
export function isBuildCommand(command: string): boolean {
  return /gradlew[^|;&]*\b(assemble|bundle)\w*/i.test(command) || /\beas\s+build\b/.test(command) || /expo\s+run:android/.test(command)
}

export type BuildOutcome = { status: 'ok' | 'failed'; detail: string }

/** Lit la sortie d'un build : réussite, échec, manque de mémoire, processus tué. */
export function classifyBuildOutput(text: string, lang: Lang = 'fr'): BuildOutcome | null {
  const m = messages(lang)
  const oom = text.match(/OutOfMemoryError(?::\s*([\w ]+))?/)
  if (oom) return { status: 'failed', detail: m.oom(oom[1]?.trim() ?? '') }
  if (/\bKilled\b|exit code 137|signal 9/.test(text)) return { status: 'failed', detail: m.killed }
  const ok = text.match(/BUILD SUCCESSFUL in ([\w ]+)/)
  if (ok) return { status: 'ok', detail: m.succeededIn(ok[1]?.trim() ?? '') }
  if (/BUILD FAILED|FAILURE: Build failed/.test(text)) {
    const what = text.match(/\* What went wrong:\s*\n([^\n]+)/)
    return { status: 'failed', detail: what?.[1]?.trim() ?? 'BUILD FAILED' }
  }
  return null
}

/** La dernière tâche Gradle affichée : `> Task :app:mergeReleaseResources`. */
export function lastGradleTask(text: string): string | null {
  const tasks = text.match(/> Task :[\w:-]+/g)
  return tasks?.[tasks.length - 1]?.slice(2) ?? null
}

/** Les fichiers modifiés de `git status --porcelain`, sans les sorties de build. */
export function dirtyPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map(line => line.slice(3).trim())
    .map(path => (path.includes(' -> ') ? (path.split(' -> ')[1] ?? path) : path))
    .filter(path => path.length > 0 && !BUILD_OUTPUT.test(path))
}

export type Verdict =
  | { kind: 'none' }
  | { kind: 'fresh' }
  | { kind: 'stale'; reason: string }

/** L'APK reflète-t-il le code actuel ? */
export function verdict(apk: Apk | null, f: Freshness | null, lang: Lang = 'fr'): Verdict {
  const m = messages(lang)
  if (!apk) return { kind: 'none' }
  if (!f || (f.commitsSince === 0 && f.dirtySince === 0)) return { kind: 'fresh' }
  const parts: string[] = []
  if (f.commitsSince > 0) parts.push(`${f.commitsSince} ${plural(f.commitsSince, 'commit')}`)
  if (f.dirtySince > 0) parts.push(m.changedFiles(f.dirtySince))
  return { kind: 'stale', reason: m.sinceBuild(parts.join(' + ')) }
}

/** 100 270 080 → « 96 Mo » (« 96 MB » en anglais). */
export function formatSize(bytes: number, lang: Lang = 'fr'): string {
  const mo = bytes / (1024 * 1024)
  const unit = lang === 'en' ? 'MB' : 'Mo'
  if (mo >= 10) return `${Math.round(mo)} ${unit}`
  const one = mo.toFixed(1)
  return `${lang === 'en' ? one : one.replace('.', ',')} ${unit}`
}

/** 760 000 → « 12 min 40 s ». */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}

/** « 14:52 » aujourd'hui, « hier 21:10 », sinon « 7 sept. 21:10 ». */
export function formatWhen(ms: number, now: number, lang: Lang = 'fr'): string {
  const m = messages(lang)
  const d = new Date(ms)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (x: number) => new Date(x).toDateString()
  if (day(ms) === day(now)) return hm
  if (day(ms) === day(now - 86_400_000)) return `${m.yesterday} ${hm}`
  return `${d.toLocaleDateString(m.locale, { day: 'numeric', month: 'short' })} ${hm}`
}

/** Le texte court de la ligne d'état. */
export function statusText(apk: Apk | null, f: Freshness | null, build: Build | null, now: number, lang: Lang = 'fr'): string | undefined {
  const m = messages(lang)
  if (build?.status === 'running') return `${m.buildAndroid} ${formatDuration(now - build.startedAt)}`
  if (build?.status === 'failed' && build.endedAt && now - build.endedAt < 30 * 60_000) return m.buildFailed(build.detail ?? '')
  const v = verdict(apk, f, lang)
  if (v.kind === 'none') return undefined
  const version = apk?.versionCode ? `v${apk.versionCode} ` : ''
  return `APK ${version}${v.kind === 'fresh' ? m.fresh : m.stale}`
}

const MESSAGES = {
  fr: {
    oom: (what: string) => `manque de mémoire (OutOfMemoryError${what ? ` : ${what}` : ''})`,
    killed: 'processus tué (souvent la mémoire)',
    succeededIn: (d: string) => `réussi en ${d}`,
    changedFiles: (n: number) => `${n} ${plural(n, 'fichier')} ${plural(n, 'modifié')}`,
    sinceBuild: (what: string) => `${what} depuis le build`,
    yesterday: 'hier',
    locale: 'fr-FR',
    buildAndroid: 'build Android',
    buildFailed: (detail: string) => `build échoué : ${detail}`,
    fresh: 'à jour',
    stale: 'périmé',
    outsideClaude: 'gradlew (lancé hors de Claude)',
    noApkProduced: "arrêté sans produire d'APK",
    toastOk: (d: string, what: string) => `Build Android réussi en ${d}${what}`,
    toastFailed: (d: string, detail: string) => `Build Android échoué après ${d} : ${detail}`,
    unknownCause: 'cause inconnue',
    stoppedDuring: (task: string) => `arrêté pendant ${task}`,
    error: 'erreur',
    commandDesc: "État de l'APK Android (« /apk copier » le dépose dans le dossier réglé)",
    commandHint: '[copier]',
    copyWords: ['copier', 'copy'],
    noProjectIn: (dir: string) => `Aucun projet Android ici ni dans ${dir}.`,
    noProject: 'Aucun projet Android ici. Règle « appDir » de apk-fraicheur (/config) pour en suivre un depuis n’importe où.',
    noApkYet: (where: string) => `Pas encore d'APK dans ${where}.`,
    setCopyTo: 'Règle d’abord « copyTo » de apk-fraicheur (/config), ex. /mnt/c/Users/<toi>/Downloads.',
    copied: (to: string) => `APK copié : ${to}`,
    copyFailed: (err: string) => `Copie impossible : ${err}`,
    built: 'construit',
    staleLine: (reason: string) => `Périmé : ${reason}.`,
    freshLine: 'À jour avec le code.',
    tooBig: 'Trop gros pour l’envoi direct (30 Mo) : « /apk copier » le dépose dans le dossier réglé.',
    building: 'build en cours',
    last: 'dernier',
    tooBigBand: "trop gros pour l'envoi : /apk copier",
  },
  en: {
    oom: (what: string) => `out of memory (OutOfMemoryError${what ? `: ${what}` : ''})`,
    killed: 'process killed (often memory)',
    succeededIn: (d: string) => `succeeded in ${d}`,
    changedFiles: (n: number) => `${n} ${plural(n, 'file')} changed`,
    sinceBuild: (what: string) => `${what} since the build`,
    yesterday: 'yesterday',
    locale: 'en-GB',
    buildAndroid: 'Android build',
    buildFailed: (detail: string) => `build failed: ${detail}`,
    fresh: 'up to date',
    stale: 'stale',
    outsideClaude: 'gradlew (started outside Claude)',
    noApkProduced: 'stopped without producing an APK',
    toastOk: (d: string, what: string) => `Android build succeeded in ${d}${what}`,
    toastFailed: (d: string, detail: string) => `Android build failed after ${d}: ${detail}`,
    unknownCause: 'unknown cause',
    stoppedDuring: (task: string) => `stopped during ${task}`,
    error: 'error',
    commandDesc: 'Android APK status (“/apk copy” puts it in the configured folder)',
    commandHint: '[copy]',
    copyWords: ['copy', 'copier'],
    noProjectIn: (dir: string) => `No Android project here or in ${dir}.`,
    noProject: 'No Android project here. Set apk-fraicheur’s “appDir” (/config) to follow one from anywhere.',
    noApkYet: (where: string) => `No APK yet in ${where}.`,
    setCopyTo: 'First set apk-fraicheur’s “copyTo” (/config), e.g. /mnt/c/Users/<you>/Downloads.',
    copied: (to: string) => `APK copied: ${to}`,
    copyFailed: (err: string) => `Copy failed: ${err}`,
    built: 'built',
    staleLine: (reason: string) => `Stale: ${reason}.`,
    freshLine: 'Up to date with the code.',
    tooBig: 'Too big to send directly (30 MB): “/apk copy” puts it in the configured folder.',
    building: 'building',
    last: 'last',
    tooBigBand: 'too big to send: /apk copy',
  },
} as const

/** Les textes affichés, dans la langue du réglage `language`. */
export function messages(lang: Lang) {
  return MESSAGES[lang]
}
