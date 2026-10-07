/** Le dernier APK trouvé dans les sorties de Gradle. */
export type Apk = {
  path: string
  sizeBytes: number
  /** Date de fin du build (mtime du fichier). */
  builtAt: number
  versionCode: number | null
  versionName: string | null
}

/** Ce qui a changé dans le code depuis ce build. */
export type Freshness = {
  /** Commits faits après le build. */
  commitsSince: number
  /** Fichiers modifiés (non commités) après le build. */
  dirtySince: number
  headSha: string
}

/** Un build Android suivi : lancé par Claude, ou à la main avec `!`. */
export type Build = {
  startedAt: number
  command: string
  status: 'running' | 'ok' | 'failed'
  endedAt?: number
  /** La dernière tâche Gradle vue, ou la cause d'un échec. */
  detail?: string
}

declare module 'claude-code' {
  interface PluginState {
    'apk-fraicheur': {
      appDir: string | null
      apk: Apk | null
      freshness: Freshness | null
      build: Build | null
      lastDurationMs: number | null
      now: number
    }
  }
}
