import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asKeyList,
  groupLiveSessions,
  liveListKey,
  liveListTitle,
  liveSessionJumpKey,
  liveSessionLabel,
  liveSessionTabKey,
  projectForCwd,
  selectedSections,
  withCollapsedKey,
} from '../src/lib/liveSessions'
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

test('最近（Codex）はアイドルの後ろに並ぶ', () => {
  const groups = groupLiveSessions([session('a', 'recent', 5), session('b', 'busy', 1), session('c', 'idle', 2)])
  assert.deepEqual(
    groups.map((g) => g.status),
    ['busy', 'idle', 'recent'],
  )
})

test('アカウントの見出しはエージェント・アカウント（無ければ設定ディレクトリの名前）・環境', () => {
  const list = {
    agent: 'claude' as const,
    shell: wsl,
    account: 'a@example.com',
    configDir: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude',
  }
  assert.equal(liveListTitle(list, false), 'Claude Code · a@example.com')
  assert.equal(liveListTitle(list, true), 'Claude Code · a@example.com · WSL: Ubuntu')
  const codex = { agent: 'codex' as const, shell: pwsh, account: null, configDir: 'C:\\Users\\me\\.codex\\' }
  assert.equal(liveListTitle(codex, true), 'Codex · .codex · Windows')
})

test('一覧の鍵は環境と設定ディレクトリで分かれる', () => {
  const a = liveListKey({ agent: 'claude', shell: wsl, configDir: '/x' })
  assert.notEqual(a, liveListKey({ agent: 'claude', shell: otherWsl, configDir: '/x' }))
  assert.notEqual(a, liveListKey({ agent: 'codex', shell: wsl, configDir: '/x' }))
  // シェルの種類が違っても、同じ環境（Windows）なら同じ鍵。
  assert.equal(
    liveListKey({ agent: 'claude', shell: pwsh, configDir: 'C:\\c' }),
    liveListKey({ agent: 'claude', shell: { kind: 'cmd' }, configDir: 'C:\\c' }),
  )
})

test('折り畳みはなりたい状態を渡し、古いものから捨てる', () => {
  assert.deepEqual(withCollapsedKey(['a'], 'b', true), ['a', 'b'])
  // 既に畳んでいるものを畳んでも、2 つにならない（別のウィンドウが先に畳んでいた）。
  assert.deepEqual(withCollapsedKey(['a', 'b'], 'a', true), ['b', 'a'])
  assert.deepEqual(withCollapsedKey(['a', 'b'], 'a', false), ['b'])
  assert.deepEqual(withCollapsedKey([], 'a', false), [])
  const many = Array.from({ length: 50 }, (_, i) => `k${i}`)
  const next = withCollapsedKey(many, 'new', true)
  assert.equal(next.length, 50)
  assert.equal(next[0], 'k1')
  assert.equal(next[49], 'new')
  // 手で編集された値は捨てる。
  assert.deepEqual(asKeyList(['a', 1, null, 'b']), ['a', 'b'])
  assert.deepEqual(asKeyList('a'), [])
})

test('選んだアカウントが一覧に無ければ全部を出す', () => {
  const sections = [{ key: 'a' }, { key: 'b' }]
  assert.deepEqual(
    selectedSections(sections, 'b').map((s) => s.key),
    ['b'],
  )
  assert.deepEqual(
    selectedSections(sections, null).map((s) => s.key),
    ['a', 'b'],
  )
  assert.deepEqual(
    selectedSections(sections, 'gone').map((s) => s.key),
    ['a', 'b'],
  )
})

test('distro の名前の大小だけ違うプロジェクトとも照合する（パスの大小は区別したまま）', () => {
  const projects = [{ id: 'repo', root: '/home/me/repo', shell: wsl }]
  const lower: ShellType = { kind: 'wsl', distro: 'ubuntu' }
  assert.equal(projectForCwd('/home/me/repo/src', lower, projects)?.id, 'repo')
  assert.equal(projectForCwd('/home/me/Repo/src', lower, projects), null)
})

test('タブとの突き合わせはエージェントと環境も見る（同じ id の別の環境の行にタブを付けない）', () => {
  const key = liveSessionTabKey('claude', wsl, 'abc')
  assert.notEqual(key, liveSessionTabKey('claude', otherWsl, 'abc'))
  assert.notEqual(key, liveSessionTabKey('claude', pwsh, 'abc'))
  assert.notEqual(key, liveSessionTabKey('codex', wsl, 'abc'))
  // distro の名前の大小は問わない（タブは `ubuntu`、一覧は `Ubuntu` でありうる）。
  assert.equal(key, liveSessionTabKey('claude', { kind: 'wsl', distro: 'ubuntu' }, 'abc'))
  // 同じ環境ならシェルの種類は問わない（タブは cmd、一覧はホストの既定の PowerShell）。
  assert.equal(liveSessionTabKey('claude', pwsh, 'abc'), liveSessionTabKey('claude', { kind: 'cmd' }, 'abc'))
})

test('移り先の説明はタブ → プロジェクト → ディレクトリの順', () => {
  assert.equal(liveSessionJumpKey({ tabId: 't1', project: {} }), 'liveSessions.jumpTab')
  assert.equal(liveSessionJumpKey({ tabId: null, project: {} }), 'liveSessions.jumpProject')
  assert.equal(liveSessionJumpKey({ tabId: null, project: null }), 'liveSessions.jumpDir')
})
