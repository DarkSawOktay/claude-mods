// Lecture pure des sorties de git et gh : rien ici ne touche à l'engine.
import type { Deployed, PullRequest, RepoState } from '../types'

export type Lang = 'fr' | 'en'

/** La langue d'un réglage : `en`, sinon le français. */
export function toLang(value: unknown): Lang {
  return value === 'en' ? 'en' : 'fr'
}

/** Pluriel simple : « 2 fichiers », « 1 file ». */
const plural = (n: number, word: string) => `${word}${n > 1 ? 's' : ''}`

/** Une liste « a, b, c » ou sur plusieurs lignes. */
export function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** « api=/srv/api, site=/srv/site » → paires nom/chemin. */
export function parsePairs(value: string): { name: string; path: string }[] {
  return splitList(value)
    .map(pair => {
      const i = pair.indexOf('=')
      return i > 0 ? { name: pair.slice(0, i).trim(), path: pair.slice(i + 1).trim() } : null
    })
    .filter((p): p is { name: string; path: string } => p !== null && p.path.length > 0)
}

export type BranchStatus = {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  dirty: number
}

/** Lit `git status --porcelain=v2 --branch`. */
export function parseStatus(text: string): BranchStatus {
  let branch = '(detached)'
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let dirty = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14).trim()
      branch = head
    } else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/)
      ahead = Number(m?.[1] ?? 0)
      behind = Number(m?.[2] ?? 0)
    } else if (/^[12u?] /.test(line)) dirty += 1
  }
  return { branch, upstream, ahead, behind, dirty }
}

/** Lit `gh pr view --json number,state,statusCheckRollup`. */
export function parsePr(json: string): PullRequest | null {
  try {
    const data = JSON.parse(json) as {
      number?: number
      state?: string
      statusCheckRollup?: { conclusion?: string | null; status?: string; state?: string }[]
    }
    if (typeof data.number !== 'number') return null
    const rollup = data.statusCheckRollup ?? []
    const results = rollup.map(c => (c.conclusion ?? c.state ?? '').toUpperCase())
    const isPending = rollup.some(c => c.status && c.status.toUpperCase() !== 'COMPLETED') || results.some(r => r === 'PENDING' || r === '')
    const checks: PullRequest['checks'] =
      rollup.length === 0
        ? 'none'
        : results.some(r => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(r))
          ? 'fail'
          : isPending
            ? 'pending'
            : 'pass'
    return { number: data.number, state: data.state ?? 'OPEN', checks }
  } catch {
    return null
  }
}

/** Les choses à faire dans un dépôt, de la plus pressante à la moins pressante. */
export function repoFlags(r: RepoState, lang: Lang = 'fr'): { level: 'bad' | 'warn' | 'ok' | 'dim'; text: string }[] {
  const m = messages(lang)
  const out: { level: 'bad' | 'warn' | 'ok' | 'dim'; text: string }[] = []
  if (r.error) return [{ level: 'bad', text: r.error }]
  if (r.pr?.checks === 'fail') out.push({ level: 'bad', text: m.ciRed(r.pr.number) })
  if (r.behind > 0) out.push({ level: 'warn', text: m.behind(r.behind) })
  if (r.ahead > 0) out.push({ level: 'warn', text: m.ahead(r.ahead) })
  if (r.noUpstream && r.branch !== r.mainBranch) out.push({ level: 'warn', text: m.neverPushed })
  if (r.dirty > 0) out.push({ level: 'warn', text: m.dirty(r.dirty) })
  if (r.pr?.checks === 'pending') out.push({ level: 'dim', text: m.ciPending(r.pr.number) })
  if (r.pr?.checks === 'pass') out.push({ level: 'ok', text: `PR #${r.pr.number} ✓` })
  if (r.branch !== r.mainBranch && r.aheadOfMain > 0 && !r.pr) {
    out.push({ level: 'dim', text: m.outsideMain(r.aheadOfMain, r.mainBranch) })
  }
  if (out.length === 0) out.push({ level: 'ok', text: m.clean })
  return out
}

/** Résumé d'une ligne pour la ligne d'état : « 2 non poussés · 1 CI rouge ». */
export function summary(repos: RepoState[], deployed: Deployed[], lang: Lang = 'fr'): string | undefined {
  const m = messages(lang)
  const unpushed = repos.filter(r => r.ahead > 0 || (r.noUpstream && r.branch !== r.mainBranch)).length
  const dirty = repos.filter(r => r.dirty > 0).length
  const red = repos.filter(r => r.pr?.checks === 'fail').length
  const vps = deployed.filter(d => d.relation === 'ahead' || d.relation === 'behind' || d.dirty > 0).length
  const parts: string[] = []
  if (red) parts.push(m.sumRed(red))
  if (unpushed) parts.push(m.sumUnpushed(unpushed))
  if (dirty) parts.push(m.sumDirty(dirty))
  if (vps) parts.push(m.sumServer(vps))
  return parts.length ? parts.join(' · ') : repos.length ? m.allClean : undefined
}

/** Texte de la relation VPS ↔ main. */
export function relationText(d: Deployed, mainBranch: string, lang: Lang = 'fr'): string {
  const m = messages(lang)
  switch (d.relation) {
    case 'equal':
      return `= ${mainBranch}`
    case 'behind':
      return m.relBehind(mainBranch)
    case 'ahead':
      return m.relAhead(mainBranch)
    case 'unreachable':
      return m.unreachable
    default:
      return m.relUnknown
  }
}

const MESSAGES = {
  fr: {
    ciRed: (n: number) => `PR #${n} CI rouge`,
    ciPending: (n: number) => `PR #${n} CI en cours`,
    behind: (n: number) => `↓${n} à récupérer`,
    ahead: (n: number) => `↑${n} ${plural(n, 'non poussé')}`,
    neverPushed: 'branche jamais poussée',
    dirty: (n: number) => `✎ ${n} ${plural(n, 'fichier')}`,
    outsideMain: (n: number, main: string) => `${n} ${plural(n, 'commit')} hors de ${main}`,
    clean: 'propre',
    sumRed: (n: number) => `${n} CI rouge`,
    sumUnpushed: (n: number) => `${n} ${plural(n, 'dépôt')} ${plural(n, 'non poussé')}`,
    sumDirty: (n: number) => `${n} avec modifs`,
    sumServer: (n: number) => `serveur ≠ main ×${n}`,
    allClean: 'dépôts propres',
    relBehind: (main: string) => `en retard sur ${main}`,
    relAhead: (main: string) => `en avance sur ${main}`,
    unreachable: 'injoignable',
    relUnknown: 'commit inconnu ici',
    commandDesc: 'État des dépôts et du serveur (« note <dépôt> <texte> » pour noter une attente)',
    commandHint: '[note <dépôt> <texte>]',
    noteSet: (name: string, text: string) => `Note sur ${name} : ${text}`,
    noteRemoved: (name: string) => `Note de ${name} retirée.`,
    paneTitle: 'Où on en est',
    noRepo: 'Aucun dépôt trouvé : vérifie « projectsRoot » (/config).',
    widen: '(élargis le terminal pour voir le panneau)',
    refreshing: 'mise à jour…',
    checkedAt: (hm: string) => `vérifié à ${hm}`,
    localOnly: 'local seulement',
    refresh: 'Rafraîchir',
    noRepoPane: 'Aucun dépôt trouvé. Règle « projectsRoot » ou « extraRepos » dans /config.',
    server: 'Serveur',
    pages: 'Pages',
    setVpsRepos: 'Indique les dépôts du serveur dans « vpsRepos » (/config), ex. api=/srv/api.',
    changedOnServer: (n: number) => `✎ ${n} ${plural(n, 'modifié')} sur le serveur`,
    statusFailed: 'git status impossible',
  },
  en: {
    ciRed: (n: number) => `PR #${n} CI failing`,
    ciPending: (n: number) => `PR #${n} CI running`,
    behind: (n: number) => `↓${n} to pull`,
    ahead: (n: number) => `↑${n} unpushed`,
    neverPushed: 'branch never pushed',
    dirty: (n: number) => `✎ ${n} ${plural(n, 'file')}`,
    outsideMain: (n: number, main: string) => `${n} ${plural(n, 'commit')} not in ${main}`,
    clean: 'clean',
    sumRed: (n: number) => `${n} CI failing`,
    sumUnpushed: (n: number) => `${n} ${plural(n, 'repo')} unpushed`,
    sumDirty: (n: number) => `${n} with changes`,
    sumServer: (n: number) => `server ≠ main ×${n}`,
    allClean: 'repos clean',
    relBehind: (main: string) => `behind ${main}`,
    relAhead: (main: string) => `ahead of ${main}`,
    unreachable: 'unreachable',
    relUnknown: 'commit unknown here',
    commandDesc: 'State of your repos and server (“note <repo> <text>” to note what you are waiting on)',
    commandHint: '[note <repo> <text>]',
    noteSet: (name: string, text: string) => `Note on ${name}: ${text}`,
    noteRemoved: (name: string) => `Note on ${name} removed.`,
    paneTitle: 'Where things stand',
    noRepo: 'No repo found: check “projectsRoot” (/config).',
    widen: '(widen the terminal to see the pane)',
    refreshing: 'updating…',
    checkedAt: (hm: string) => `checked at ${hm}`,
    localOnly: 'local only',
    refresh: 'Refresh',
    noRepoPane: 'No repo found. Set “projectsRoot” or “extraRepos” in /config.',
    server: 'Server',
    pages: 'Pages',
    setVpsRepos: 'List the server repos in “vpsRepos” (/config), e.g. api=/srv/api.',
    changedOnServer: (n: number) => `✎ ${n} changed on the server`,
    statusFailed: 'git status failed',
  },
} as const

/** Les textes affichés, dans la langue du réglage `language`. */
export function messages(lang: Lang) {
  return MESSAGES[lang]
}
