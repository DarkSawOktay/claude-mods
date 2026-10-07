import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const OPTIONS = { prodHosts: 'example.com', language: 'fr' }
const PANE = { title: 'Production', isFocused: false, bodyColumns: 60, placement: 'dock' } as unknown as RenderPropsOf['Pane']
const BAND = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120 } as unknown as RenderPropsOf['AbovePrompt']

const DEPLOY = 'ssh deploy@example.com "cd api && docker compose up -d"'
const MIGRATE = 'ssh deploy@example.com "docker exec app_db psql -f /tmp/m.sql"'
const BACKUP = 'ssh deploy@example.com "pg_dump app > ~/backups/a.sql"'

/** L'engine : le classifieur refuse les écritures en base, le reste passe. */
function engine(on: On, toasts: string[], ran: string[]) {
  on('env.get', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', children: [] }) as never)
  on('tool.call', ($, e) => {
    const command = (e as unknown as { command: string }).command
    ran.push(command)
    if (command.includes('psql -f')) return { deny: 'Production writes need a human' } as never
    return { result: { stdout: '' }, text: 'ok' } as never
  })
}

const bash = (command: string, id: string) => ({ tool: 'Bash', command, description: 'x', tool_use_id: id }) as never

test('déploiement signalé, migration refusée gardée pour toi', { options: OPTIONS }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-02T21:10:00Z') })
  const toasts: string[] = []
  engine(on, toasts, [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call(bash(DEPLOY, 't1'))
  await $.tool.call(bash(MIGRATE, 't2'))
  expect(toasts[0]).toContain('PROD')
  expect(toasts.some(t => t.includes('sans sauvegarde'))).toBe(true)
  expect(toasts.some(t => t.startsWith('Refusé'))).toBe(true)

  for (const surface of ['terminal', 'mobile'] as const) {
    const pane = await $.ui.mount({ plugin: 'garde-prod', surface, component: 'Pane', requestId: 'garde-prod', props: PANE })
    expect(await pane.find({ type: 'Text', text: `! ${MIGRATE}` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /écriture DB \+ prod/ })).toBeDefined()
  }
  const band = await $.ui.mount({ plugin: 'garde-prod', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: 'PROD ×2' })).toBeDefined()
})

test('avec « exiger une sauvegarde », l’écriture attend la sauvegarde', { options: { ...OPTIONS, requireBackup: true } }, async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-02T21:10:00Z') })
  const ran: string[] = []
  engine(on, [], ran)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  const first = await $.tool.call(bash(MIGRATE.replace('-f', '-c "DELETE FROM x" -f'), 't1'))
  expect(first.deny).toContain('pas de sauvegarde')
  expect(ran).toHaveLength(0)
  await $.tool.call(bash(BACKUP, 't2'))
  await $.tool.call(bash('ssh deploy@example.com "psql -c \\"UPDATE student SET a=1\\""', 't3'))
  expect(ran).toHaveLength(2)
})

test('en anglais', { options: { ...OPTIONS, language: 'en' } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  engine(on, [], [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  const r = await $.command.run({ command: 'prod', args: '' } as never)
  expect(r.text).toBe('0 sensitive command, 0 to run yourself.')
})
