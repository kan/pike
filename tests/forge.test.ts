// ホスティングサービスの表（#541）と、そこから組む URL。`just test-ts` で走る（`tsx --test`、node:test）。
// ファイルの行（#540）の期待値の形は issue #540 の表（Git Web Links の handler のテストケースが出典）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildCommitLink, buildFileLink, type FileLinkTarget, parseForge } from '../src/lib/forge.ts'

describe('parseForge', () => {
  test('known hosts', () => {
    const gh = parseForge('git@github.com:kan/pike.git')
    assert.equal(gh?.kind, 'github')
    assert.equal(gh?.label, 'GitHub')
    assert.equal(gh?.baseUrl, 'https://github.com/kan/pike')
    assert.equal(parseForge('https://gitlab.com/g/sub/r.git')?.baseUrl, 'https://gitlab.com/g/sub/r')
    assert.equal(parseForge('git@bitbucket.org:t/r.git')?.kind, 'bitbucket')
  })

  test('Codeberg is a Gitea forge but keeps its own name', () => {
    const cb = parseForge('https://codeberg.org/o/r')
    assert.equal(cb?.kind, 'gitea')
    assert.equal(cb?.label, 'Codeberg')
  })

  test('only GitHub has the issue panel and a new-issue page', () => {
    assert.equal(parseForge('https://github.com/kan/pike')?.issues, 'github')
    assert.equal(parseForge('https://github.com/kan/pike')?.newIssueUrl, 'https://github.com/kan/pike/issues/new')
    for (const r of ['https://gitlab.com/g/r', 'https://bitbucket.org/t/r', 'https://codeberg.org/o/r']) {
      assert.equal(parseForge(r)?.issues, null, r)
      assert.equal(parseForge(r)?.newIssueUrl, null, r)
    }
  })

  test('unknown hosts and non-remotes', () => {
    assert.equal(parseForge('https://example.com/a/b'), null)
    assert.equal(parseForge('git@github.com-work:kan/pike.git'), null)
    assert.equal(parseForge('C:\\src\\pike'), null)
    assert.equal(parseForge('https://github.com/kan'), null)
    assert.equal(parseForge(null), null)
  })
})

describe('buildCommitLink', () => {
  test('commit pages per forge', () => {
    assert.equal(buildCommitLink('https://github.com/o/r', 'abc')?.url, 'https://github.com/o/r/commit/abc')
    assert.equal(buildCommitLink('https://gitlab.com/o/r', 'abc')?.url, 'https://gitlab.com/o/r/-/commit/abc')
    assert.equal(buildCommitLink('https://bitbucket.org/o/r', 'abc')?.url, 'https://bitbucket.org/o/r/commits/abc')
    assert.equal(buildCommitLink('https://codeberg.org/o/r', 'abc')?.url, 'https://codeberg.org/o/r/commit/abc')
  })

  test('carries the host label', () => {
    assert.equal(buildCommitLink('git@codeberg.org:o/r.git', 'abc')?.label, 'Codeberg')
    assert.equal(buildCommitLink('https://example.com/o/r', 'abc'), null)
  })
})

const SHA = '0123456789abcdef0123456789abcdef01234567'
const BRANCH_SHA = 'fedcba9876543210fedcba9876543210fedcba98'

const target = (over: Partial<FileLinkTarget> = {}): FileLinkTarget => ({
  commit: SHA,
  path: 'src/a.ts',
  range: { start: 10, end: 10 },
  markdown: false,
  ...over,
})

const url = (remote: string, over: Partial<FileLinkTarget> = {}) => buildFileLink(remote, target(over))?.url

describe('buildFileLink', () => {
  test('GitHub', () => {
    const r = 'git@github.com:kan/pike.git'
    assert.equal(url(r), `https://github.com/kan/pike/blob/${SHA}/src/a.ts#L10`)
    assert.equal(url(r, { range: { start: 10, end: 30 } }), `https://github.com/kan/pike/blob/${SHA}/src/a.ts#L10-L30`)
    assert.equal(
      url(r, { path: 'README.md', markdown: true }),
      `https://github.com/kan/pike/blob/${SHA}/README.md?plain=1#L10`,
    )
    assert.equal(url(r, { range: null }), `https://github.com/kan/pike/blob/${SHA}/src/a.ts`)
    assert.equal(buildFileLink(r, target())?.label, 'GitHub')
  })

  test('GitLab', () => {
    const r = 'https://gitlab.com/group/sub/repo.git'
    assert.equal(url(r), `https://gitlab.com/group/sub/repo/-/blob/${SHA}/src/a.ts#L10`)
    assert.equal(
      url(r, { range: { start: 10, end: 30 } }),
      `https://gitlab.com/group/sub/repo/-/blob/${SHA}/src/a.ts#L10-30`,
    )
    assert.equal(
      url(r, { path: 'a.md', markdown: true }),
      `https://gitlab.com/group/sub/repo/-/blob/${SHA}/a.md?plain=1#L10`,
    )
  })

  test('Bitbucket', () => {
    const r = 'git@bitbucket.org:team/repo.git'
    assert.equal(url(r), `https://bitbucket.org/team/repo/src/${SHA}/src/a.ts#lines-10`)
    assert.equal(
      url(r, { range: { start: 10, end: 30 } }),
      `https://bitbucket.org/team/repo/src/${SHA}/src/a.ts#lines-10:30`,
    )
    // ソースを表示させる指定が無いので、Markdown でも何も足さない。
    assert.equal(url(r, { path: 'a.md', markdown: true }), `https://bitbucket.org/team/repo/src/${SHA}/a.md#lines-10`)
  })

  test('Codeberg', () => {
    const r = 'https://codeberg.org/owner/repo'
    assert.equal(url(r), `https://codeberg.org/owner/repo/src/commit/${SHA}/src/a.ts#L10`)
    assert.equal(
      url(r, { range: { start: 10, end: 30 } }),
      `https://codeberg.org/owner/repo/src/commit/${SHA}/src/a.ts#L10-L30`,
    )
    assert.equal(
      url(r, { path: 'a.md', markdown: true }),
      `https://codeberg.org/owner/repo/src/commit/${SHA}/a.md?display=source#L10`,
    )
  })

  test('encodes each path segment, keeping the slashes', () => {
    assert.equal(
      url('https://github.com/kan/pike', { path: 'dir with space/test#file.ts' }),
      `https://github.com/kan/pike/blob/${SHA}/dir%20with%20space/test%23file.ts#L10`,
    )
  })

  test('branch links', () => {
    const b = { commit: BRANCH_SHA, branch: 'feature/x#1' }
    assert.equal(url('https://github.com/kan/pike', b), 'https://github.com/kan/pike/blob/feature/x%231/src/a.ts#L10')
    assert.equal(url('https://gitlab.com/g/r', b), 'https://gitlab.com/g/r/-/blob/feature/x%231/src/a.ts#L10')
    assert.equal(url('https://codeberg.org/o/r', b), 'https://codeberg.org/o/r/src/branch/feature/x%231/src/a.ts#L10')
    // Bitbucket は `/` のあるブランチを `src/` の直後に置けないので、SHA と `?at=` にする。
    assert.equal(
      url('https://bitbucket.org/t/r', b),
      `https://bitbucket.org/t/r/src/${BRANCH_SHA}/src/a.ts?at=feature%2Fx%231#lines-10`,
    )
    assert.equal(
      url('https://bitbucket.org/t/r', { commit: BRANCH_SHA, branch: 'main' }),
      'https://bitbucket.org/t/r/src/main/src/a.ts#lines-10',
    )
  })

  test('unknown hosts give no link', () => {
    assert.equal(buildFileLink('https://example.com/a/b', target()), null)
    assert.equal(buildFileLink(null, target()), null)
  })
})
