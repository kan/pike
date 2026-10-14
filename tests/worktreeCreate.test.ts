// worktree の作成（#478）の置き場所の解決とパターンの読み取り。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseJsonc } from '../src/lib/jsonc.ts'
import {
  includeFromVscodeSettings,
  includeFromWorktreeInclude,
  resolveWorktreePath,
  worktreeDirName,
} from '../src/lib/worktreeCreate.ts'
import type { ShellType } from '../src/types/tab.ts'

const wsl: ShellType = { kind: 'wsl', distro: 'Ubuntu' }
const pwsh: ShellType = { kind: 'pwsh' }

describe('置き場所', () => {
  test('既定は repo の隣の <repo 名>.worktrees', () => {
    assert.equal(resolveWorktreePath('', '/home/u/src/pike', 'feat', wsl), '/home/u/src/pike.worktrees/feat')
    assert.equal(resolveWorktreePath('  ', 'C:\\src\\pike\\', 'feat', pwsh), 'C:\\src\\pike.worktrees\\feat')
  })

  test('相対パスは repo のルートから読む', () => {
    assert.equal(resolveWorktreePath('.worktrees', '/r/pike', 'feat', wsl), '/r/pike/.worktrees/feat')
    assert.equal(resolveWorktreePath('.', '/r/pike', 'feat', wsl), '/r/pike/feat')
  })

  test('絶対パスは固定の場所。${repoName} を置き換える', () => {
    assert.equal(resolveWorktreePath('/wt/${repoName}', '/r/pike', 'feat', wsl), '/wt/pike/feat')
    assert.equal(resolveWorktreePath('D:/wt', 'C:\\src\\pike', 'feat', pwsh), 'D:\\wt\\feat')
  })

  test('~ は残す（展開は Rust）', () => {
    assert.equal(resolveWorktreePath('~/wt/${repoName}', '/r/pike', 'feat', wsl), '~/wt/pike/feat')
  })

  test('ブランチ名の / はディレクトリ名では - になる', () => {
    assert.equal(worktreeDirName('feature/login'), 'feature-login')
    assert.equal(resolveWorktreePath('', '/r/pike', 'feature/login', wsl), '/r/pike.worktrees/feature-login')
  })
})

describe('持っていくファイルのパターン', () => {
  test('.vscode/settings.json の git.worktreeIncludeFiles を読む（コメント付き）', () => {
    const json = parseJsonc(`{
      // 環境ごとの値
      "git.worktreeIncludeFiles": [".env", "node_modules/", 42, "", "bad\\nline"],
      "editor.tabSize": 2,
    }`)
    assert.deepEqual(includeFromVscodeSettings(json), ['.env', 'node_modules/'])
  })

  test('設定が無い・形が違うときは空', () => {
    assert.deepEqual(includeFromVscodeSettings(null), [])
    assert.deepEqual(includeFromVscodeSettings({ 'git.worktreeIncludeFiles': '.env' }), [])
  })

  test('.worktreeinclude はコメントと空行を落とし、末尾の空白を削る', () => {
    const text = '# secrets\r\n.env  \n\n!keep\\ \nconfig/local.json\n'
    assert.deepEqual(includeFromWorktreeInclude(text), ['.env', '!keep\\ ', 'config/local.json'])
  })
})
