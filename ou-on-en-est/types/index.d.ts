/** L'état d'un dépôt local, lu avec git (et gh pour la PR). */
export type RepoState = {
  name: string
  path: string
  branch: string
  /** Fichiers modifiés ou nouveaux, non commités. */
  dirty: number
  /** Commits locaux pas encore poussés sur la branche distante. */
  ahead: number
  /** Commits distants pas encore récupérés. */
  behind: number
  /** Vrai si la branche n'a pas de branche distante. */
  noUpstream: boolean
  /** Commits de la branche absents de la branche principale distante. */
  aheadOfMain: number
  /** Nom de la branche principale (main ou master). */
  mainBranch: string
  /** SHA court de origin/<main>, pour comparer avec le VPS. */
  mainSha: string | null
  pr: PullRequest | null
  /** Note libre (« attend la relecture »), gardée entre les sessions. */
  note: string | null
  error?: string
}

export type PullRequest = {
  number: number
  state: string
  /** pass, fail, pending, ou none s'il n'y a pas de contrôle. */
  checks: 'pass' | 'fail' | 'pending' | 'none'
}

/** Ce qui tourne sur le VPS pour un dépôt. */
export type Deployed = {
  name: string
  sha: string | null
  /** égal à main, en retard, en avance (ou inconnu localement), injoignable. */
  relation: 'equal' | 'behind' | 'ahead' | 'unknown' | 'unreachable'
  /** Modifs non commitées sur le VPS. */
  dirty: number
}

export type Health = { url: string; code: number | null }

declare module 'claude-code' {
  interface PluginState {
    'ou-on-en-est': {
      repos: RepoState[]
      deployed: Deployed[]
      health: Health[]
      checkedAt: number | null
      isRefreshing: boolean
    }
  }
}
