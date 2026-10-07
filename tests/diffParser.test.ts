// 左右の行の対応付け。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type DiffLine, parseDiff } from '../src/lib/diffParser.ts'

function diffOf(...body: string[]): string {
  return ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,9 +1,9 @@', ...body, ''].join('\n')
}

/** `@@` の行を除いた `[左の行番号, 左, 右の行番号, 右]`。 */
function rows(lines: DiffLine[]) {
  const text = (segments: { text: string }[]) => segments.map((s) => s.text).join('')
  return lines
    .filter((l) => l.left.type !== 'hunk')
    .map((l) => [l.left.num, text(l.left.segments), l.right.num, text(l.right.segments)])
}

describe('parseDiff', () => {
  test('削除と追加が複数行ずつ続いても、追加行は上から順に並ぶ', () => {
    const raw = diffOf(' ctx', '-old1', '-old2', '+new1', '+new2', ' end')
    for (const charLevel of [false, true]) {
      assert.deepEqual(rows(parseDiff(raw, { charLevel })), [
        [1, 'ctx', 1, 'ctx'],
        [2, 'old1', 2, 'new1'],
        [3, 'old2', 3, 'new2'],
        [4, 'end', 4, 'end'],
      ])
    }
  })

  test('追加のほうが多ければ、余りは左を空にして続ける', () => {
    const raw = diffOf('-old1', '-old2', '+new1', '+new2', '+new3')
    assert.deepEqual(rows(parseDiff(raw)), [
      [1, 'old1', 1, 'new1'],
      [2, 'old2', 2, 'new2'],
      [null, '', 3, 'new3'],
    ])
  })

  test('削除のほうが多ければ、余りは右を空にして残す', () => {
    const raw = diffOf('-old1', '-old2', '-old3', '+new1', ' end')
    assert.deepEqual(rows(parseDiff(raw)), [
      [1, 'old1', 1, 'new1'],
      [2, 'old2', null, ''],
      [3, 'old3', null, ''],
      [4, 'end', 2, 'end'],
    ])
  })
})
