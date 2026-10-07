// Garde-prod : chaque commande qui touche la production, la sauvegarde avant une écriture
// en base, et les commandes refusées gardées prêtes à lancer soi-même.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { ProdEvent } from '../types'
import { asBang, classify, hasFreshBackup, isRefusal, messages, shorten, splitList } from './logic'

const events = atom({ plugin: 'garde-prod', key: 'events' } as const, [])
const pending = atom({ plugin: 'garde-prod', key: 'pending' } as const, [])
const lastBackupAt = atom({ plugin: 'garde-prod', key: 'lastBackupAt' } as const, null)

const PANE = 'garde-prod'

/** Couleurs du thème choisi avec /theme-mods (fichier ~/.claude/mods-theme). */
const COLORS: Record<string, { acc: string; ok: string; warn: string; bad: string; dim: string }> = {
  graphite: { acc: '#7cc4fa', ok: '#4cc38a', warn: '#e6ad4c', bad: '#e5675e', dim: '#8c95a2' },
  olive: { acc: '#d6a94e', ok: '#62c08c', warn: '#e6ad4c', bad: '#e2665d', dim: '#80968a' },
  crepuscule: { acc: '#f4a988', ok: '#6fd3a8', warn: '#e9c46a', bad: '#ef6f6c', dim: '#9d94b0' },
  papier: { acc: '#2f62c8', ok: '#1f7a4d', warn: '#9a6200', bad: '#c23b32', dim: '#676b72' },
  contraste: { acc: '#ffd400', ok: '#5cff7a', warn: '#ffd400', bad: '#ff5c5c', dim: '#cfcfcf' },
}
let themeName = 'graphite'

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

function hm(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 5)
}

async function setStatus($: EngineInterface, lang: string) {
  const m = messages(lang)
  const list = (await read($, events)).filter(ev => ev.target !== null)
  if (list.length === 0) return $.ui.status(undefined)
  const backup = await read($, lastBackupAt)
  $.ui.status(`${m.status(list.length)} · ${backup ? m.backupOk(hm(backup)) : m.backupNone}`)
}

export const register: Register = (on, options: PluginOptions) => {
  const lang = String(options.language ?? 'fr')
  const m = messages(lang)
  const hosts = () => splitList(String(options.prodHosts ?? ''))
  const maxAge = Number(options.backupMaxAgeMinutes ?? 120)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'prod', description: m.commandDesc })
    await loadTheme($)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const { kinds, target } = classify(e.command, hosts(), String(options.backupPattern ?? ''))
    if (kinds.length === 0) {
      const ran = await next(e)
      return ran
    }
    const now = await $.clock.now()
    const isDbWrite = kinds.includes('dbwrite')
    const hadBackup = isDbWrite ? hasFreshBackup(await read($, lastBackupAt), now, maxAge) : undefined

    if (isDbWrite && !hadBackup && options.requireBackup === true) {
      const last = await read($, lastBackupAt)
      const age = last === null ? m.never : m.since(Math.round((now - last) / 60_000))
      return { deny: m.deny(age) }
    }

    const ev: ProdEvent = { id: e.tool_use_id, at: now, kinds, command: e.command, target, outcome: 'running', hadBackup }
    await update($, events, list => [...list, ev].slice(-100))
    if (target) $.ui.toast(m.toastProd(shorten(e.command, 60)), { timeoutMs: 6000 })
    if (isDbWrite && !hadBackup) $.ui.toast(m.toastNoBackup, { timeoutMs: 10_000 })
    await setStatus($, lang)

    const ran = await next(e)
    const refusal = isRefusal(ran as { deny?: string; isError?: boolean; text?: string })
    const outcome: ProdEvent['outcome'] = refusal ? 'blocked' : ran.isError ? 'error' : 'ok'
    await update($, events, list => list.map(x => (x.id === ev.id ? { ...x, outcome, detail: refusal ?? undefined } : x)))
    if (refusal) {
      await update($, pending, list => [...list.filter(p => p.command !== e.command), { at: now, command: e.command, reason: refusal }].slice(-20))
      $.ui.toast(m.toastBlocked(shorten(e.command, 50)), { timeoutMs: 8000 })
    } else if (outcome === 'ok' && kinds.includes('backup')) {
      const t = await $.clock.now()
      await update($, lastBackupAt, () => t)
    }
    await setStatus($, lang)
    return ran
  })

  on('command.run', { command: 'prod' }, async $ => {
    await loadTheme($)
    const opened = await $.ui.open({ id: PANE, title: m.paneTitle })
    const list = await read($, events)
    const todo = await read($, pending)
    const lines = [m.summary(list.length, todo.length)]
    if (hosts().length === 0) lines.push(m.configure)
    if (!opened.isPlaced) for (const p of todo) lines.push(asBang(p.command))
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const list = (await read($, events)).filter(ev => ev.target !== null)
    const todo = await read($, pending)
    if (e.props.hasSurvey || (list.length === 0 && todo.length === 0)) return below
    const { Box, Text } = $.ui.resolve(e)
    const c = COLORS[themeName] ?? COLORS.graphite!
    const backup = await read($, lastBackupAt)
    const unsafe = list.some(ev => ev.kinds.includes('dbwrite') && ev.hadBackup === false)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          {list.length > 0 && <Text color={c.bad} bold>{m.status(list.length)}</Text>}
          {list.length > 0 && (
            <Text color={unsafe ? c.bad : backup ? c.ok : c.dim}> · {backup ? m.backupOk(hm(backup)) : m.backupNone}</Text>
          )}
          {todo.length > 0 && (
            <Text color={c.warn}>
              {list.length > 0 ? ' · ' : ''}
              {todo.length} {m.runYourself.toLowerCase()} (/prod)
            </Text>
          )}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = COLORS[themeName] ?? COLORS.graphite!
    const list = await read($, events)
    const todo = await read($, pending)
    const width = Math.max(20, e.props.bodyColumns - 4)
    const tone = (ev: ProdEvent) =>
      ev.outcome === 'blocked' ? c.warn : ev.outcome === 'error' ? c.bad : ev.kinds.includes('dbwrite') && ev.hadBackup === false ? c.bad : ev.target ? c.acc : c.dim

    return (
      <Box flexDirection="column" gap={1}>
        {todo.length > 0 && (
          <Box flexDirection="column">
            <Text color={c.warn} bold>
              {m.runYourself.toUpperCase()}
            </Text>
            {todo.map((p, i) => (
              <Box flexDirection="column">
                <Text>{asBang(p.command)}</Text>
                <Box flexDirection="row" justifyContent="space-between">
                  <Text color={c.dim} wrap="truncate-end">
                    {p.reason}
                  </Text>
                  <Button
                    key={`copy:${i}`}
                    label={m.copy}
                    onPress={async press => {
                      const r = await $.ui.copy({ text: asBang(p.command), surface: press.surface })
                      if (r.isCopied) $.ui.toast(m.copied)
                    }}
                  />
                </Box>
              </Box>
            ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text color={c.dim} bold>
            {m.session.toUpperCase()}
          </Text>
          {list.length === 0 && <Text color={c.dim}>{m.nothing}</Text>}
          {hosts().length === 0 && <Text color={c.dim}>{m.configure}</Text>}
          {[...list].reverse().map(ev => (
            <Box flexDirection="column">
              <Text>
                <Text color={c.dim}>{hm(ev.at)} </Text>
                <Text color={tone(ev)} bold>
                  {ev.kinds.map(k => m.kind[k]).join(' + ')}
                </Text>
                <Text color={c.dim}> · {m.outcome[ev.outcome]}</Text>
                {ev.kinds.includes('dbwrite') && (
                  <Text color={ev.hadBackup ? c.ok : c.bad}> · {ev.hadBackup ? m.withBackup : m.backupNone}</Text>
                )}
              </Text>
              <Text color={c.dim} wrap="truncate-end">
                {shorten(ev.command, width)}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
