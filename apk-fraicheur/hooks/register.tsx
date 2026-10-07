// APK fraîcheur : l'APK reflète-t-il le code ? Build en cours, échec, taille, copie.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Apk, Build, Freshness } from '../types'
import {
  APK_DIRS,
  classifyBuildOutput,
  dirtyPaths,
  formatDuration,
  formatSize,
  formatWhen,
  isBuildCommand,
  lastGradleTask,
  messages,
  parseVersionCode,
  parseVersionName,
  SEND_LIMIT_BYTES,
  statusText,
  toLang,
  verdict,
} from './logic'
import type { Lang } from './logic'

const appDir = atom({ plugin: 'apk-fraicheur', key: 'appDir' } as const, null)
const apk = atom({ plugin: 'apk-fraicheur', key: 'apk' } as const, null)
const freshness = atom({ plugin: 'apk-fraicheur', key: 'freshness' } as const, null)
const build = atom({ plugin: 'apk-fraicheur', key: 'build' } as const, null)
const lastDurationMs = atom({ plugin: 'apk-fraicheur', key: 'lastDurationMs' } as const, null)
const now = atom({ plugin: 'apk-fraicheur', key: 'now' } as const, 0)

/** Couleurs du thème choisi dans suivi-conso (/theme-mods), Graphite sinon. */
const COLORS: Record<string, { acc: string; ok: string; warn: string; bad: string; dim: string }> = {
  graphite: { acc: '#7cc4fa', ok: '#4cc38a', warn: '#e6ad4c', bad: '#e5675e', dim: '#8c95a2' },
  olive: { acc: '#d6a94e', ok: '#62c08c', warn: '#e6ad4c', bad: '#e2665d', dim: '#80968a' },
  crepuscule: { acc: '#f4a988', ok: '#6fd3a8', warn: '#e9c46a', bad: '#ef6f6c', dim: '#9d94b0' },
  papier: { acc: '#2f62c8', ok: '#1f7a4d', warn: '#9a6200', bad: '#c23b32', dim: '#676b72' },
  contraste: { acc: '#ffd400', ok: '#5cff7a', warn: '#ffd400', bad: '#ff5c5c', dim: '#cfcfcf' },
}

let lastRefresh = 0

let themeName = 'graphite'
let lang: Lang = 'fr'
let m = messages(lang)

/** Relit le thème commun écrit par /theme-mods (fichier ~/.claude/mods-theme). */
async function loadTheme($: EngineInterface) {
  try {
    const home = await $.env.get('HOME')
    if (!home || !(await $.fs.exists(`${home}/.claude/mods-theme`))) return
    const name = (await $.fs.read(`${home}/.claude/mods-theme`)).trim()
    if (name in COLORS) themeName = name
  } catch {
    // thème par défaut
  }
}

function palette() {
  return COLORS[themeName] ?? COLORS.graphite!
}

/** Le projet suivi : le dossier courant s'il a un `android/app`, sinon le réglage. */
async function findAppDir($: EngineInterface, cwd: string, configured: string): Promise<string | null> {
  for (const dir of [cwd, configured]) {
    if (dir && (await $.fs.exists(`${dir}/android/app`))) return dir
  }
  return null
}

/** Le dernier APK sorti de Gradle, avec sa version. */
async function findApk($: EngineInterface, dir: string): Promise<Apk | null> {
  let best: { path: string; size: number; mtimeMs: number } | null = null
  for (const sub of APK_DIRS) {
    const full = `${dir}/${sub}`
    if (!(await $.fs.exists(full))) continue
    for (const entry of await $.fs.list(full)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.apk')) continue
      if (!best || entry.mtimeMs > best.mtimeMs) best = { path: `${full}/${entry.name}`, size: entry.size, mtimeMs: entry.mtimeMs }
    }
    if (best) break
  }
  if (!best) return null
  let versionCode: number | null = null
  let versionName: string | null = null
  for (const file of ['android/app/build.gradle', 'app.json']) {
    if (!(await $.fs.exists(`${dir}/${file}`))) continue
    const text = await $.fs.read(`${dir}/${file}`)
    versionCode ??= parseVersionCode(text)
    versionName ??= parseVersionName(text)
  }
  return { path: best.path, sizeBytes: best.size, builtAt: best.mtimeMs, versionCode, versionName }
}

/** Commits et fichiers modifiés après le build. */
async function findFreshness($: EngineInterface, dir: string, a: Apk): Promise<Freshness | null> {
  const since = Math.floor(a.builtAt / 1000)
  const log = await $.process.run(['git', '-C', dir, 'log', `--since=@${since}`, '--format=%h', 'HEAD'])
  if (log.exitCode !== 0) return null
  const head = await $.process.run(['git', '-C', dir, 'rev-parse', '--short', 'HEAD'])
  const status = await $.process.run(['git', '-C', dir, 'status', '--porcelain'])
  let dirtySince = 0
  for (const path of dirtyPaths(status.stdout).slice(0, 200)) {
    try {
      const st = await $.fs.stat(`${dir}/${path}`)
      if (st.mtimeMs > a.builtAt) dirtySince += 1
    } catch {
      dirtySince += 1 // supprimé depuis le build
    }
  }
  return {
    commitsSince: log.stdout.split('\n').filter(Boolean).length,
    dirtySince,
    headSha: head.stdout.trim(),
  }
}

async function refresh($: EngineInterface) {
  lastRefresh = await $.clock.now()
  const dir = await read($, appDir)
  if (!dir) return
  const a = await findApk($, dir)
  await update($, apk, () => a)
  const f = a ? await findFreshness($, dir, a) : null
  await update($, freshness, () => f)
  await setStatus($)
}

async function setStatus($: EngineInterface) {
  $.ui.status(statusText(await read($, apk), await read($, freshness), await read($, build), await $.clock.now(), lang))
}

/** Clôt le build suivi, prévient, et relit l'APK. */
async function finish($: EngineInterface, status: Build['status'], detail: string | undefined) {
  const t = await $.clock.now()
  const b = await read($, build)
  if (!b || b.status !== 'running') return
  await update($, build, () => ({ ...b, status, endedAt: t, detail: detail ?? b.detail }))
  await refresh($)
  const a = await read($, apk)
  if (status === 'ok') {
    await update($, lastDurationMs, () => t - b.startedAt)
    const what = a ? ` · APK${a.versionCode ? ` v${a.versionCode}` : ''} ${formatSize(a.sizeBytes, lang)}` : ''
    $.ui.toast(m.toastOk(formatDuration(t - b.startedAt), what), { timeoutMs: 10_000 })
  } else {
    $.ui.toast(m.toastFailed(formatDuration(t - b.startedAt), detail ?? m.unknownCause), { timeoutMs: 15_000 })
  }
}

/** Toutes les 15 s : un build Gradle tourne-t-il (lancé par Claude ou à la main) ? */
async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)
  if (!(await read($, appDir))) return
  const ps = await $.process.run(['pgrep', '-f', 'GradleWrapperMain'])
  const isRunning = ps.exitCode === 0
  const b = await read($, build)
  if (isRunning && b?.status !== 'running') {
    await update($, build, () => ({ startedAt: t, command: m.outsideClaude, status: 'running' as const }))
  } else if (!isRunning && b?.status === 'running' && t - b.startedAt > 20_000) {
    const before = (await read($, apk))?.builtAt ?? 0
    await refresh($)
    const after = (await read($, apk))?.builtAt ?? 0
    await finish($, after > before || after > b.startedAt ? 'ok' : 'failed', after > b.startedAt ? undefined : m.noApkProduced)
  }
  if (t - lastRefresh > 60_000) {
    await loadTheme($)
    await refresh($)
  }
  else await setStatus($)
}

export const register: Register = (on, options) => {
  lang = toLang(options.language)
  m = messages(lang)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'apk',
      description: m.commandDesc,
      argumentHint: m.commandHint,
    })
    const dir = await findAppDir($, e.cwd, String(options.appDir ?? ''))
    await update($, appDir, () => dir)
    await loadTheme($)
    await refresh($)
    $.clock.every(15_000, () => void tick($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if ((await $.clock.now()) - lastRefresh > 10_000) await refresh($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isBuildCommand(e.command)) return next(e)
    const t = await $.clock.now()
    await update($, build, () => ({ startedAt: t, command: e.command.slice(0, 80), status: 'running' }))
    await setStatus($)
    const ran = await next(e)
    if (e.run_in_background) return ran // la fin sera vue par tick()
    const text = ran.text ?? (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))
    const outcome = classifyBuildOutput(text, lang)
    const task = lastGradleTask(text)
    if (outcome) await finish($, outcome.status, outcome.detail)
    else await finish($, ran.isError ? 'failed' : 'ok', ran.isError ? (task ? m.stoppedDuring(task) : m.error) : undefined)
    return ran
  })

  on('command.run', { command: 'apk' }, async ($, e) => {
    const dir = await read($, appDir)
    if (!dir) return { text: options.appDir ? m.noProjectIn(String(options.appDir)) : m.noProject }
    await refresh($)
    const a = await read($, apk)
    if (!a) return { text: m.noApkYet(`${dir}/${APK_DIRS[0]}`) }

    if ((m.copyWords as readonly string[]).includes(e.args.trim())) {
      const to = String(options.copyTo ?? '')
      if (!to) return { text: m.setCopyTo }
      const app = dir.split('/').filter(Boolean).pop() ?? 'app'
      const name = `${app}-${a.versionCode ? `v${a.versionCode}-` : ''}${new Date(a.builtAt).toISOString().slice(0, 10)}.apk`
      const cp = await $.process.run(['cp', a.path, `${to}/${name}`])
      return { text: cp.exitCode === 0 ? m.copied(`${to}/${name}`) : m.copyFailed(cp.stderr.trim()) }
    }

    const t = await $.clock.now()
    const v = verdict(a, await read($, freshness), lang)
    const lines = [
      `APK${a.versionCode ? ` v${a.versionCode}` : ''}${a.versionName ? ` (${a.versionName})` : ''} · ${m.built} ${formatWhen(a.builtAt, t, lang)} · ${formatSize(a.sizeBytes, lang)}`,
      v.kind === 'stale' ? m.staleLine(v.reason) : m.freshLine,
      a.path,
    ]
    if (a.sizeBytes > SEND_LIMIT_BYTES) lines.push(m.tooBig)
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const a = await read($, apk)
    const b = await read($, build)
    if (e.props.hasSurvey || (!a && !b)) return below
    const { Box, Text } = $.ui.resolve(e)
    const c = palette()
    const t = Math.max(await read($, now), await $.clock.now())
    const f = await read($, freshness)
    const v = verdict(a, f, lang)
    const isWide = e.props.bodyColumns >= 90
    const recentFail = b?.status === 'failed' && b.endedAt !== undefined && t - b.endedAt < 30 * 60_000
    const typical = await read($, lastDurationMs)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          <Text color={c.acc}>APK </Text>
          {b?.status === 'running' && (
            <Text>
              <Text color={c.warn}>
                {m.building} {formatDuration(t - b.startedAt)}
              </Text>
              {typical !== null && <Text color={c.dim}> ({m.last}{lang === 'en' ? ': ' : ' : '}{formatDuration(typical)})</Text>}
              {isWide && b.detail && <Text color={c.dim}> · {b.detail}</Text>}
            </Text>
          )}
          {b?.status !== 'running' && recentFail && <Text color={c.bad}>✗ {m.buildFailed(b?.detail ?? '')} </Text>}
          {b?.status !== 'running' && a && (
            <Text>
              <Text>
                {a.versionCode ? `v${a.versionCode} · ` : ''}
                {formatWhen(a.builtAt, t, lang)}{' '}
              </Text>
              {v.kind === 'fresh' && <Text color={c.ok}>✓ {m.fresh}</Text>}
              {v.kind === 'stale' && <Text color={c.warn}>✗ {m.stale}{lang === 'en' ? ': ' : ' : '}{v.reason}</Text>}
              {isWide && <Text color={c.dim}> · {formatSize(a.sizeBytes, lang)}</Text>}
              {isWide && a.sizeBytes > SEND_LIMIT_BYTES && <Text color={c.dim}> ({m.tooBigBand})</Text>}
            </Text>
          )}
        </Box>
        {below}
      </Box>
    )
  })
}
