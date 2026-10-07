import { describe, expect, test } from 'claude-code/testing'

import { asBang, classify, hasFreshBackup, isRefusal, messages, prodTarget } from './logic'

const HOSTS = ['example.com', '203.0.113.7']

describe('ce que touche une commande (exemples tirés de vraies sessions)', () => {
  test('déploiement sur le VPS', () => {
    const r = classify('ssh deploy@example.com "cd api && git pull && docker compose up -d"', HOSTS, '')
    expect(r).toEqual({ kinds: ['prod'], target: 'example.com' })
  })
  test('migration en base de prod', () => {
    const r = classify('ssh deploy@203.0.113.7 "docker exec app_db psql -U app -f /tmp/migration.sql"', HOSTS, '')
    expect(r.kinds).toEqual(['dbwrite', 'prod'])
  })
  test('insertion SQL en prod', () => {
    expect(classify(`ssh deploy@example.com "psql -c \\"INSERT INTO student VALUES (1)\\""`, HOSTS, '').kinds).toContain('dbwrite')
  })
  test('lecture seule en prod : prod, pas écriture', () => {
    expect(classify('ssh deploy@example.com "psql -c \\"SELECT count(*) FROM student\\""', HOSTS, '').kinds).toEqual(['prod'])
  })
  test('sauvegarde en prod', () => {
    expect(classify('ssh deploy@example.com "pg_dump app | gzip > ~/backups/a.sql.gz"', HOSTS, '').kinds).toEqual(['prod', 'backup'])
  })
  test('sauvegarde maison reconnue par le réglage', () => {
    expect(classify('ssh deploy@example.com ./sauvegarde.sh', HOSTS, 'sauvegarde\\.sh').kinds).toContain('backup')
  })
  test('gestes risqués hors prod', () => {
    expect(classify('gh secret set SSH_KEY < key', HOSTS, '').kinds).toEqual(['risky'])
    expect(classify('git push origin --delete feat/a feat/b', HOSTS, '').kinds).toEqual(['risky'])
    expect(classify('git push --force origin main', HOSTS, '').kinds).toEqual(['risky'])
    expect(classify('rm -rf android/app/build', HOSTS, '').kinds).toEqual(['risky'])
  })
  test('rien de sensible', () => {
    expect(classify('git status', HOSTS, '').kinds).toEqual([])
    expect(classify('rm -rf /tmp/build-cache', HOSTS, '').kinds).toEqual([])
    expect(classify('curl https://example.com/api/', HOSTS, '').kinds).toEqual([])
  })
  test('hôte mentionné sans connexion : pas prod', () => {
    expect(prodTarget('echo example.com', HOSTS)).toBe(null)
    expect(prodTarget('curl -X POST https://example.com/api/x', HOSTS)).toBe('example.com')
  })
  test('sans hôte configuré : seulement les gestes risqués', () => {
    expect(classify('ssh deploy@example.com uptime', [], '').kinds).toEqual([])
  })
})

describe('sauvegarde et refus', () => {
  test('fraîcheur de la sauvegarde', () => {
    expect(hasFreshBackup(null, 0, 120)).toBe(false)
    expect(hasFreshBackup(0, 119 * 60_000, 120)).toBe(true)
    expect(hasFreshBackup(0, 121 * 60_000, 120)).toBe(false)
  })
  test('refus reconnus', () => {
    expect(isRefusal({ deny: 'Production Reads' })).toBe('Production Reads')
    expect(isRefusal({ isError: true, text: "The user doesn't want to proceed with this tool use." })).toContain('proceed')
    expect(isRefusal({ isError: true, text: 'exit code 1' })).toBe(null)
    expect(isRefusal({ text: 'ok' })).toBe(null)
  })
  test('commande prête à coller', () => {
    expect(asBang('  ssh x uptime ')).toBe('! ssh x uptime')
  })
  test('deux langues', () => {
    expect(messages('fr').runYourself).toBe('À lancer toi-même')
    expect(messages('en').runYourself).toBe('Run yourself')
    expect(messages('xx').runYourself).toBe('À lancer toi-même')
  })
})
