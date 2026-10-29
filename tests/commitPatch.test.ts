// 複数ファイルの差分の分け方（コミットタブ #374、作業中の変更のタブ #526）。`just test-ts` で走る。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePatch } from '../src/lib/commitPatch.ts'

test('コンフリクト中の combined diff は飛ばし、直前のファイルに混ぜない', () => {
  const raw = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --cc b.txt',
    'index 3333333,4444444..0000000',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@@ -1,1 -1,1 +1,5 @@@',
    '++<<<<<<< HEAD',
    ' +ours',
    'diff --git a/c.txt b/c.txt',
    '--- a/c.txt',
    '+++ b/c.txt',
    '@@ -1 +1,2 @@',
    ' keep',
    '+added',
    '',
  ].join('\n')
  const files = parsePatch(raw)
  assert.deepEqual(
    files.map((f) => [f.path, f.added, f.removed]),
    [
      ['a.txt', 1, 1],
      ['c.txt', 1, 0],
    ],
  )
  assert.equal(files[0].lines.length, 3)
})
