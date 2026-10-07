/** Un instantané des chiffres que Claude Code mesure pour la session. */
export type Snapshot = {
  /** Moment de la mesure (ms, horloge de l'engine). */
  at: number
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  /** Fenêtre de 5 h : pourcentage utilisé et heure de remise à zéro (ISO). */
  five?: Window
  /** Fenêtre de 7 jours. */
  week?: Window
  /** Coût de la session en dollars, équivalent API. */
  usd?: number
}

export type Window = { percentUsed: number; resetsAt?: string }

/** Un point de la fenêtre 5 h, pour calculer le rythme. */
export type Sample = { at: number; percentUsed: number }

/** Un tour de conversation terminé. */
export type TurnRow = { at: number; tokens: number; usd?: number }

/** Un poste de dépense : un résultat d'outil, regroupé par cible. */
export type Spend = { key: string; label: string; tokens: number; count: number }

/** Une catégorie de la répartition du contexte. */
export type ContextSlice = { name: string; tokens: number }

/** Un serveur MCP chargé dans le contexte. */
export type McpServer = { name: string; tokens: number }

/** Un jour de l'historique, gardé entre les sessions. */
export type DayRow = { day: string; weekPercent: number; usd: number }

/** Une session passée, pour retrouver les plus chères. */
export type SessionRow = { startedAt: number; cwd: string; usd: number; maxContext: number }

export type ThemeName = 'graphite' | 'olive' | 'crepuscule' | 'papier' | 'contraste'

declare module 'claude-code' {
  interface PluginState {
    'suivi-conso': {
      snapshot: Snapshot | null
      samples: Sample[]
      turns: TurnRow[]
      spends: Spend[]
      slices: ContextSlice[]
      mcp: McpServer[]
      usedServers: string[]
      days: DayRow[]
      sessions: SessionRow[]
      theme: ThemeName
      isBandHidden: boolean
    }
  }
}
