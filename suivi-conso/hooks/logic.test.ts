import { describe, expect, test } from 'claude-code/testing'

import {
  addSample,
  addToDay,
  chargeLastTurn,
  formatTokens,
  formatUsd,
  lastSevenDays,
  mcpServerOf,
  project,
  statusLine,
  tips,
} from './logic'

const MIN = 60_000
const T0 = Date.parse('2026-10-02T15:00:00Z')

describe('format', () => {
  test('tokens et dollars à la française', () => {
    expect(formatTokens(342_000)).toBe('342 k')
    expect(formatTokens(1_000_000)).toBe('1 M')
    expect(formatTokens(1_500)).toBe('1,5 k')
    expect(formatUsd(4.817)).toBe('4,82 $')
    expect(formatUsd(4.817, 'en')).toBe('$4.82')
    expect(formatTokens(1_500, 'en')).toBe('1.5 k')
  })

  test('ligne d’état', () => {
    const line = statusLine({
      at: T0,
      contextTokens: 342_000,
      contextWindow: 1_000_000,
      five: { percentUsed: 38 },
      week: { percentUsed: 58 },
      usd: 4.82,
    })
    expect(line).toBe('5 h 62 % restant · 7 j 42 % · ctx 342 k/1 M · ≈ 4,82 $')
  })
})

describe('prévision du quota 5 h', () => {
  test('34 %/h depuis 38 % : épuisé avant la remise à zéro', () => {
    let s = addSample([], { at: T0, percentUsed: 21 })
    s = addSample(s, { at: T0 + 30 * MIN, percentUsed: 38 })
    const p = project(s, T0 + 30 * MIN, new Date(T0 + 4 * 60 * MIN).toISOString())
    expect(p?.ratePerHour).toBe(34)
    expect(p?.isBeforeReset).toBe(true)
  })

  test('rythme lent : on tient jusqu’à la remise à zéro', () => {
    let s = addSample([], { at: T0, percentUsed: 38 })
    s = addSample(s, { at: T0 + 30 * MIN, percentUsed: 40 })
    const p = project(s, T0 + 30 * MIN, new Date(T0 + 60 * MIN).toISOString())
    expect(p?.isBeforeReset).toBe(false)
  })

  test('moins de 10 minutes observées : pas de prévision', () => {
    let s = addSample([], { at: T0, percentUsed: 38 })
    s = addSample(s, { at: T0 + 5 * MIN, percentUsed: 41 })
    expect(project(s, T0 + 5 * MIN)).toBe(null)
  })

  test('une baisse veut dire remise à zéro : on repart de zéro', () => {
    const s = addSample([{ at: T0, percentUsed: 90 }], { at: T0 + MIN, percentUsed: 2 })
    expect(s).toEqual([{ at: T0 + MIN, percentUsed: 2 }])
  })
})

describe('historique', () => {
  test('cumule le jour, ignore les baisses', () => {
    let d = addToDay([], T0, 3, 1.5)
    d = addToDay(d, T0 + MIN, 2, 0.5)
    d = addToDay(d, T0 + 2 * MIN, -40, 0)
    expect(d).toHaveLength(1)
    expect(d[0]?.weekPercent).toBe(5)
    expect(d[0]?.usd).toBe(2)
  })

  test('sept jours, jours vides compris', () => {
    const week = lastSevenDays(addToDay([], T0, 4, 1), T0)
    expect(week).toHaveLength(7)
    expect(week[6]?.weekPercent).toBe(4)
    expect(week[0]?.weekPercent).toBe(0)
  })

  test('le coût va au dernier tour, une seule fois', () => {
    const t = chargeLastTurn([{ at: T0, tokens: 100 }], 0.2)
    expect(t[0]?.usd).toBe(0.2)
    expect(chargeLastTurn(t, 0.5)[0]?.usd).toBe(0.2)
  })
})

describe('conseils', () => {
  test('MCP chargés jamais utilisés', () => {
    expect(mcpServerOf('mcp__github__get_me')).toBe('github')
    const out = tips({
      snapshot: null,
      projection: null,
      spends: [],
      mcp: [
        { name: 'Canva', tokens: 30_000 },
        { name: 'github', tokens: 20_000 },
      ],
      usedServers: ['github'],
    })
    expect(out[0]?.title).toBe('MCP inutilisés')
    expect(out[0]?.text).toContain('Canva')
    expect(out[0]?.text).not.toContain('github')
  })

  test('résultat volumineux et fichier relu', () => {
    const out = tips({
      snapshot: null,
      projection: null,
      spends: [
        { key: 'Bash:./gradlew assembleRelease', label: 'Commande ./gradlew assembleRelease', tokens: 41_000, count: 1 },
        { key: 'Read:/app/register.tsx', label: 'Lecture app/register.tsx', tokens: 9_000, count: 4 },
      ],
      mcp: [],
      usedServers: [],
    })
    expect(out.map(t => t.title)).toEqual(['Résultat volumineux', 'Fichier relu'])
  })
})
