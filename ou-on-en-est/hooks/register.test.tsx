import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ROOT = '/home/me/projects'
const PANE = { title: 'Où on en est', isFocused: false, bodyColumns: 48, placement: 'dock' } as unknown as RenderPropsOf['Pane']

/** Deux dépôts : mobile-app (2 commits non poussés, 3 fichiers) et api (propre), et un serveur. */
function world(on: On, ran: string[]) {
  const repos = ['mobile-app', 'api']
  on('fs.exists', ($, e) => ({ value: e.path === ROOT || repos.some(r => e.path === `${ROOT}/${r}/.git`) }) as never)
  on('fs.list', () => ({ value: repos.map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }) as never)
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    ran.push(argv)
    const ok = (stdout: string, exitCode = 0) =>
      ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    const isApp = argv.includes('mobile-app')
    if (argv.includes('status --porcelain=v2')) {
      return ok(
        isApp
          ? '# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -0\n1 .M N... 1 1 1 a b x.ts\n1 .M N... 1 1 1 a b y.ts\n? z.ts\n'
          : '# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n',
      )
    }
    if (argv.includes('symbolic-ref')) return ok('origin/main\n')
    if (argv.includes('rev-parse --short origin/main')) return ok(isApp ? 'aaaaaaa\n' : '4456659\n')
    if (argv.includes('rev-list --count')) return ok(isApp ? '2\n' : '0\n')
    if (argv.startsWith('ssh')) return ok('@@api 4456659 0\n')
    if (argv.startsWith('curl')) return ok('200')
    return ok('')
  })
  on('env.get', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
}

const OPTIONS = {
  projectsRoot: ROOT,
  vpsHost: 'deploy@example.com',
  vpsRepos: 'api=/home/deploy/api',
  healthUrls: 'https://example.com/',
}

for (const surface of ['terminal', 'mobile'] as const) {
  test(`le panneau montre les dépôts et le serveur (${surface})`, { options: OPTIONS }, async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-02T17:42:00Z') })
    const ran: string[] = []
    world(on, ran)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true } as never)
    const r = await $.command.run({ command: 'ou-on-en-est', args: '' } as never)
    expect(r.text).toBe('1 dépôt non poussé · 1 avec modifs')
    const ui = await $.ui.mount({ plugin: 'ou-on-en-est', surface, component: 'Pane', requestId: 'ou-on-en-est', props: PANE })
    expect(await ui.find({ type: 'Text', text: '↑2 non poussés' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✎ 3 fichiers' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '= main' })).toBeDefined()
    // Le serveur n'est lu qu'en lecture seule, en un seul ssh.
    expect(ran.filter(a => a.startsWith('ssh'))).toHaveLength(1)
    expect(ran.find(a => a.startsWith('ssh'))).toContain('BatchMode=yes')
  })
}

test('une note reste affichée sous le dépôt', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on, [])
  on('store.set', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  const r = await $.command.run({ command: 'ou-on-en-est', args: 'note mobile-app waiting on review' } as never)
  expect(r.text).toBe('Note sur mobile-app : waiting on review')
  const ui = await $.ui.mount({ plugin: 'ou-on-en-est', surface: 'terminal', component: 'Pane', requestId: 'ou-on-en-est', props: PANE })
  expect(await ui.find({ type: 'Text', text: /waiting on review/ })).toBeDefined()
})

test('in English', { options: { ...OPTIONS, language: 'en' } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  const r = await $.command.run({ command: 'ou-on-en-est', args: '' } as never)
  expect(r.text).toBe('1 repo unpushed · 1 with changes')
  const ui = await $.ui.mount({ plugin: 'ou-on-en-est', surface: 'terminal', component: 'Pane', requestId: 'ou-on-en-est', props: PANE })
  expect(await ui.find({ type: 'Text', text: '↑2 unpushed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SERVER EXAMPLE\.COM/ })).toBeDefined()
})
