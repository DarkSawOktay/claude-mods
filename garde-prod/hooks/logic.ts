// Reconnaître une commande sensible : rien ici ne touche à l'engine.
import type { Kind } from '../types'

/** Une liste « a, b, c ». */
export function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean)
}

const REMOTE = /\b(ssh|scp|sftp|rsync|mosh)\b/
const BACKUP = /\b(pg_dump|pg_dumpall|pg_basebackup|mysqldump|mariadb-dump|mongodump)\b/
const DB_CLIENT = /\b(psql|mysql|mariadb|mongosh|mongo|sqlite3|redis-cli)\b/
const SQL_WRITE = /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE|CREATE\s+(TABLE|INDEX))\b/i
const SQL_FILE = /(\s-f\s|\s--file[= ]|<\s*\S+\.sql\b)/
const MIGRATE = /(manage\.py\s+migrate\b|prisma\s+migrate\s+deploy|knex\s+migrate:latest|sequelize\s+db:migrate|rails\s+db:migrate|alembic\s+upgrade|npm\s+run\s+migrate|flask\s+db\s+upgrade)/
const RISKY = [
  /git\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s--delete\b|\s-d\b|\s:\S)/,
  /\bgh\s+(secret\s+(set|delete|remove)|workflow\s+run|release\s+delete|repo\s+delete)\b/,
  /\brm\s+-[a-z]*r[a-z]*f?\b(?![^|;&]*\s\/tmp\/)/,
  /\bdocker\s+(system|builder|volume|image)\s+prune\b/,
  /\bsystemctl\s+(restart|stop|disable)\b/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/,
]

/** L'hôte de prod visé par la commande, s'il y en a un. */
export function prodTarget(command: string, hosts: string[]): string | null {
  for (const host of hosts) {
    const h = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const asTarget = new RegExp(`(^|[\\s@/'"])${h}([\\s:/'"]|$)`)
    if (!asTarget.test(command)) continue
    if (REMOTE.test(command) || /ssh:\/\//.test(command) || /\bcurl\b[^|;&]*-X\s*(POST|PUT|PATCH|DELETE)/.test(command)) return host
  }
  return null
}

/** Ce que touche une commande : prod, écriture en base, geste risqué, sauvegarde. */
export function classify(command: string, hosts: string[], backupPattern: string): { kinds: Kind[]; target: string | null } {
  const kinds: Kind[] = []
  const target = prodTarget(command, hosts)
  let isBackup = BACKUP.test(command)
  if (!isBackup && backupPattern) {
    try {
      isBackup = new RegExp(backupPattern).test(command)
    } catch {
      // expression invalide : ignorée
    }
  }
  const isDbWrite = (DB_CLIENT.test(command) && (SQL_WRITE.test(command) || SQL_FILE.test(command))) || MIGRATE.test(command)
  if (target && isDbWrite) kinds.push('dbwrite')
  if (target) kinds.push('prod')
  if (RISKY.some(r => r.test(command))) kinds.push('risky')
  if (isBackup) kinds.push('backup')
  return { kinds, target }
}

/** Une sauvegarde est-elle assez récente pour couvrir une écriture ? */
export function hasFreshBackup(lastBackupAt: number | null, now: number, maxAgeMinutes: number): boolean {
  return lastBackupAt !== null && now - lastBackupAt <= maxAgeMinutes * 60_000
}

/** Un refus de permission (dialogue, classifieur du mode auto, règle). */
export function isRefusal(result: { deny?: string; isError?: boolean; text?: string }): string | null {
  if (result.deny !== undefined) return result.deny || 'refusé'
  const text = result.text ?? ''
  if (result.isError && /(permission|denied|not allowed|refus|blocked|doesn't want to proceed|rejected)/i.test(text)) {
    return text.split('\n')[0]?.slice(0, 160) ?? 'refusé'
  }
  return null
}

/** `! commande` prête à coller dans le prompt. */
export function asBang(command: string): string {
  return `! ${command.trim()}`
}

/** Raccourcit une commande pour une ligne : garde le début et l'hôte. */
export function shorten(command: string, max = 72): string {
  const one = command.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export type Lang = 'fr' | 'en'

const MESSAGES = {
  fr: {
    toastProd: (cmd: string) => `PROD · ${cmd}`,
    toastBlocked: (cmd: string) => `Refusé : ${cmd} (« /prod » pour la lancer toi-même)`,
    toastNoBackup: 'Écriture en base de prod sans sauvegarde récente',
    deny: (age: string) =>
      `garde-prod : pas de sauvegarde de la base de prod ${age}. Fais d'abord une sauvegarde (pg_dump, mysqldump…) puis relance l'écriture.`,
    never: 'dans cette session',
    since: (min: number) => `depuis ${min} min`,
    status: (n: number) => `PROD ×${n}`,
    backupOk: (hm: string) => `sauvegarde ✓ ${hm}`,
    backupNone: 'sans sauvegarde',
    withBackup: 'sauvegarde ✓',
    paneTitle: 'Production',
    runYourself: 'À lancer toi-même',
    copy: 'Copier',
    copied: 'Copié',
    session: 'Cette session',
    nothing: 'Aucune commande sensible dans cette session.',
    outcome: { running: 'en cours', ok: 'ok', error: 'erreur', blocked: 'refusée' },
    kind: { dbwrite: 'écriture DB', prod: 'prod', risky: 'risqué', backup: 'sauvegarde' },
    configure: 'Règle « prodHosts » dans /config pour reconnaître tes serveurs.',
    commandDesc: 'Commandes sensibles de la session et commandes refusées à lancer toi-même',
    summary: (n: number, p: number) => `${n} commande${n > 1 ? 's' : ''} sensible${n > 1 ? 's' : ''}, ${p} à lancer toi-même.`,
  },
  en: {
    toastProd: (cmd: string) => `PROD · ${cmd}`,
    toastBlocked: (cmd: string) => `Refused: ${cmd} (“/prod” to run it yourself)`,
    toastNoBackup: 'Production database write without a recent backup',
    deny: (age: string) =>
      `garde-prod: no backup of the production database ${age}. Take a backup first (pg_dump, mysqldump…) then retry the write.`,
    never: 'in this session',
    since: (min: number) => `for ${min} min`,
    status: (n: number) => `PROD ×${n}`,
    backupOk: (hm: string) => `backup ✓ ${hm}`,
    backupNone: 'no backup',
    withBackup: 'backup ✓',
    paneTitle: 'Production',
    runYourself: 'Run yourself',
    copy: 'Copy',
    copied: 'Copied',
    session: 'This session',
    nothing: 'No sensitive command in this session.',
    outcome: { running: 'running', ok: 'ok', error: 'error', blocked: 'refused' },
    kind: { dbwrite: 'DB write', prod: 'prod', risky: 'risky', backup: 'backup' },
    configure: 'Set “prodHosts” in /config so your servers are recognised.',
    commandDesc: "This session's sensitive commands, and refused commands to run yourself",
    summary: (n: number, p: number) => `${n} sensitive command${n > 1 ? 's' : ''}, ${p} to run yourself.`,
  },
} as const

export function messages(lang: string) {
  return MESSAGES[lang === 'en' ? 'en' : 'fr']
}
