// Calculs purs du suivi : rien ici ne touche à l'engine, tout se teste seul.
import type {
  DayRow,
  McpServer,
  Sample,
  SessionRow,
  Snapshot,
  Spend,
  ThemeName,
  TurnRow,
} from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Couleurs d'un thème : texte, accent, états et quatre teintes de graphique. */
export type Palette = {
  acc: string
  ok: string
  warn: string
  bad: string
  dim: string
  series: [string, string, string, string]
}

const DARK_SERIES: Palette['series'] = ['#3987e5', '#d95926', '#199e70', '#c98500']

export const THEMES: Record<ThemeName, Palette> = {
  graphite: { acc: '#7cc4fa', ok: '#4cc38a', warn: '#e6ad4c', bad: '#e5675e', dim: '#8c95a2', series: DARK_SERIES },
  olive: { acc: '#d6a94e', ok: '#62c08c', warn: '#e6ad4c', bad: '#e2665d', dim: '#80968a', series: DARK_SERIES },
  crepuscule: { acc: '#f4a988', ok: '#6fd3a8', warn: '#e9c46a', bad: '#ef6f6c', dim: '#9d94b0', series: DARK_SERIES },
  papier: {
    acc: '#2f62c8',
    ok: '#1f7a4d',
    warn: '#9a6200',
    bad: '#c23b32',
    dim: '#676b72',
    series: ['#2f62c8', '#c2571a', '#1f8a5a', '#8a4bb8'],
  },
  contraste: { acc: '#ffd400', ok: '#5cff7a', warn: '#ffd400', bad: '#ff5c5c', dim: '#cfcfcf', series: DARK_SERIES },
}

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[]

export function isThemeName(name: string): name is ThemeName {
  return (THEME_NAMES as string[]).includes(name)
}

export type Lang = 'fr' | 'en'

/** La langue d'un réglage : `en`, sinon le français. */
export function toLang(value: unknown): Lang {
  return value === 'en' ? 'en' : 'fr'
}

/** 342 000 → « 342 k », 1 000 000 → « 1 M » ; 1 500 → « 1,5 k » (fr) ou « 1.5 k » (en). */
export function formatTokens(n: number, lang: Lang = 'fr'): string {
  if (n >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1), lang)} M`
  if (n >= 10_000) return `${Math.round(n / 1000)} k`
  if (n >= 1000) return `${trimZero((n / 1000).toFixed(1), lang)} k`
  return String(n)
}

/** 4.817 → « 4,82 $ » (fr) ou « $4.82 » (en). */
export function formatUsd(usd: number, lang: Lang = 'fr'): string {
  return lang === 'en' ? `$${usd.toFixed(2)}` : `${usd.toFixed(2).replace('.', ',')} $`
}

function trimZero(s: string, lang: Lang): string {
  const t = s.replace(/\.0$/, '')
  return lang === 'en' ? t : t.replace('.', ',')
}

/** Heure locale « 19:31 ». */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** « dans 2 h 08 » ou « dans 12 min » (« in 12 min » en anglais). */
export function formatIn(ms: number, lang: Lang = 'fr'): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  const word = lang === 'en' ? 'in' : 'dans'
  if (minutes < 60) return `${word} ${minutes} min`
  return `${word} ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

/** Une jauge en blocs : 38 % sur 10 cases → « ████░░░░░░ ». */
export function gauge(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Une ligne de barres verticales pour une série courte. */
export function sparkline(values: number[]): string {
  const ticks = '▁▂▃▄▅▆▇█'
  const max = Math.max(...values, 1)
  return values.map(v => ticks[Math.min(7, Math.floor((v / max) * 7.999))]).join('')
}

/**
 * Ajoute un point de la fenêtre 5 h. Une baisse veut dire que la fenêtre a
 * été remise à zéro : on repart de ce point. On garde 90 minutes.
 */
export function addSample(samples: Sample[], sample: Sample): Sample[] {
  const last = samples[samples.length - 1]
  if (last && sample.percentUsed < last.percentUsed) return [sample]
  return [...samples, sample].filter(s => sample.at - s.at <= 90 * MINUTE).slice(-120)
}

export type Projection = {
  /** Points de quota consommés par heure, sur la période observée. */
  ratePerHour: number
  /** Heure où la fenêtre serait épuisée à ce rythme. */
  exhaustAt: number
  /** Vrai si l'épuisement arrive avant la remise à zéro. */
  isBeforeReset: boolean
}

/**
 * Projette l'épuisement de la fenêtre 5 h au rythme des 30 dernières minutes
 * (au moins 10 minutes d'observation). `null` sans rythme mesurable.
 */
export function project(samples: Sample[], now: number, resetsAt?: string): Projection | null {
  const recent = samples.filter(s => now - s.at <= 30 * MINUTE)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (!first || !last || last.at - first.at < 10 * MINUTE) return null
  const ratePerHour = (last.percentUsed - first.percentUsed) / ((last.at - first.at) / HOUR)
  if (ratePerHour <= 0) return null
  const exhaustAt = last.at + ((100 - last.percentUsed) / ratePerHour) * HOUR
  const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN
  return { ratePerHour, exhaustAt, isBeforeReset: Number.isFinite(reset) ? exhaustAt < reset : true }
}

/** Total des tokens d'un tour, comme le compte l'API. */
export function turnTokens(usage: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  )
}

/** Ajoute un tour ; on garde les 40 derniers. */
export function addTurn(turns: TurnRow[], turn: TurnRow): TurnRow[] {
  return [...turns, turn].slice(-40)
}

/** Range le coût d'une mesure sur le dernier tour qui n'en a pas encore. */
export function chargeLastTurn(turns: TurnRow[], usdDelta: number): TurnRow[] {
  const i = turns.length - 1
  if (i < 0 || turns[i]?.usd !== undefined || usdDelta <= 0) return turns
  return turns.map((t, j) => (j === i ? { ...t, usd: usdDelta } : t))
}

/** Taille approximative d'un résultat d'outil en tokens (4 caractères ≈ 1 token). */
export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.ceil((text ?? '').length / 4)
}

/** Ce qu'un appel d'outil vise, pour regrouper les dépenses. */
export function spendTarget(tool: string, input: Record<string, unknown>, lang: Lang = 'fr'): { key: string; label: string } {
  const m = messages(lang)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (tool === 'Read') {
    const path = str(input.file_path)
    return { key: `Read:${path}`, label: `${m.read} ${shortPath(path)}` }
  }
  if (tool === 'Bash') {
    const cmd = str(input.command).replace(/\s+/g, ' ').trim()
    const head = cmd.split(' ').slice(0, 3).join(' ')
    return { key: `Bash:${head}`, label: `${m.command} ${clip(head, 40)}` }
  }
  if (tool === 'Agent' || tool === 'Task') {
    return { key: 'Agent', label: m.subagents }
  }
  if (tool.startsWith('mcp__')) {
    const server = mcpServerOf(tool) ?? tool
    return { key: `mcp:${tool}`, label: `MCP ${server} · ${tool.split('__').pop()}` }
  }
  return { key: tool, label: tool }
}

/** `mcp__github__get_me` → `github`. */
export function mcpServerOf(tool: string): string | null {
  const parts = tool.split('__')
  return parts.length >= 3 && parts[0] === 'mcp' ? (parts[1] ?? null) : null
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || path
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Ajoute une dépense, regroupée par cible ; on garde les 60 plus grosses. */
export function addSpend(spends: Spend[], key: string, label: string, tokens: number): Spend[] {
  const found = spends.find(s => s.key === key)
  const next = found
    ? spends.map(s => (s.key === key ? { ...s, tokens: s.tokens + tokens, count: s.count + 1 } : s))
    : [...spends, { key, label, tokens, count: 1 }]
  return next.sort((a, b) => b.tokens - a.tokens).slice(0, 60)
}

/** Clé de jour locale « 2026-10-02 ». */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Ajoute à aujourd'hui ce qui a été consommé depuis la mesure précédente :
 * les points du quota semaine (ignorés si la fenêtre a été remise à zéro)
 * et les dollars. On garde 14 jours.
 */
export function addToDay(
  days: DayRow[],
  now: number,
  weekDelta: number,
  usdDelta: number,
): DayRow[] {
  const day = dayKey(now)
  const w = weekDelta > 0 ? weekDelta : 0
  const u = usdDelta > 0 ? usdDelta : 0
  if (w === 0 && u === 0) return days
  const found = days.find(d => d.day === day)
  const next = found
    ? days.map(d => (d.day === day ? { ...d, weekPercent: d.weekPercent + w, usd: d.usd + u } : d))
    : [...days, { day, weekPercent: w, usd: u }]
  return next.sort((a, b) => a.day.localeCompare(b.day)).slice(-14)
}

/** Les 7 derniers jours, jours vides compris, du plus ancien à aujourd'hui. */
export function lastSevenDays(days: DayRow[], now: number): DayRow[] {
  const out: DayRow[] = []
  for (let i = 6; i >= 0; i -= 1) {
    const day = dayKey(now - i * 24 * HOUR)
    out.push(days.find(d => d.day === day) ?? { day, weekPercent: 0, usd: 0 })
  }
  return out
}

/** Met à jour la session courante dans la liste ; on garde les 30 dernières. */
export function upsertSession(sessions: SessionRow[], row: SessionRow): SessionRow[] {
  const rest = sessions.filter(s => s.startedAt !== row.startedAt)
  return [...rest, row].sort((a, b) => a.startedAt - b.startedAt).slice(-30)
}

export type Tip = { level: 'warn' | 'info'; title: string; text: string }

/** Les conseils, du plus utile au moins utile. */
export function tips(input: {
  snapshot: Snapshot | null
  projection: Projection | null
  spends: Spend[]
  mcp: McpServer[]
  usedServers: string[]
}, lang: Lang = 'fr'): Tip[] {
  const m = messages(lang)
  const tok = (n: number) => formatTokens(n, lang)
  const out: Tip[] = []
  const { snapshot, projection, spends, mcp, usedServers } = input

  if (projection?.isBeforeReset) {
    out.push({
      level: 'warn',
      title: m.tipPaceTitle,
      text: m.tipPace(Math.round(projection.ratePerHour), formatClock(projection.exhaustAt)),
    })
  }

  const unused = mcp.filter(s => s.tokens >= 2000 && !usedServers.includes(s.name))
  const unusedTokens = unused.reduce((n, s) => n + s.tokens, 0)
  if (unusedTokens >= 5000) {
    out.push({
      level: 'warn',
      title: m.tipMcpTitle,
      text: m.tipMcp(unused.map(s => s.name).join(', '), tok(unusedTokens)),
    })
  }

  const big = spends.filter(s => s.tokens / s.count >= 20_000).slice(0, 2)
  for (const s of big) {
    out.push({
      level: 'warn',
      title: m.tipBigTitle,
      text: m.tipBig(s.label, tok(s.tokens)),
    })
  }

  const reread = spends.filter(s => s.key.startsWith('Read:') && s.count >= 3).slice(0, 1)
  for (const s of reread) {
    out.push({
      level: 'info',
      title: m.tipRereadTitle,
      text: m.tipReread(s.label, s.count, tok(s.tokens)),
    })
  }

  const ctx = snapshot?.contextPercent
  if (ctx !== undefined && ctx >= 60) {
    out.push({
      level: ctx >= 80 ? 'warn' : 'info',
      title: m.tipContextTitle,
      text: m.tipContext(Math.round(ctx)),
    })
  }

  return out
}

/** La ligne d'état : « 5 h 62 % · 7 j 42 % · ctx 342 k/1 M · 4,82 $ ». */
export function statusLine(s: Snapshot | null, lang: Lang = 'fr'): string | undefined {
  if (!s) return undefined
  const m = messages(lang)
  const parts: string[] = []
  if (s.five) parts.push(`5 h ${m.left(Math.round(100 - s.five.percentUsed))}`)
  if (s.week) parts.push(`${m.week} ${Math.round(100 - s.week.percentUsed)} %`)
  if (s.contextTokens !== undefined) parts.push(`ctx ${formatTokens(s.contextTokens, lang)}/${formatTokens(s.contextWindow, lang)}`)
  if (s.usd !== undefined) parts.push(`≈ ${formatUsd(s.usd, lang)}`)
  return parts.length ? parts.join(' · ') : undefined
}

const MESSAGES = {
  fr: {
    left: (n: number) => `${n} % restant`,
    week: '7 j',
    read: 'Lecture',
    command: 'Commande',
    subagents: 'Sous-agents',
    tipPaceTitle: 'Rythme élevé',
    tipPace: (rate: number, at: string) =>
      `${rate} %/h : quota 5 h épuisé vers ${at}, avant la remise à zéro. Préfère des tâches courtes ou un effort plus bas.`,
    tipMcpTitle: 'MCP inutilisés',
    tipMcp: (names: string, tokens: string) =>
      `${names} : ${tokens} tokens renvoyés à chaque requête sans servir. Coupe-les pour ce projet (/mcp).`,
    tipBigTitle: 'Résultat volumineux',
    tipBig: (label: string, tokens: string) => `${label} : ~${tokens}. Demande un extrait (fin du fichier, grep) plutôt que le tout.`,
    tipRereadTitle: 'Fichier relu',
    tipReread: (label: string, count: number, tokens: string) => `${label} lu ${count} fois (${tokens}).`,
    tipContextTitle: 'Contexte chargé',
    tipContext: (pct: number) => `${pct} % utilisé : /compact pour continuer, /clear si la tâche est finie.`,
    toast90: (left: number) => `Quota 5 h : plus que ${left} %`,
    toast75: (used: number) => `Quota 5 h : ${used} % utilisé`,
    toastPace: (at: string) => `Au rythme actuel, quota 5 h épuisé vers ${at}`,
    toastContext: (pct: number) => `Contexte à ${pct} % : pense à /compact`,
    consoDesc: "Suivi d'utilisation : quota, contexte, coût et conseils (« /conso bande » masque ou montre la bande)",
    consoHint: '[bande]',
    bandWord: 'bande',
    themeDesc: (names: string) => `Thème des mods : ${names}`,
    themeHint: '<thème>',
    bandHidden: 'Bande de suivi masquée.',
    bandShown: 'Bande de suivi affichée.',
    paneTitle: 'Utilisation',
    noMeasure: 'Pas encore de mesure : elle arrive après la première réponse.',
    paneOpened: (line: string) => `Panneau ouvert. ${line}`,
    themeCurrent: (current: string, names: string) => `Thème actuel : ${current}. Choix : ${names} (ex. /theme-mods olive).`,
    themeSet: (name: string) => `Thème des mods : ${name}.`,
    noMeasurePane: 'Pas encore de mesure. Les chiffres arrivent après la première réponse de Claude.',
    fiveTitle: 'Fenêtre 5 h',
    resetAt: (at: string, inText: string) => `remise à zéro ${at} (${inText})`,
    paceBad: (rate: number, at: string) => `⚠ ${rate} %/h : épuisé vers ${at}`,
    paceOk: (rate: number) => `✓ ${rate} %/h : tu tiens jusqu'à la remise à zéro`,
    weekTitle: 'Semaine (7 j)',
    weekReset: (day: string, at: string) => `remise à zéro le ${day} à ${at}`,
    locale: 'fr-FR',
    contextTitle: 'Contexte',
    sessionTitle: 'Cette session',
    cost: 'Coût (équivalent API)',
    turns: 'Tours',
    tokensPerTurn: ' tokens par tour',
    topTitle: 'Ce qui a le plus coûté',
    tipsTitle: 'Pour économiser',
    historyTitle: '7 derniers jours · % du quota semaine',
    costliest: (name: string, usd: string, ctx: string) => `Session la plus chère : ${name} · ${usd} · ${ctx} de contexte`,
  },
  en: {
    left: (n: number) => `${n}% left`,
    week: '7 d',
    read: 'Read',
    command: 'Command',
    subagents: 'Subagents',
    tipPaceTitle: 'Fast pace',
    tipPace: (rate: number, at: string) =>
      `${rate}%/h: the 5 h quota runs out around ${at}, before the reset. Prefer short tasks or a lower effort.`,
    tipMcpTitle: 'Unused MCP servers',
    tipMcp: (names: string, tokens: string) =>
      `${names}: ${tokens} tokens sent with every request and never used. Turn them off for this project (/mcp).`,
    tipBigTitle: 'Large result',
    tipBig: (label: string, tokens: string) => `${label}: ~${tokens}. Ask for an excerpt (end of file, grep) instead of the whole thing.`,
    tipRereadTitle: 'File read again',
    tipReread: (label: string, count: number, tokens: string) => `${label} read ${count} times (${tokens}).`,
    tipContextTitle: 'Context filling up',
    tipContext: (pct: number) => `${pct}% used: /compact to keep going, /clear if the task is done.`,
    toast90: (left: number) => `5 h quota: only ${left}% left`,
    toast75: (used: number) => `5 h quota: ${used}% used`,
    toastPace: (at: string) => `At this pace, the 5 h quota runs out around ${at}`,
    toastContext: (pct: number) => `Context at ${pct}%: consider /compact`,
    consoDesc: 'Usage tracking: quota, context, cost and tips (“/conso band” hides or shows the band)',
    consoHint: '[band]',
    bandWord: 'band',
    themeDesc: (names: string) => `Mods theme: ${names}`,
    themeHint: '<theme>',
    bandHidden: 'Usage band hidden.',
    bandShown: 'Usage band shown.',
    paneTitle: 'Usage',
    noMeasure: 'No measurement yet: it arrives after the first reply.',
    paneOpened: (line: string) => `Pane opened. ${line}`,
    themeCurrent: (current: string, names: string) => `Current theme: ${current}. Choices: ${names} (e.g. /theme-mods olive).`,
    themeSet: (name: string) => `Mods theme: ${name}.`,
    noMeasurePane: "No measurement yet. Numbers arrive after Claude's first reply.",
    fiveTitle: '5-hour window',
    resetAt: (at: string, inText: string) => `resets at ${at} (${inText})`,
    paceBad: (rate: number, at: string) => `⚠ ${rate}%/h: runs out around ${at}`,
    paceOk: (rate: number) => `✓ ${rate}%/h: you will last until the reset`,
    weekTitle: 'Week (7 d)',
    weekReset: (day: string, at: string) => `resets ${day} at ${at}`,
    locale: 'en-GB',
    contextTitle: 'Context',
    sessionTitle: 'This session',
    cost: 'Cost (API equivalent)',
    turns: 'Turns',
    tokensPerTurn: ' tokens per turn',
    topTitle: 'Most expensive',
    tipsTitle: 'To save usage',
    historyTitle: 'Last 7 days · % of weekly quota',
    costliest: (name: string, usd: string, ctx: string) => `Most expensive session: ${name} · ${usd} · ${ctx} of context`,
  },
} as const

/** Les textes affichés, dans la langue du réglage `language`. */
export function messages(lang: Lang) {
  return MESSAGES[lang]
}
