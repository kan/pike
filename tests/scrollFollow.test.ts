// 分割表示のスクロール同期の向き（#465）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createScrollFollow, FOLLOW_HOLD_MS } from '../src/lib/scrollFollow.ts'

function setup() {
  let time = 0
  const follow = createScrollFollow(() => time)
  return {
    follow,
    advance(ms: number) {
      time += ms
    },
  }
}

describe('createScrollFollow', () => {
  test('写した相手の scroll は写し返さない', () => {
    const { follow, advance } = setup()
    assert.equal(follow.claim('preview', 100), true)
    follow.wrote('editor', 50)
    advance(16)
    assert.equal(follow.claim('editor', 50), false)
  })

  test('写すたびに追従が延びる（スムーズスクロールのあいだは続く）', () => {
    const { follow, advance } = setup()
    for (let i = 0; i < 20; i++) {
      assert.equal(follow.claim('preview', i * 10), true)
      advance(FOLLOW_HOLD_MS - 1)
      // 位置が書いたものと違っても（CodeMirror が自分でずらした）、追従中なら写さない。
      assert.equal(follow.claim('editor', i * 5 + 30), false)
    }
  })

  test('時間が過ぎれば、追従していたペインからも写せる', () => {
    const { follow, advance } = setup()
    follow.claim('preview', 100)
    follow.wrote('editor', 50)
    advance(FOLLOW_HOLD_MS)
    assert.equal(follow.claim('editor', 80), true)
    // 向きが入れ替わり、今度はプレビューが追従する。
    assert.equal(follow.claim('preview', 160), false)
  })

  test('時間が過ぎても、書いた位置のまま届いた scroll は写し返さない', () => {
    const { follow, advance } = setup()
    follow.claim('preview', 100)
    follow.wrote('editor', 50.4)
    advance(FOLLOW_HOLD_MS * 10)
    assert.equal(follow.claim('editor', 50), false)
  })

  test('覚えた位置は 1 回で使い切る（同じ位置へ利用者が動かした scroll は写す）', () => {
    const { follow, advance } = setup()
    follow.claim('preview', 100)
    follow.wrote('editor', 50)
    advance(16)
    assert.equal(follow.claim('editor', 50), false)
    advance(FOLLOW_HOLD_MS)
    assert.equal(follow.claim('editor', 50), true)
  })

  test('追従中のペインを利用者が動かしたら、その場で写せる', () => {
    const { follow, advance } = setup()
    follow.claim('preview', 100)
    follow.wrote('editor', 50)
    advance(16)
    follow.release('editor')
    assert.equal(follow.claim('editor', 90), true)
  })

  test('追従を解いた直後でも、書いた位置のまま届いた scroll は写し返さない', () => {
    const { follow, advance } = setup()
    follow.claim('preview', 100)
    follow.wrote('editor', 50)
    advance(16)
    follow.release('editor')
    assert.equal(follow.claim('editor', 50), false)
    // 向きは変わっていないので、プレビューの続きはそのまま写せる。
    assert.equal(follow.claim('preview', 120), true)
  })

  test('動かしている側への入力では追従を解かない', () => {
    const { follow, advance } = setup()
    follow.claim('preview', 100)
    advance(16)
    follow.release('preview')
    assert.equal(follow.claim('editor', 70), false)
  })
})
