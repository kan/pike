// diff タブのプレビュー比較（#524）の純粋な部分: 比べられる種別、差分のヘッダ、左右がどの版か。
// `just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseFileHeader, parseRename } from '../src/lib/diffParser.ts'
import { previewKindOf } from '../src/lib/fileType.ts'
import type { DiffTab } from '../src/types/tab.ts'

// `diffSource.ts` は取り寄せのために `lib/tauri.ts` を読み、あちらは Vite が置き換えるビルド時の
// 定数を参照する。テストでは置き換わらないので、読み込む前に置いておく（呼ぶのは純粋な `diffSides` だけ）。
;(globalThis as { __PIKE_E2E__?: boolean }).__PIKE_E2E__ = false
const { diffSides } = await import('../src/lib/diffSource.ts')

function tabOf(diff: string, extra: Partial<DiffTab> = {}): DiffTab {
  return { id: 't', kind: 'diff', title: 'x', pinned: false, filePath: 'docs/a.md', root: '/repo', diff, ...extra }
}

const modified = [
  'diff --git a/docs/a.md b/docs/a.md',
  'index 1111111..2222222 100644',
  '--- a/docs/a.md',
  '+++ b/docs/a.md',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n')

describe('previewKindOf', () => {
  test('画像・Markdown・rst・SVG・Mermaid だけを比べる', () => {
    assert.equal(previewKindOf('img/a.png'), 'image')
    assert.equal(previewKindOf('README.md'), 'markdown')
    assert.equal(previewKindOf('notes.markdown'), 'markdown')
    assert.equal(previewKindOf('doc/index.rst'), 'rst')
    assert.equal(previewKindOf('icon.svg'), 'svg')
    assert.equal(previewKindOf('flow.mmd'), 'mermaid')
    assert.equal(previewKindOf('data.csv'), null)
    assert.equal(previewKindOf('src/main.ts'), null)
  })
})

describe('parseFileHeader', () => {
  test('blob を index の行から読む', () => {
    assert.deepEqual(parseFileHeader(modified), {
      added: false,
      deleted: false,
      oldBlob: '1111111',
      newBlob: '2222222',
    })
  })

  test('追加と削除をヘッダから読む', () => {
    const added = [
      'diff --git a/x b/x',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/x',
      '@@ -0,0 +1 @@',
      '+a',
    ].join('\n')
    const deleted = [
      'diff --git a/x b/x',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/x',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-a',
    ].join('\n')
    assert.equal(parseFileHeader(added).added, true)
    assert.equal(parseFileHeader(deleted).deleted, true)
  })

  test('本文の行はヘッダとして読まない', () => {
    const body = [...modified.split('\n').slice(0, 5), '+new file mode 100644', '+rename from x', ''].join('\n')
    assert.equal(parseFileHeader(body).added, false)
    assert.equal(parseRename(body), null)
  })
})

describe('diffSides', () => {
  test('作業ツリーの差分は index → 作業ツリー', () => {
    assert.deepEqual(diffSides(tabOf(modified)), [
      { rev: '', path: 'docs/a.md', blob: '1111111' },
      { rev: null, path: 'docs/a.md', blob: '2222222' },
    ])
  })

  test('ステージ済みは HEAD → index、リネームなら変更前は元の名前', () => {
    const renamed = [
      'diff --git a/old.md b/docs/a.md',
      'similarity index 90%',
      'rename from old.md',
      'rename to docs/a.md',
      'index 1111111..2222222 100644',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n')
    assert.deepEqual(diffSides(tabOf(renamed, { staged: true })), [
      { rev: 'HEAD', path: 'old.md', blob: '1111111' },
      { rev: '', path: 'docs/a.md', blob: '2222222' },
    ])
  })

  test('コミットは親 → そのコミット', () => {
    const [before, after] = diffSides(tabOf(modified, { commitHash: 'abc' }))
    assert.equal(before?.rev, 'abc^')
    assert.equal(after?.rev, 'abc')
  })

  test('追跡していないファイルは変更前が無い', () => {
    assert.equal(diffSides(tabOf(modified, { untracked: true }))[0], null)
  })
})
