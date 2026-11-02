// ファイルの行を指す URL（#540）。`just test-ts` で走る（`tsx --test`、node:test）。
// 期待値の形は issue #540 の表（Git Web Links の handler のテストケースが出典）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildFileLink, type FileLinkTarget } from '../src/lib/gitRemote.ts'

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
