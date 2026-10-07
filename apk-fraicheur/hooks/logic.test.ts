import { describe, expect, test } from 'claude-code/testing'

import {
  classifyBuildOutput,
  dirtyPaths,
  formatDuration,
  formatSize,
  isBuildCommand,
  lastGradleTask,
  parseVersionCode,
  parseVersionName,
  statusText,
  verdict,
} from './logic'

const APK = { path: '/a/app-release.apk', sizeBytes: 100_270_080, builtAt: 1_000, versionCode: 4, versionName: '1.1.0' }

describe('versions', () => {
  test('build.gradle et app.json', () => {
    expect(parseVersionCode('defaultConfig {\n  versionCode 4\n  versionName "1.1.0"\n}')).toBe(4)
    expect(parseVersionName('versionName "1.1.0"')).toBe('1.1.0')
    expect(parseVersionCode('{ "android": { "versionCode": 3 } }')).toBe(3)
    expect(parseVersionName('{ "expo": { "version": "1.0.2" } }')).toBe('1.0.2')
  })
})

describe('commandes de build', () => {
  test('reconnues', () => {
    expect(isBuildCommand('cd android && ./gradlew assembleRelease')).toBe(true)
    expect(isBuildCommand('./gradlew bundleRelease --no-daemon')).toBe(true)
    expect(isBuildCommand('npx eas build -p android --local')).toBe(true)
    expect(isBuildCommand('npx expo run:android --variant release')).toBe(true)
  })
  test('ignorées', () => {
    expect(isBuildCommand('./gradlew clean')).toBe(false)
    expect(isBuildCommand('git status')).toBe(false)
  })
})

describe('sortie de Gradle', () => {
  test('réussite', () => {
    expect(classifyBuildOutput('...\nBUILD SUCCESSFUL in 5m 20s\n412 actionable tasks')).toEqual({ status: 'ok', detail: 'réussi en 5m 20s' })
  })
  test('manque de mémoire (le crash silencieux du 10 septembre)', () => {
    const out = classifyBuildOutput('> Task :app:mergeReleaseResources\njava.lang.OutOfMemoryError: Metaspace\n')
    expect(out?.status).toBe('failed')
    expect(out?.detail).toContain('Metaspace')
  })
  test('processus tué', () => {
    expect(classifyBuildOutput('Killed')?.detail).toContain('tué')
  })
  test('échec avec cause', () => {
    const out = classifyBuildOutput("FAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed for task ':app:lintVitalRelease'.\n")
    expect(out?.detail).toBe("Execution failed for task ':app:lintVitalRelease'.")
  })
  test('dernière tâche', () => {
    expect(lastGradleTask('> Task :app:preBuild\n> Task :app:mergeReleaseResources\n')).toBe('Task :app:mergeReleaseResources')
  })
})

describe('fraîcheur', () => {
  test('fichiers de build ignorés', () => {
    expect(dirtyPaths(' M app/(auth)/register.tsx\n?? android/app/build/x\nR  a.ts -> b.ts\n')).toEqual(['app/(auth)/register.tsx', 'b.ts'])
  })
  test('à jour, périmé, absent', () => {
    expect(verdict(null, null)).toEqual({ kind: 'none' })
    expect(verdict(APK, { commitsSince: 0, dirtySince: 0, headSha: 'abc' })).toEqual({ kind: 'fresh' })
    expect(verdict(APK, { commitsSince: 4, dirtySince: 1, headSha: 'abc' })).toEqual({
      kind: 'stale',
      reason: '4 commits + 1 fichier modifié depuis le build',
    })
  })
  test('ligne d’état', () => {
    expect(statusText(APK, { commitsSince: 2, dirtySince: 0, headSha: 'a' }, null, 5_000)).toBe('APK v4 périmé')
    expect(statusText(APK, null, { startedAt: 0, command: 'x', status: 'running' }, 760_000)).toBe('build Android 12 min 40 s')
  })
  test('formats', () => {
    expect(formatSize(100_270_080)).toBe('96 Mo')
    expect(formatDuration(320_000)).toBe('5 min 20 s')
  })
})
