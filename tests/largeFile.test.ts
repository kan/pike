// 大きなファイルビューア（#630）のキャッシュとスクロールの計算。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  BLOCK_LINES,
  blocksFor,
  clampTop,
  LineBlockCache,
  linesForEdit,
  makeBlock,
  splitAt,
  splitEditText,
  thumbFor,
  topFromThumb,
  visibleSlice,
} from '../src/lib/largeFile.ts'

describe('blocksFor', () => {
  test('見えている範囲を覆うブロックを返す', () => {
    assert.deepEqual(blocksFor(0, 10, 1000), [0])
    assert.deepEqual(blocksFor(BLOCK_LINES - 5, 10, 1000), [0, 1])
    assert.deepEqual(blocksFor(BLOCK_LINES, BLOCK_LINES, 10_000), [1])
  })
  test('総行数の後ろは含めない', () => {
    assert.deepEqual(blocksFor(0, 50, 3), [0])
    assert.deepEqual(blocksFor(10, 50, 3), [])
  })
})

describe('LineBlockCache', () => {
  /** 2 つまでは収まり、3 つ目で溢れる上限。 */
  const twoBlocks = (lines: string[]) => makeBlock(lines, []).cost * 2

  test('上限を超えたら古いものから捨てる', () => {
    const cache = new LineBlockCache(twoBlocks(['aaaa']))
    cache.set(0, makeBlock(['aaaa'], []))
    cache.set(1, makeBlock(['bbbb'], []))
    cache.get(0) // 0 を新しくする
    cache.set(2, makeBlock(['cccc'], []))
    assert.ok(cache.has(0))
    assert.ok(!cache.has(1))
    assert.ok(cache.has(2))
  })
  test('keep に入れたブロックは捨てない', () => {
    const cache = new LineBlockCache(1)
    cache.set(0, makeBlock(['aaaa'], []))
    cache.set(1, makeBlock(['bbbb'], []), new Set([0]))
    assert.ok(cache.has(0))
    assert.ok(cache.has(1))
  })
  test('空行だけのブロックも上限に数えて捨てる', () => {
    const empty = Array.from({ length: BLOCK_LINES }, () => '')
    const cache = new LineBlockCache(twoBlocks(empty))
    for (let b = 0; b < 10; b++) cache.set(b, makeBlock(empty, []))
    assert.equal([...Array(10).keys()].filter((b) => cache.has(b)).length, 2)
    assert.ok(makeBlock(empty, []).cost > 0)
  })
  test('dropFrom はその行を含むブロックから後ろを捨てる', () => {
    const cache = new LineBlockCache()
    for (let b = 0; b < 4; b++) cache.set(b, makeBlock(['x'], []))
    cache.dropFrom(BLOCK_LINES * 2 + 3)
    assert.deepEqual(
      [0, 1, 2, 3].map((b) => cache.has(b)),
      [true, true, false, false],
    )
  })
  test('切った行の印を持つ', () => {
    const block = makeBlock(['a', 'b'], [1])
    assert.ok(block.cut.has(1))
    assert.ok(!block.cut.has(0))
  })
})

describe('スクロール', () => {
  test('top は 0 と「最後の行が下端に来る位置」のあいだに収める', () => {
    assert.equal(clampTop(-3, 100, 10), 0)
    assert.equal(clampTop(500, 100, 10), 90)
    assert.equal(clampTop(5, 3, 10), 0)
  })
  test('つまみは最小の高さを持ち、端から端まで動く', () => {
    const total = 10_000_000
    const start = thumbFor(0, total, 40, 800)
    assert.equal(start.size, 24)
    assert.equal(start.offset, 0)
    const end = thumbFor(total - 40, total, 40, 800)
    assert.equal(end.offset, 800 - 24)
  })
  test('つまみの位置から top へ戻せる', () => {
    const total = 10_000_000
    const top = 1_234_567
    const { offset } = thumbFor(top, total, 40, 800)
    assert.ok(Math.abs(topFromThumb(offset, total, 40, 800) - top) < 1e-3)
    assert.equal(topFromThumb(-10, total, 40, 800), 0)
    assert.equal(topFromThumb(9999, total, 40, 800), total - 40)
  })
  test('収まるときはつまみが全体を占める', () => {
    assert.deepEqual(thumbFor(0, 10, 40, 800), { size: 800, offset: 0 })
    assert.equal(topFromThumb(100, 10, 40, 800), 0)
  })
  test('1 億行でも 1 行未満の移動が残る', () => {
    const top = 99_999_000
    assert.notEqual(clampTop(top + 0.05, 100_000_000, 40), top)
  })
})

describe('編集', () => {
  test('linesForEdit はキャッシュの行を集める', () => {
    const cache = new LineBlockCache()
    const lines = Array.from({ length: BLOCK_LINES }, (_, i) => `l${i}`)
    cache.set(0, makeBlock(lines, [5]))
    cache.set(1, makeBlock(['next'], []))
    assert.deepEqual(linesForEdit(cache, 1, 2), ['l1', 'l2'])
    // ブロックをまたぐ。
    assert.deepEqual(linesForEdit(cache, BLOCK_LINES - 1, 2), [`l${BLOCK_LINES - 1}`, 'next'])
  })
  test('切った行があれば cut、読んでいない行があれば null', () => {
    const cache = new LineBlockCache()
    cache.set(0, makeBlock(['a', 'b', 'c', 'd', 'e', 'f'], [5]))
    assert.equal(linesForEdit(cache, 4, 2), 'cut')
    assert.equal(linesForEdit(cache, 5, 1), 'cut')
    assert.equal(linesForEdit(cache, 6, 1), null)
    assert.equal(linesForEdit(cache, BLOCK_LINES, 1), null)
  })
  test('splitEditText は CRLF と CR も改行にする', () => {
    assert.deepEqual(splitEditText('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd'])
    assert.deepEqual(splitEditText(''), [''])
    assert.deepEqual(splitEditText('x\n'), ['x', ''])
  })
})

describe('visibleSlice', () => {
  test('見えている行と前後の余白だけを描く', () => {
    assert.deepEqual(visibleSlice(0, 100, 20, 10_000, 2), { start: 0, end: 8 })
    assert.deepEqual(visibleSlice(2000, 100, 20, 10_000, 2), { start: 98, end: 108 })
  })
  test('末尾と空の一覧で範囲の外へ出ない', () => {
    assert.deepEqual(visibleSlice(999_999, 100, 20, 30, 2), { start: 30, end: 30 })
    assert.deepEqual(visibleSlice(0, 100, 20, 0), { start: 0, end: 0 })
    assert.deepEqual(visibleSlice(-50, 100, 20, 3, 2), { start: 0, end: 3 })
  })
})

describe('splitAt', () => {
  test('一致の前後に分ける', () => {
    assert.deepEqual(splitAt('foo needle bar', 4, 6), ['foo ', 'needle', ' bar'])
  })
  test('切った行の後ろの一致は空にする', () => {
    assert.deepEqual(splitAt('abc', 10, 3), ['abc', '', ''])
  })
})
