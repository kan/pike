// git のエラー文から原因を見分ける表（#436）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { classifyGitError } from '../src/lib/gitErrors.ts'

describe('classifyGitError', () => {
  test('見分けられないものは null', () => {
    assert.equal(classifyGitError('fatal: something nobody has seen before'), null)
    assert.equal(classifyGitError(''), null)
  })

  test('鍵が拒否された ssh の失敗は network ではなく auth', () => {
    const message = [
      'git@github.com: Permission denied (publickey).',
      'fatal: Could not read from remote repository.',
    ].join('\n')
    assert.equal(classifyGitError(message), 'auth')
  })

  test('ホスト鍵の確認は auth と分ける', () => {
    const message = ['Host key verification failed.', 'fatal: Could not read from remote repository.'].join('\n')
    assert.equal(classifyGitError(message), 'hostKey')
  })

  test('名前解決の失敗は network', () => {
    assert.equal(classifyGitError('ssh: Could not resolve hostname github.com'), 'network')
    assert.equal(
      classifyGitError("fatal: unable to access 'https://github.com/a/b/': Could not resolve host: github.com"),
      'network',
    )
  })

  test('ssh の Connection timed out は Pike の打ち切りと取り違えない', () => {
    assert.equal(classifyGitError('ssh: connect to host github.com port 22: Connection timed out'), 'network')
    assert.equal(classifyGitError('git timed out after 30s'), 'timeout')
  })

  test('push の拒否', () => {
    const message = [
      ' ! [rejected]        main -> main (fetch first)',
      "error: failed to push some refs to 'github.com:a/b.git'",
    ].join('\n')
    assert.equal(classifyGitError(message), 'pushRejected')
  })

  test('リモートや hook が拒否した push は見分けない（pull しても直らない）', () => {
    const message = [
      ' ! [remote rejected] main -> main (protected branch hook declined)',
      "error: failed to push some refs to 'github.com:a/b.git'",
    ].join('\n')
    assert.equal(classifyGitError(message), null)
    assert.equal(classifyGitError('error: src refspec main does not match any'), null)
  })

  test('https の 403 は network ではなく auth', () => {
    assert.equal(
      classifyGitError("fatal: unable to access 'https://github.com/a/b/': The requested URL returned error: 403"),
      'auth',
    )
  })

  test('上流の無いブランチ', () => {
    assert.equal(classifyGitError('fatal: The current branch topic has no upstream branch.'), 'noUpstream')
    assert.equal(classifyGitError('There is no tracking information for the current branch.'), 'noUpstream')
  })

  test('pull の方針が未設定', () => {
    assert.equal(classifyGitError('fatal: Need to specify how to reconcile divergent branches.'), 'divergent')
    assert.equal(classifyGitError('fatal: Not possible to fast-forward, aborting.'), 'divergent')
  })

  test('作業ツリーの変更が上書きされる', () => {
    assert.equal(
      classifyGitError('error: Your local changes to the following files would be overwritten by checkout:'),
      'localChanges',
    )
    assert.equal(
      classifyGitError('error: The following untracked working tree files would be overwritten by merge:'),
      'untrackedOverwrite',
    )
  })

  test('コンフリクト', () => {
    assert.equal(classifyGitError('CONFLICT (content): Merge conflict in src/a.ts'), 'conflict')
  })

  test('ロックファイル', () => {
    assert.equal(classifyGitError("fatal: Unable to create '/r/.git/index.lock': File exists."), 'lock')
  })

  test('コミットの前提が欠けている', () => {
    assert.equal(classifyGitError('Author identity unknown\n\n*** Please tell me who you are.'), 'identity')
    assert.equal(classifyGitError('error: gpg failed to sign the data'), 'signing')
    assert.equal(classifyGitError('nothing to commit, working tree clean'), 'nothingToCommit')
  })

  test('所有者の違うリポジトリ', () => {
    assert.equal(classifyGitError("fatal: detected dubious ownership in repository at '/r'"), 'dubiousOwnership')
  })

  test('同名のブランチ', () => {
    assert.equal(classifyGitError("fatal: a branch named 'topic' already exists"), 'branchExists')
  })
})
