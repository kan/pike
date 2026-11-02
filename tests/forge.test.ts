// ホスティングサービスの表（#541）と、そこから組む URL。`just test-ts` で走る（`tsx --test`、node:test）。
// ファイルの行（#540）の期待値の形は issue #540 の表（Git Web Links の handler のテストケースが出典）。
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  buildCommitLink,
  buildFileLink,
  type FileLinkTarget,
  type ForgeHost,
  normalizeForgeHost,
  parseForge,
  sanitizeForgeHosts,
  setForgeHosts,
} from '../src/lib/forge.ts'

describe('forge host mapping (#541 stage 2)', () => {
  const use = (hosts: unknown) => setForgeHosts(sanitizeForgeHosts(hosts))
  afterEach(() => setForgeHosts([]))

  test('GitHub Enterprise and GitLab on custom hosts', () => {
    use([
      { host: 'GHE.example.com', kind: 'github' },
      { host: 'git.example.com', kind: 'gitlab', name: '社内 GitLab' },
    ])
    const ghe = parseForge('git@ghe.example.com:team/app.git')
    assert.equal(ghe?.kind, 'github')
    assert.equal(ghe?.baseUrl, 'https://ghe.example.com/team/app')
    assert.equal(ghe?.issues, 'github')
    const gl = parseForge('https://git.example.com/a/b/c.git')
    assert.equal(gl?.label, '社内 GitLab')
    assert.equal(gl?.baseUrl, 'https://git.example.com/a/b/c')
    assert.equal(gl?.issues, null)
  })

  test('an SSH Host alias points at the real web host', () => {
    use([{ host: 'github.com-work', kind: 'github', webBase: 'https://github.com/' }])
    const f = parseForge('git@github.com-work:kan/pike.git')
    assert.equal(f?.baseUrl, 'https://github.com/kan/pike')
    assert.equal(f?.label, 'GitHub')
  })

  test('the mapping wins over the public table, and works with or without the port', () => {
    use([{ host: 'git.example.com', kind: 'gitea', webBase: 'https://git.example.com:3000' }])
    assert.equal(parseForge('ssh://git@git.example.com:2222/o/r.git')?.baseUrl, 'https://git.example.com:3000/o/r')
    use([{ host: 'git.example.com:2222', kind: 'gitea' }])
    assert.equal(parseForge('ssh://git@git.example.com:2222/o/r.git')?.baseUrl, 'https://git.example.com/o/r')
  })

  test('an exact host:port entry wins over a portless one listed first', () => {
    use([
      { host: 'git.example.com', kind: 'gitlab' },
      { host: 'git.example.com:2222', kind: 'gitea' },
    ])
    assert.equal(parseForge('ssh://git@git.example.com:2222/o/r.git')?.kind, 'gitea')
    assert.equal(parseForge('git@git.example.com:o/r.git')?.kind, 'gitlab')
  })

  test('an https remote keeps its scheme and port for the default web URL; ssh drops it', () => {
    use([{ host: 'git.example.com', kind: 'gitlab' }])
    assert.equal(parseForge('https://git.example.com:8443/o/r.git')?.baseUrl, 'https://git.example.com:8443/o/r')
    assert.equal(parseForge('http://git.example.com/o/r.git')?.baseUrl, 'http://git.example.com/o/r')
    assert.equal(parseForge('ssh://git@git.example.com:2222/o/r.git')?.baseUrl, 'https://git.example.com/o/r')
  })

  test('public hosts are found through a remote with an explicit port', () => {
    assert.equal(parseForge('ssh://git@github.com:22/kan/pike.git')?.baseUrl, 'https://github.com/kan/pike')
  })

  test('a pasted remote URL or user@host is reduced to the host', () => {
    assert.equal(normalizeForgeHost('git@GHE.example.com:team/app.git'), 'ghe.example.com')
    assert.equal(normalizeForgeHost('https://user@ghe.example.com/team/app'), 'ghe.example.com')
    assert.equal(normalizeForgeHost('ssh://git@bb.example.com:7999/proj/app.git'), 'bb.example.com:7999')
    assert.equal(normalizeForgeHost('bad host'), '')
  })

  test('Bitbucket Data Center', () => {
    use([{ host: 'bb.example.com', kind: 'bitbucket-dc', webBase: 'https://bb.example.com/bitbucket' }])
    const ssh = parseForge('ssh://git@bb.example.com:7999/proj/app.git')
    assert.equal(ssh?.baseUrl, 'https://bb.example.com/bitbucket/projects/proj/repos/app')
    const http = parseForge('https://bb.example.com/bitbucket/scm/proj/app.git')
    assert.equal(http?.baseUrl, 'https://bb.example.com/bitbucket/projects/proj/repos/app')
    assert.equal(
      parseForge('ssh://git@bb.example.com:7999/~kan/dots.git')?.baseUrl,
      'https://bb.example.com/bitbucket/users/kan/repos/dots',
    )
    const remote = 'ssh://git@bb.example.com:7999/proj/app.git'
    assert.equal(
      buildCommitLink(remote, 'abc')?.url,
      'https://bb.example.com/bitbucket/projects/proj/repos/app/commits/abc',
    )
    assert.equal(
      buildFileLink(remote, { commit: 'abc', path: 'src/a b.ts', range: { start: 10, end: 30 }, markdown: false })?.url,
      'https://bb.example.com/bitbucket/projects/proj/repos/app/browse/src/a%20b.ts?at=abc#10-30',
    )
    assert.equal(
      buildFileLink(remote, { commit: 'abc', branch: 'feature/x', path: 'a.ts', range: null, markdown: false })?.url,
      'https://bb.example.com/bitbucket/projects/proj/repos/app/browse/a.ts?at=refs%2Fheads%2Ffeature%2Fx',
    )
  })

  test('sanitize keeps unknown kinds (from a newer Pike) but they are not used', () => {
    const hosts: ForgeHost[] = sanitizeForgeHosts([
      { host: ' A.example.com ', kind: 'azure' },
      { host: 'a.example.com', kind: 'github' },
      { host: '', kind: 'github' },
      { host: 'bad host', kind: 'github' },
      { host: 'b.example.com', kind: 'github', webBase: 'ftp://x', name: '  ' },
      'junk',
    ])
    assert.deepEqual(hosts, [
      { host: 'a.example.com', kind: 'azure' },
      { host: 'b.example.com', kind: 'github' },
    ])
    setForgeHosts(hosts)
    assert.equal(parseForge('git@a.example.com:o/r.git'), null)
  })
})

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
