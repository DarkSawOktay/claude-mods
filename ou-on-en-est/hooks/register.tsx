// Où on en est : l'état de tes dépôts et de ce qui tourne sur le VPS, dans un panneau.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Deployed, Health, RepoState } from '../types'
import { messages, parsePairs, parsePr, parseStatus, relationText, repoFlags, splitList, summary, toLang } from './logic'
import type { Lang } from './logic'

const repos = atom({ plugin: 'ou-on-en-est', key: 'repos' } as const, [])
const deployed = atom({ plugin: 'ou-on-en-est', key: 'deployed' } as const, [])
const health = atom({ plugin: 'ou-on-en-est', key: 'health' } as const, [])
const checkedAt = atom({ plugin: 'ou-on-en-est', key: 'checkedAt' } as const, null)
const isRefreshing = atom({ plugin: 'ou-on-en-est', key: 'isRefreshing' } as const, false)

const PANE = 'ou-on-en-est'

/** Couleurs du thème choisi avec /theme-mods (fichier ~/.claude/mods-theme). */
const COLORS: Record<string, { acc: string; ok: string; warn: string; bad: string; dim: string }> = {
  graphite: { acc: '#7cc4fa', ok: '#4cc38a', warn: '#e6ad4c', bad: '#e5675e', dim: '#8c95a2' },
  olive: { acc: '#d6a94e', ok: '#62c08c', warn: '#e6ad4c', bad: '#e2665d', dim: '#80968a' },
  crepuscule: { acc: '#f4a988', ok: '#6fd3a8', warn: '#e9c46a', bad: '#ef6f6c', dim: '#9d94b0' },
  papier: { acc: '#2f62c8', ok: '#1f7a4d', warn: '#9a6200', bad: '#c23b32', dim: '#676b72' },
  contraste: { acc: '#ffd400', ok: '#5cff7a', warn: '#ffd400', bad: '#ff5c5c', dim: '#cfcfcf' },
}
let themeName = 'graphite'
let notes: Record<string, string> = {}
let lastLocal = 0
let cwd = ''
let lang: Lang = 'fr'
let m = messages(lang)

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

async function git($: EngineInterface, dir: string, args: string[], timeoutMs = 10_000) {
  return $.process.run(['git', '-C', dir, ...args], { timeoutMs })
}

/** Les dépôts suivis : ceux du dossier des projets, plus la liste en réglage. */
async function listRepos($: EngineInterface, options: PluginOptions): Promise<string[]> {
  const out: string[] = []
  // Sans réglage : le projet courant et ses voisins (le dossier parent).
  const root = String(options.projectsRoot ?? '') || cwd.replace(/\/[^/]+\/?$/, '')
  if (cwd && (await $.fs.exists(`${cwd}/.git`))) out.push(cwd)
  if (root && (await $.fs.exists(root))) {
    for (const entry of await $.fs.list(root)) {
      const dir = `${root}/${entry.name}`
      if (entry.kind === 'dir' && !out.includes(dir) && (await $.fs.exists(`${dir}/.git`))) out.push(dir)
    }
  }
  for (const dir of splitList(String(options.extraRepos ?? ''))) {
    if (!out.includes(dir) && (await $.fs.exists(`${dir}/.git`))) out.push(dir)
  }
  return out
}

/** Lit un dépôt ; avec `network`, récupère d'abord le distant et la PR. */
async function readRepo($: EngineInterface, dir: string, network: boolean): Promise<RepoState> {
  const name = dir.split('/').filter(Boolean).pop() ?? dir
  const base = { name, path: dir, note: notes[name] ?? null }
  if (network) await git($, dir, ['fetch', '--quiet', '--prune'], 20_000)
  const st = await git($, dir, ['status', '--porcelain=v2', '--branch'])
  if (st.exitCode !== 0) {
    return { ...base, branch: '?', dirty: 0, ahead: 0, behind: 0, noUpstream: true, aheadOfMain: 0, mainBranch: 'main', mainSha: null, pr: null, error: m.statusFailed }
  }
  const s = parseStatus(st.stdout)
  const head = await git($, dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  let mainBranch = head.exitCode === 0 ? head.stdout.trim().replace(/^origin\//, '') : 'main'
  let mainSha = await git($, dir, ['rev-parse', '--short', `origin/${mainBranch}`])
  if (mainSha.exitCode !== 0 && head.exitCode !== 0) {
    mainBranch = 'master'
    mainSha = await git($, dir, ['rev-parse', '--short', 'origin/master'])
  }
  const hasMain = mainSha.exitCode === 0
  const ahead = hasMain ? await git($, dir, ['rev-list', '--count', `origin/${mainBranch}..HEAD`]) : null
  let pr: RepoState['pr'] = null
  if (network && s.branch !== mainBranch) {
    const view = await $.process.run(['gh', 'pr', 'view', '--json', 'number,state,statusCheckRollup'], { cwd: dir, timeoutMs: 15_000 }).catch(() => null)
    if (view && view.exitCode === 0) pr = parsePr(view.stdout)
  } else {
    pr = (await read($, repos)).find(r => r.path === dir)?.pr ?? null
  }
  return {
    ...base,
    branch: s.branch,
    dirty: s.dirty,
    ahead: s.ahead,
    behind: s.behind,
    noUpstream: s.upstream === null,
    aheadOfMain: ahead && ahead.exitCode === 0 ? Number(ahead.stdout.trim()) : 0,
    mainBranch,
    mainSha: hasMain ? mainSha.stdout.trim() : null,
    pr,
  }
}

/** Ce qui tourne sur le VPS : un seul ssh, en lecture seule, pour tous les dépôts. */
async function readVps($: EngineInterface, options: PluginOptions, local: RepoState[]): Promise<Deployed[]> {
  const host = String(options.vpsHost ?? '')
  const pairs = parsePairs(String(options.vpsRepos ?? ''))
  if (!host || pairs.length === 0) return []
  const script = pairs
    .map(p => `echo "@@${p.name} $(git -C '${p.path.replace(/'/g, '')}' rev-parse --short HEAD 2>/dev/null) $(git -C '${p.path.replace(/'/g, '')}' status --porcelain 2>/dev/null | wc -l)"`)
    .join('; ')
  const ssh = await $.process.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', host, script], { timeoutMs: 20_000 }).catch(() => null)
  if (!ssh || ssh.exitCode !== 0) return pairs.map(p => ({ name: p.name, sha: null, relation: 'unreachable', dirty: 0 }))
  const out: Deployed[] = []
  for (const p of pairs) {
    const line = ssh.stdout.split('\n').find(l => l.startsWith(`@@${p.name} `)) ?? ''
    const [, sha = '', dirtyText = '0'] = line.split(/\s+/)
    const repo = local.find(r => r.name === p.name)
    let relation: Deployed['relation'] = 'unknown'
    if (sha && repo?.mainSha) {
      if (repo.mainSha.startsWith(sha) || sha.startsWith(repo.mainSha)) relation = 'equal'
      else if ((await git($, repo.path, ['cat-file', '-e', `${sha}^{commit}`])).exitCode !== 0) relation = 'unknown'
      else {
        const isAncestor = await git($, repo.path, ['merge-base', '--is-ancestor', sha, `origin/${repo.mainBranch}`])
        relation = isAncestor.exitCode === 0 ? 'behind' : 'ahead'
      }
    }
    out.push({ name: p.name, sha: sha || null, relation, dirty: Number(dirtyText) || 0 })
  }
  return out
}

async function readHealth($: EngineInterface, options: PluginOptions): Promise<Health[]> {
  const out: Health[] = []
  for (const url of splitList(String(options.healthUrls ?? ''))) {
    const r = await $.process.run(['curl', '-s', '-o', '/dev/null', '-m', '8', '-w', '%{http_code}', url], { timeoutMs: 12_000 }).catch(() => null)
    const code = r ? Number(r.stdout.trim()) : 0
    out.push({ url, code: code > 0 ? code : null })
  }
  return out
}

async function refresh($: EngineInterface, options: PluginOptions, network: boolean) {
  if (await read($, isRefreshing)) return
  await update($, isRefreshing, () => true)
  try {
    lastLocal = await $.clock.now()
    const list: RepoState[] = []
    for (const dir of await listRepos($, options)) list.push(await readRepo($, dir, network))
    await update($, repos, () => list)
    if (network) {
      await update($, deployed, () => [])
      const vps = await readVps($, options, list)
      await update($, deployed, () => vps)
      const h = await readHealth($, options)
      await update($, health, () => h)
      const t = await $.clock.now()
      await update($, checkedAt, () => t)
    }
    $.ui.status(summary(list, await read($, deployed), lang))
  } finally {
    await update($, isRefreshing, () => false)
  }
}

export const register: Register = (on, options) => {
  lang = toLang(options.language)
  m = messages(lang)

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'ou-on-en-est',
      description: m.commandDesc,
      argumentHint: m.commandHint,
    })
    const saved = await $.store.get('notes')
    if (saved && typeof saved === 'object') notes = saved as Record<string, string>
    await loadTheme($)
    await refresh($, options, false)
    // Distant, VPS et pages : toutes les 10 minutes.
    $.clock.every(10 * 60_000, () => void refresh($, options, true))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if ((await $.clock.now()) - lastLocal > 30_000) await refresh($, options, false)
    return next(e)
  })

  on('command.run', { command: 'ou-on-en-est' }, async ($, e) => {
    const note = e.args.trim().match(/^note\s+(\S+)\s*(.*)$/)
    if (note?.[1]) {
      const [, name, text = ''] = note
      if (text.trim()) notes[name] = text.trim()
      else delete notes[name]
      await $.store.set('notes', notes)
      await update($, repos, list => list.map(r => (r.name === name ? { ...r, note: notes[name] ?? null } : r)))
      return { text: text.trim() ? m.noteSet(name, text.trim()) : m.noteRemoved(name) }
    }
    await loadTheme($)
    const opened = await $.ui.open({ id: PANE, title: m.paneTitle })
    await refresh($, options, true)
    const line = summary(await read($, repos), await read($, deployed), lang) ?? m.noRepo
    return { text: opened.isPlaced ? line : `${line}\n${m.widen}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c = COLORS[themeName] ?? COLORS.graphite!
    const list = await read($, repos)
    const vps = await read($, deployed)
    const pages = await read($, health)
    const at = await read($, checkedAt)
    const busy = await read($, isRefreshing)
    const color = (level: 'bad' | 'warn' | 'ok' | 'dim') => ({ bad: c.bad, warn: c.warn, ok: c.ok, dim: c.dim })[level]
    const host = String(options.vpsHost ?? '')
    const hasVpsConfig = parsePairs(String(options.vpsRepos ?? '')).length > 0

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={c.dim}>
            {busy ? m.refreshing : at ? m.checkedAt(new Date(at).toTimeString().slice(0, 5)) : m.localOnly}
          </Text>
          <Button key="refresh" label={m.refresh} hotkey="r" onPress={() => void refresh($, options, true)} />
        </Box>

        {list.length === 0 && <Text color={c.dim}>{m.noRepoPane}</Text>}
        {list.map(r => (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{r.name}</Text>
              <Text color={c.dim} wrap="truncate-end">{r.branch}</Text>
            </Box>
            <Text>
              {repoFlags(r, lang).map((f, i) => (
                <Text color={color(f.level)}>
                  {i > 0 ? ' · ' : ''}
                  {f.text}
                </Text>
              ))}
            </Text>
            {r.note && <Text color={c.acc}>⏸ {r.note}</Text>}
          </Box>
        ))}

        {host && (
          <Box flexDirection="column">
            <Text color={c.dim} bold>
              {m.server.toUpperCase()} {host.split('@').pop()?.toUpperCase()}
            </Text>
            {!hasVpsConfig && <Text color={c.dim}>{m.setVpsRepos}</Text>}
            {vps.map(d => {
              const repo = list.find(r => r.name === d.name)
              const tone = d.relation === 'equal' && d.dirty === 0 ? c.ok : d.relation === 'unreachable' ? c.bad : c.warn
              return (
                <Text>
                  <Text>{d.name} </Text>
                  <Text color={c.dim}>{d.sha ?? '—'} </Text>
                  <Text color={tone}>{relationText(d, repo?.mainBranch ?? 'main', lang)}</Text>
                  {d.dirty > 0 && <Text color={c.warn}> · {m.changedOnServer(d.dirty)}</Text>}
                </Text>
              )
            })}
          </Box>
        )}

        {pages.length > 0 && (
          <Box flexDirection="column">
            <Text color={c.dim} bold>
              {m.pages.toUpperCase()}
            </Text>
            {pages.map(p => (
              <Text>
                <Text color={p.code !== null && p.code < 400 ? c.ok : c.bad}>{p.code ?? m.unreachable} </Text>
                <Text color={c.dim}>{p.url.replace(/^https?:\/\//, '')}</Text>
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
