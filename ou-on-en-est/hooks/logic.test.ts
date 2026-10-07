import { describe, expect, test } from 'claude-code/testing'

import type { RepoState } from '../types'
import { parsePairs, parsePr, parseStatus, relationText, repoFlags, splitList, summary } from './logic'

const REPO: RepoState = {
  name: 'mobile-app',
  path: '/p/mobile-app',
  branch: 'main',
  dirty: 0,
  ahead: 0,
  behind: 0,
  noUpstream: false,
  aheadOfMain: 0,
  mainBranch: 'main',
  mainSha: '2bcc49d',
  pr: null,
  note: null,
}

describe('réglages', () => {
  test('listes et paires', () => {
    expect(splitList('a, b,\nc')).toEqual(['a', 'b', 'c'])
    expect(parsePairs('api=/home/deploy/api, screen=/srv/screen, broken')).toEqual([
      { name: 'api', path: '/home/deploy/api' },
      { name: 'screen', path: '/srv/screen' },
    ])
  })
})

describe('git status', () => {
  test('branche, distant, avance, retard, fichiers', () => {
    const s = parseStatus(
      '# branch.oid abc\n# branch.head feat/login\n# branch.upstream origin/feat/login\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/x.ts\n? new.txt\n',
    )
    expect(s).toEqual({ branch: 'feat/login', upstream: 'origin/feat/login', ahead: 2, behind: 1, dirty: 2 })
  })
  test('branche sans distant', () => {
    expect(parseStatus('# branch.oid abc\n# branch.head wip\n').upstream).toBe(null)
  })
})

describe('PR', () => {
  test('CI verte, rouge, en cours, absente', () => {
    expect(parsePr('{"number":193,"state":"OPEN","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}')?.checks).toBe('pass')
    expect(parsePr('{"number":193,"state":"OPEN","statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"}]}')?.checks).toBe('fail')
    expect(parsePr('{"number":193,"state":"OPEN","statusCheckRollup":[{"status":"IN_PROGRESS","conclusion":null}]}')?.checks).toBe('pending')
    expect(parsePr('{"number":193,"state":"OPEN","statusCheckRollup":[]}')?.checks).toBe('none')
    expect(parsePr('no pull requests found')).toBe(null)
  })
})

describe('ce qui est à faire', () => {
  test('dépôt propre', () => {
    expect(repoFlags(REPO)).toEqual([{ level: 'ok', text: 'propre' }])
  })
  test('non poussé, modifié, CI rouge en premier', () => {
    const flags = repoFlags({ ...REPO, ahead: 2, dirty: 3, branch: 'feat/x', pr: { number: 12, state: 'OPEN', checks: 'fail' } })
    expect(flags.map(f => f.text)).toEqual(['PR #12 CI rouge', '↑2 non poussés', '✎ 3 fichiers'])
  })
  test('branche locale jamais poussée', () => {
    expect(repoFlags({ ...REPO, branch: 'essai', noUpstream: true, aheadOfMain: 1 }).map(f => f.text)).toEqual([
      'branche jamais poussée',
      '1 commit hors de main',
    ])
  })
  test('résumé', () => {
    const s = summary(
      [{ ...REPO, ahead: 2 }, { ...REPO, name: 'b', dirty: 1 }],
      [{ name: 'mobile-app', sha: 'a', relation: 'ahead', dirty: 0 }],
    )
    expect(s).toBe('1 dépôt non poussé · 1 avec modifs · serveur ≠ main ×1')
    expect(summary([REPO], [])).toBe('dépôts propres')
  })
  test('VPS', () => {
    expect(relationText({ name: 'x', sha: 'a', relation: 'ahead', dirty: 0 }, 'main')).toBe('en avance sur main')
    expect(relationText({ name: 'x', sha: 'a', relation: 'ahead', dirty: 0 }, 'main', 'en')).toBe('ahead of main')
  })
  test('in English', () => {
    expect(repoFlags({ ...REPO, ahead: 2, dirty: 1 }, 'en').map(f => f.text)).toEqual(['↑2 unpushed', '✎ 1 file'])
    expect(summary([REPO], [], 'en')).toBe('repos clean')
  })
})
