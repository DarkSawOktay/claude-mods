/** Ce qu'une commande touche, du plus sensible au moins sensible. */
export type Kind = 'dbwrite' | 'prod' | 'risky' | 'backup'

/** Une commande sensible vue pendant la session. */
export type ProdEvent = {
  id: string
  at: number
  kinds: Kind[]
  command: string
  /** L'hôte de prod visé, s'il y en a un. */
  target: string | null
  outcome: 'running' | 'ok' | 'error' | 'blocked'
  /** Pour une écriture en base : la sauvegarde la précédait-elle ? */
  hadBackup?: boolean
  detail?: string
}

/** Une commande refusée, prête à être lancée à la main avec `!`. */
export type Pending = { at: number; command: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'garde-prod': {
      events: ProdEvent[]
      pending: Pending[]
      lastBackupAt: number | null
    }
  }
}
