// Suivi d'utilisation : quota 5 h et 7 j, contexte, coût, prévision, conseils et thèmes.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot, ThemeName } from '../types'
import type { Lang } from './logic'
import {
  addSample,
  addSpend,
  addToDay,
  addTurn,
  chargeLastTurn,
  estimateTokens,
  formatClock,
  formatIn,
  formatTokens,
  formatUsd,
  gauge,
  isThemeName,
  lastSevenDays,
  mcpServerOf,
  messages,
  project,
  sparkline,
  spendTarget,
  statusLine,
  THEME_NAMES,
  THEMES,
  tips,
  toLang,
  turnTokens,
  upsertSession,
} from './logic'

const PANE = 'conso'

const snapshot = atom({ plugin: 'suivi-conso', key: 'snapshot' } as const, null)
const samples = atom({ plugin: 'suivi-conso', key: 'samples' } as const, [])
const turns = atom({ plugin: 'suivi-conso', key: 'turns' } as const, [])
const spends = atom({ plugin: 'suivi-conso', key: 'spends' } as const, [])
const slices = atom({ plugin: 'suivi-conso', key: 'slices' } as const, [])
const mcp = atom({ plugin: 'suivi-conso', key: 'mcp' } as const, [])
const usedServers = atom({ plugin: 'suivi-conso', key: 'usedServers' } as const, [])
const days = atom({ plugin: 'suivi-conso', key: 'days' } as const, [])
const sessions = atom({ plugin: 'suivi-conso', key: 'sessions' } as const, [])
const theme = atom({ plugin: 'suivi-conso', key: 'theme' } as const, 'graphite')
const isBandHidden = atom({ plugin: 'suivi-conso', key: 'isBandHidden' } as const, false)

/** Seuils du quota 5 h déjà signalés, pour ne prévenir qu'une fois. */
const alerted = new Set<string>()
let startedAt = 0
let cwd = ''
let breakdownAt = 0
let lang: Lang = 'fr'
let m = messages(lang)

type Measured = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

function toSnapshot(at: number, m: Measured): Snapshot {
  const win = (kind: string) => {
    const r = m.rateLimits.find(l => l.kind === kind)
    return r ? { percentUsed: r.percentUsed, resetsAt: r.resetsAt } : undefined
  }
  return {
    at,
    contextTokens: m.context.tokens,
    contextWindow: m.context.window,
    contextPercent: m.context.percent,
    five: win('five_hour'),
    week: win('seven_day'),
    usd: m.cost?.usd,
  }
}

/** Relit la répartition du contexte (estimée localement, sans requête). */
async function refreshBreakdown($: EngineInterface, now: number) {
  if (now - breakdownAt < 60_000) return
  breakdownAt = now
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b) return
  await update($, slices, () =>
    b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ name: c.name, tokens: c.tokens }))
      .sort((x, y) => y.tokens - x.tokens),
  )
  const byServer = new Map<string, number>()
  for (const t of b.mcpTools) {
    if (t.isLoaded) byServer.set(t.serverName, (byServer.get(t.serverName) ?? 0) + t.tokens)
  }
  await update($, mcp, () =>
    [...byServer].map(([name, tokens]) => ({ name, tokens })).sort((x, y) => y.tokens - x.tokens),
  )
}

/** Intègre une nouvelle mesure : historique, prévision, alertes, ligne d'état. */
async function absorb($: EngineInterface, m: Measured) {
  const now = await $.clock.now()
  const prev = await read($, snapshot)
  const next = toSnapshot(now, m)
  await update($, snapshot, () => next)

  if (next.five) {
    const five = next.five
    await update($, samples, list => addSample(list, { at: now, percentUsed: five.percentUsed }))
  }

  const usdDelta = prev?.usd !== undefined && next.usd !== undefined ? next.usd - prev.usd : 0
  const weekDelta =
    prev?.week && next.week && next.week.percentUsed >= prev.week.percentUsed
      ? next.week.percentUsed - prev.week.percentUsed
      : 0
  if (usdDelta > 0) await update($, turns, list => chargeLastTurn(list, usdDelta))
  if (usdDelta > 0 || weekDelta > 0) {
    const all = await update($, days, list => addToDay(list, now, weekDelta, usdDelta))
    await $.store.set('days', all)
  }
  if (next.usd !== undefined && startedAt > 0) {
    const row = {
      startedAt,
      cwd,
      usd: next.usd,
      maxContext: Math.max(next.contextTokens ?? 0, (await read($, sessions)).find(s => s.startedAt === startedAt)?.maxContext ?? 0),
    }
    const all = await update($, sessions, list => upsertSession(list, row))
    await $.store.set('sessions', all)
  }

  $.ui.status(statusLine(next, lang))
  await warn($, next)
}

/** Prévient une seule fois par seuil franchi. */
async function warn($: EngineInterface, s: Snapshot) {
  const once = (key: string, text: string) => {
    if (alerted.has(key)) return
    alerted.add(key)
    $.ui.toast(text, { timeoutMs: 8000 })
  }
  const five = s.five
  if (five) {
    const window = five.resetsAt ?? 'w'
    if (five.percentUsed >= 90) once(`90:${window}`, m.toast90(Math.round(100 - five.percentUsed)))
    else if (five.percentUsed >= 75) once(`75:${window}`, m.toast75(Math.round(five.percentUsed)))
    const p = project(await read($, samples), s.at, five.resetsAt)
    if (p?.isBeforeReset && p.exhaustAt - s.at < 90 * 60_000) {
      once(`proj:${window}`, m.toastPace(formatClock(p.exhaustAt)))
    }
  }
  if (s.contextPercent !== undefined && s.contextPercent >= 80) {
    once(`ctx:${startedAt}`, m.toastContext(Math.round(s.contextPercent)))
  }
}

/** Écrit le thème dans ~/.claude/mods-theme, où les autres mods de claude-mods le lisent. */
async function shareTheme($: EngineInterface, name: ThemeName) {
  try {
    const home = await $.env.get('HOME')
    if (home) await $.fs.write(`${home}/.claude/mods-theme`, name)
  } catch {
    // Sans ce fichier, les autres mods gardent leur thème par défaut.
  }
}

export const register: Register = (on, options) => {
  lang = toLang(options.language)
  m = messages(lang)
  const tok = (n: number) => formatTokens(n, lang)
  const usd = (n: number) => formatUsd(n, lang)

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'conso',
      description: m.consoDesc,
      argumentHint: m.consoHint,
    })
    await $.command.register({
      name: 'theme-mods',
      description: m.themeDesc(THEME_NAMES.join(', ')),
      argumentHint: m.themeHint,
    })

    const savedTheme = await $.store.get('theme')
    if (typeof savedTheme === 'string' && isThemeName(savedTheme)) {
      await update($, theme, () => savedTheme)
      await shareTheme($, savedTheme)
    }
    const savedDays = await $.store.get('days')
    if (Array.isArray(savedDays)) await update($, days, () => savedDays)
    const savedSessions = await $.store.get('sessions')
    if (Array.isArray(savedSessions)) await update($, sessions, () => savedSessions)

    const usage = await $.session.usage()
    startedAt = usage.startedAt
    await absorb($, usage)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await absorb($, e)
    if (e.changed.includes('context')) await refreshBreakdown($, await $.clock.now())
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.usage) {
      const usage = e.usage
      const at = await $.clock.now()
      await update($, turns, list => addTurn(list, { at, tokens: turnTokens(usage) }))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const tool = String(e.tool)
    const server = mcpServerOf(tool)
    if (server) await update($, usedServers, list => (list.includes(server) ? list : [...list, server]))
    const tokens = estimateTokens(ran.text ?? ran.result)
    if (tokens > 0) {
      const { key, label } = spendTarget(tool, e as unknown as Record<string, unknown>, lang)
      await update($, spends, list => addSpend(list, key, label, tokens))
    }
    return ran
  })

  on('command.run', { command: 'conso' }, async ($, e) => {
    if (['bande', 'band'].includes(e.args.trim())) {
      const hidden = await update($, isBandHidden, v => !v)
      return { text: hidden ? m.bandHidden : m.bandShown }
    }
    breakdownAt = 0
    await refreshBreakdown($, await $.clock.now())
    const opened = await $.ui.open({ id: PANE, title: m.paneTitle })
    const line = statusLine(await read($, snapshot), lang) ?? m.noMeasure
    return { text: opened.isPlaced ? m.paneOpened(line) : line }
  })

  on('command.run', { command: 'theme-mods' }, async ($, e) => {
    const name = e.args.trim().toLowerCase()
    if (!isThemeName(name)) {
      const current = await read($, theme)
      return { text: m.themeCurrent(current, THEME_NAMES.join(', ')) }
    }
    await update($, theme, () => name)
    await $.store.set('theme', name)
    await shareTheme($, name)
    return { text: m.themeSet(name) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || !s || (await read($, isBandHidden))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const c = THEMES[(await read($, theme)) as ThemeName]
    const p = s.five ? project(await read($, samples), s.at, s.five.resetsAt) : null
    const isWide = e.props.bodyColumns >= 90
    const sep = <Text color={c.dim}> │ </Text>
    // Les autres mods (et l'engine) dessinent leur ligne en dessous de la nôtre.
    const below = await next(e)

    return (
      <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap">
        {s.five && (
          <Text>
            <Text color={c.acc}>5 h </Text>
            {isWide && <Text color={c.series[0]}>{gauge(s.five.percentUsed)} </Text>}
            <Text>{m.left(Math.round(100 - s.five.percentUsed))}</Text>
            {p?.isBeforeReset && <Text color={c.warn}> ⚠ {formatClock(p.exhaustAt)}</Text>}
          </Text>
        )}
        {s.week && sep}
        {s.week && (
          <Text>
            <Text color={c.acc}>{m.week} </Text>
            <Text>{Math.round(100 - s.week.percentUsed)} %</Text>
          </Text>
        )}
        {s.contextTokens !== undefined && sep}
        {s.contextTokens !== undefined && (
          <Text>
            <Text color={c.acc}>ctx </Text>
            <Text color={(s.contextPercent ?? 0) >= 80 ? c.warn : undefined}>
              {tok(s.contextTokens)} / {tok(s.contextWindow)}
            </Text>
          </Text>
        )}
        {s.usd !== undefined && sep}
        {s.usd !== undefined && <Text>≈ {usd(s.usd)}</Text>}
        {isWide && <Text color={c.dim}>   /conso</Text>}
      </Box>
      {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const c = THEMES[(await read($, theme)) as ThemeName]
    const s = await read($, snapshot)
    const now = await $.clock.now()
    const sampleList = await read($, samples)
    const turnList = await read($, turns)
    const spendList = await read($, spends)
    const sliceList = await read($, slices)
    const mcpList = await read($, mcp)
    const used = await read($, usedServers)
    const week = lastSevenDays(await read($, days), now)
    const pastSessions = await read($, sessions)
    const p = s?.five ? project(sampleList, now, s.five.resetsAt) : null
    const width = Math.max(10, Math.min(24, e.props.bodyColumns - 22))

    const title = (text: string) => (
      <Text color={c.dim} bold>
        {text.toUpperCase()}
      </Text>
    )
    const row = (label: string, value: string, color?: string) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">{label}</Text>
        <Text color={color ?? c.dim}>{value}</Text>
      </Box>
    )

    if (!s) {
      return (
        <Box flexDirection="column">
          <Text color={c.dim}>{m.noMeasurePane}</Text>
        </Box>
      )
    }

    const advice = tips({ snapshot: s, projection: p, spends: spendList, mcp: mcpList, usedServers: used }, lang)
    const top = spendList.slice(0, 5)
    const costly = [...pastSessions].sort((a, b) => b.usd - a.usd)[0]

    return (
      <Box flexDirection="column" gap={1}>
        {s.five && (
          <Box flexDirection="column">
            {title(m.fiveTitle)}
            <Text>
              <Text color={c.series[0]}>{gauge(s.five.percentUsed, width)}</Text>
              <Text bold> {m.left(Math.round(100 - s.five.percentUsed))}</Text>
            </Text>
            {s.five.resetsAt && (
              <Text color={c.dim}>
                {m.resetAt(formatClock(Date.parse(s.five.resetsAt)), formatIn(Date.parse(s.five.resetsAt) - now, lang))}
              </Text>
            )}
            {p && (
              <Text color={p.isBeforeReset ? c.warn : c.ok}>
                {p.isBeforeReset
                  ? m.paceBad(Math.round(p.ratePerHour), formatClock(p.exhaustAt))
                  : m.paceOk(Math.round(p.ratePerHour))}
              </Text>
            )}
          </Box>
        )}

        {s.week && (
          <Box flexDirection="column">
            {title(m.weekTitle)}
            <Text>
              <Text color={c.series[0]}>{gauge(s.week.percentUsed, width)}</Text>
              <Text bold> {m.left(Math.round(100 - s.week.percentUsed))}</Text>
            </Text>
            {s.week.resetsAt && (
              <Text color={c.dim}>
                {m.weekReset(
                  new Date(Date.parse(s.week.resetsAt)).toLocaleDateString(m.locale, { weekday: 'short', day: 'numeric' }),
                  formatClock(Date.parse(s.week.resetsAt)),
                )}
              </Text>
            )}
          </Box>
        )}

        <Box flexDirection="column">
          {title(m.contextTitle)}
          <Text>
            <Text bold>{tok(s.contextTokens ?? 0)}</Text>
            <Text color={c.dim}> / {tok(s.contextWindow)}{s.contextPercent !== undefined ? ` · ${Math.round(s.contextPercent)} %` : ''}</Text>
          </Text>
          {sliceList.slice(0, 4).map((sl, i) => row(`■ ${sl.name}`, tok(sl.tokens), c.series[i]))}
        </Box>

        <Box flexDirection="column">
          {title(m.sessionTitle)}
          {s.usd !== undefined && row(m.cost, usd(s.usd), c.acc)}
          {row(m.turns, String(turnList.length))}
          {turnList.length > 1 && (
            <Text>
              <Text color={c.series[0]}>{sparkline(turnList.slice(-width).map(t => t.tokens))}</Text>
              <Text color={c.dim}>{m.tokensPerTurn}</Text>
            </Text>
          )}
        </Box>

        {top.length > 0 && (
          <Box flexDirection="column">
            {title(m.topTitle)}
            {top.map(sp => row(sp.count > 1 ? `${sp.label} (×${sp.count})` : sp.label, `~${tok(sp.tokens)}`))}
          </Box>
        )}

        {advice.length > 0 && (
          <Box flexDirection="column">
            {title(m.tipsTitle)}
            {advice.slice(0, 4).map(t => (
              <Text>
                <Text color={t.level === 'warn' ? c.warn : c.dim}>● </Text>
                <Text bold>{t.title}</Text>
                <Text>{lang === 'en' ? ': ' : ' : '}{t.text}</Text>
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          {title(m.historyTitle)}
          <Text>
            <Text color={c.series[0]}>{sparkline(week.map(d => d.weekPercent))}</Text>
            <Text color={c.dim}>  {week.map(d => Math.round(d.weekPercent)).join(' · ')}</Text>
          </Text>
          {costly && costly.usd > 0 && (
            <Text color={c.dim}>
              {m.costliest(costly.cwd.split('/').pop() ?? '', usd(costly.usd), tok(costly.maxContext))}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
