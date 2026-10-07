import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const APP = '/home/me/projects/mobile-app'
const OUT = `${APP}/android/app/build/outputs/apk/release`
const BUILT = Date.parse('2026-10-02T14:52:00Z')
const T0 = BUILT + 3 * 3_600_000

const BAND = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120 } as unknown as RenderPropsOf['AbovePrompt']

/** Un faux projet Expo : un APK v4 de 96 Mo, et `commits` commits depuis. */
function project(on: On, commits: number, toasts: string[] = []) {
  const files: Record<string, string> = {
    [`${APP}/android/app/build.gradle`]: 'defaultConfig {\n  versionCode 4\n  versionName "1.1.0"\n}',
  }
  const dirs = [`${APP}/android/app`, OUT]
  on('fs.exists', ($, e) => ({ value: dirs.includes(e.path) || e.path in files }) as never)
  on('fs.list', ($, e) =>
    ({
      value: e.path === OUT ? [{ name: 'app-release.apk', kind: 'file', size: 100_270_080, mtimeMs: BUILT, isLink: false }] : [],
    }) as never,
  )
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }) as never)
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const stdout = argv.includes(' log ')
      ? Array.from({ length: commits }, (_, i) => `c${i}`).join('\n')
      : argv.includes('rev-parse')
        ? '2bcc49d\n'
        : ''
    return { value: { exitCode: argv.startsWith('pgrep') ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('env.get', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', children: [] }) as never)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`APK périmé après 2 commits (${surface})`, async ($, on) => {
    mock.clock(on, { now: T0 })
    project(on, 2)
    await $.session.start({ cwd: APP, surface, isInteractive: true } as never)
    const ui = await $.ui.mount({ plugin: 'apk-fraicheur', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: /périmé : 2 commits depuis le build/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /96 Mo/ })).toBeDefined()
  })
}

test('APK à jour sans commit depuis', async ($, on) => {
  mock.clock(on, { now: T0 })
  project(on, 0)
  await $.session.start({ cwd: APP, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'apk-fraicheur', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: '✓ à jour' })).toBeDefined()
})

test('un build qui manque de mémoire est signalé tout de suite', async ($, on) => {
  mock.clock(on, { now: T0 })
  const toasts: string[] = []
  project(on, 0, toasts)
  on('tool.call', () => ({ result: { stdout: '' }, text: '> Task :app:mergeReleaseResources\njava.lang.OutOfMemoryError: Metaspace', isError: true }) as never)
  await $.session.start({ cwd: APP, surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: 'Bash', command: 'cd android && ./gradlew assembleRelease', description: 'build' } as never)
  expect(toasts.some(t => t.includes('Metaspace'))).toBe(true)
  const ui = await $.ui.mount({ plugin: 'apk-fraicheur', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: /build échoué/ })).toBeDefined()
})

test('/apk résume et propose la copie quand le fichier est trop gros', async ($, on) => {
  mock.clock(on, { now: T0 })
  project(on, 1)
  await $.session.start({ cwd: APP, surface: 'terminal', isInteractive: true } as never)
  const r = await $.command.run({ command: 'apk', args: '' } as never)
  expect(r.text).toContain('APK v4 (1.1.0)')
  expect(r.text).toContain('Périmé : 1 commit depuis le build.')
  expect(r.text).toContain('/apk copier')
})


test('in English', { options: { language: 'en' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  project(on, 2)
  await $.session.start({ cwd: APP, surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ plugin: 'apk-fraicheur', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: /stale: 2 commits since the build/ })).toBeDefined()
  const r = await $.command.run({ command: 'apk', args: '' } as never)
  expect(r.text).toContain('/apk copy')
})
