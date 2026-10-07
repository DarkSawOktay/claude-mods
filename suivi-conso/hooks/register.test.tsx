import type { RenderPropsOf } from 'claude-code'
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

/** Ce que l'engine répondrait sous les plugins pendant une session. */
function engine(on: On) {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  // La ligne que l'engine dessinerait sous celles des mods.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', children: [] }) as never)
}

const T0 = Date.parse('2026-10-02T15:00:00Z')

const measure = {
  context: { tokens: 342_000, window: 1_000_000, percent: 34 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 38, resetsAt: new Date(T0 + 2 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 58 },
  ],
  cost: { usd: 4.82 },
  changed: ['rateLimits' as const, 'cost' as const],
}

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 120,
} as unknown as RenderPropsOf['AbovePrompt']

const PANE = {
  title: 'Utilisation',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock',
} as unknown as RenderPropsOf['Pane']

for (const surface of ['terminal', 'desktop'] as const) {
  test(`la bande montre le quota, le contexte et le coût (${surface})`, async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    engine(on)
    await $.session.measure(measure)
    const ui = await $.ui.mount({ plugin: 'suivi-conso', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Text', text: '62 % restant' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /342 k \/ 1 M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '≈ 4,82 $' })).toBeDefined()
  })
}

for (const surface of ['terminal', 'mobile'] as const) {
  test(`le panneau détaille la session (${surface})`, async ($, on) => {
    mock.clock(on, { now: T0 })
    mock.store(on)
    engine(on)
    await $.session.measure(measure)
    const ui = await $.ui.mount({ plugin: 'suivi-conso', surface, component: 'Pane', requestId: 'conso', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'FENÊTRE 5 H' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /4,82 \$/ })).toBeDefined()
  })
}

test('changer de thème', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.store(on)
  const written: Record<string, string> = {}
  on('env.get', () => ({ value: '/home/me' }) as never)
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined } as never
  })
  const r = await $.command.run({ command: 'theme-mods', args: 'olive' } as never)
  expect(r.text).toBe('Thème des mods : olive.')
  const again = await $.command.run({ command: 'theme-mods', args: '' } as never)
  expect(again.text).toContain('Thème actuel : olive')
  expect(written['/home/me/.claude/mods-theme']).toBe('olive')
})

test('le thème et l’historique enregistrés reviennent à la session suivante', async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.store(on, {
    theme: 'crepuscule',
    days: [{ day: '2026-10-01', weekPercent: 9, usd: 3.1 }],
  })
  engine(on)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: T0, context: { window: 1_000_000 }, rateLimits: [] } }) as never)
  await $.session.start({ cwd: '/home/me/projects/app', surface: 'terminal', isInteractive: true } as never)
  const r = await $.command.run({ command: 'theme-mods', args: '' } as never)
  expect(r.text).toContain('Thème actuel : crepuscule')
})

test('in English', { options: { language: 'en' } }, async ($, on) => {
  mock.clock(on, { now: T0 })
  mock.store(on)
  engine(on)
  await $.session.measure(measure)
  const band = await $.ui.mount({ plugin: 'suivi-conso', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: '62% left' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '≈ $4.82' })).toBeDefined()
  const pane = await $.ui.mount({ plugin: 'suivi-conso', surface: 'mobile', component: 'Pane', requestId: 'conso', props: PANE })
  expect(await pane.find({ type: 'Text', text: '5-HOUR WINDOW' })).toBeDefined()
  const r = await $.command.run({ command: 'conso', args: 'band' } as never)
  expect(r.text).toBe('Usage band hidden.')
})
