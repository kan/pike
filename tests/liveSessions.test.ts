import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupLiveSessions, liveSessionJumpKey, liveSessionLabel, projectForCwd } from '../src/lib/liveSessions'
import type { LiveSession } from '../src/types/liveSession'
import type { ShellType } from '../src/types/tab'

function session(id: string, status: LiveSession['status'], statusSince: number | null): LiveSession {
  return {
    pid: 1,
    sessionId: id,
    cwd: '/home/me/x',
    name: null,
    status,
    waitingFor: null,
    startedAt: null,
    statusSince,
    version: null,
    title: null,
    gitBranch: null,
  }
}

test('返答待ち・稼働中・アイドルの順に分け、空のグループは出さない', () => {
  const groups = groupLiveSessions([session('a', 'idle', 1), session('b', 'waiting', 2), session('c', 'idle', 3)])
  assert.deepEqual(
    groups.map((g) => [g.status, g.sessions.map((s) => s.sessionId)]),
    [
      ['waiting', ['b']],
      // グループの中は状態が変わった時刻の新しい順。時刻の無いものは末尾。
      ['idle', ['c', 'a']],
    ],
  )
  assert.deepEqual(groupLiveSessions([]), [])
})

const wsl: ShellType = { kind: 'wsl', distro: 'Ubuntu' }
const otherWsl: ShellType = { kind: 'wsl', distro: 'Debian' }
const pwsh: ShellType = { kind: 'powershell' }

test('cwd を含むプロジェクトのうち、root のいちばん深いものを選ぶ', () => {
  const projects = [
    { id: 'repo', root: '/home/me/repo', shell: wsl },
    { id: 'web', root: '/home/me/repo/packages/web', shell: wsl },
    { id: 'repo-old', root: '/home/me/repo-old', shell: wsl },
  ]
  assert.equal(projectForCwd('/home/me/repo/packages/web/src', wsl, projects)?.id, 'web')
  assert.equal(projectForCwd('/home/me/repo/.claude/worktrees/x', wsl, projects)?.id, 'repo')
  // 名前の前置が同じだけの隣のディレクトリを取り違えない。
  assert.equal(projectForCwd('/home/me/repo-old', wsl, projects)?.id, 'repo-old')
  assert.equal(projectForCwd('/home/me/other', wsl, projects), null)
})

test('別の場所（distro・Windows）のプロジェクトとは照合しない', () => {
  const projects = [
    { id: 'debian', root: '/home/me/repo', shell: otherWsl },
    { id: 'win', root: 'C:\\Users\\me\\repo', shell: pwsh },
  ]
  assert.equal(projectForCwd('/home/me/repo', wsl, projects), null)
  // Windows は大小と区切りを区別しない。
  assert.equal(projectForCwd('c:\\users\\me\\repo\\src', pwsh, projects)?.id, 'win')
})

test('名前は題 → Claude Code の名前 → ディレクトリ名の順', () => {
  assert.equal(liveSessionLabel({ title: '題', name: 'x-1', cwd: '/a/b' }), '題')
  assert.equal(liveSessionLabel({ title: null, name: 'x-1', cwd: '/a/b' }), 'x-1')
  assert.equal(liveSessionLabel({ title: null, name: null, cwd: 'C:\\a\\b\\' }), 'b')
})

test('移り先の説明はタブ → プロジェクト → ディレクトリの順', () => {
  assert.equal(liveSessionJumpKey({ tabId: 't1', project: {} }), 'liveSessions.jumpTab')
  assert.equal(liveSessionJumpKey({ tabId: null, project: {} }), 'liveSessions.jumpProject')
  assert.equal(liveSessionJumpKey({ tabId: null, project: null }), 'liveSessions.jumpDir')
})
