// フロントのエラーをログへ残すときの間引きと整形（#415）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createThrottle, describeError, errorKey, formatEntry } from '../src/lib/errorLog.ts'

describe('createThrottle', () => {
  test('同じ鍵は間隔の中では書かず、次に書くときに省いた回数を返す', () => {
    let now = 0
    const throttle = createThrottle(1000, () => now)
    assert.equal(throttle('a'), 0)
    now = 500
    assert.equal(throttle('a'), null)
    assert.equal(throttle('a'), null)
    now = 1000
    assert.equal(throttle('a'), 2)
    // 数え直す
    now = 2500
    assert.equal(throttle('a'), 0)
  })

  test('鍵が違えば間引かない', () => {
    const throttle = createThrottle(1000, () => 0)
    assert.equal(throttle('a'), 0)
    assert.equal(throttle('b'), 0)
  })
})

describe('describeError', () => {
  test('スタックの先頭にメッセージがあればそのまま', () => {
    const err = new TypeError('x is undefined')
    err.stack = 'TypeError: x is undefined\n    at f (app.js:1:2)'
    assert.equal(describeError(err), err.stack)
  })

  test('スタックにメッセージが無ければ先頭に足す（WKWebView）', () => {
    const err = new TypeError('x is undefined')
    err.stack = 'f@app.js:1:2'
    assert.equal(describeError(err), 'TypeError: x is undefined\nf@app.js:1:2')
  })

  test('Error 以外', () => {
    assert.equal(describeError('plain'), 'plain')
    assert.equal(describeError({ code: 1 }), '{"code":1}')
    assert.equal(describeError(undefined), 'undefined')
  })
})

describe('errorKey / formatEntry', () => {
  test('間引きの鍵はスタックを除いた 1 行目', () => {
    const a = new Error('boom')
    a.stack = 'Error: boom\n    at a (x.js:1:1)'
    const b = new Error('boom')
    b.stack = 'Error: boom\n    at b (y.js:2:2)'
    assert.equal(errorKey('vue (render)', a), 'vue (render): Error: boom')
    assert.equal(errorKey('vue (render)', a), errorKey('vue (render)', b))
    assert.equal(errorKey('s', 'line1\nline2'), 's: line1')
    assert.equal(formatEntry('vue (render)', a), 'vue (render): Error: boom\n    at a (x.js:1:1)')
  })

  test('長すぎるものは切る', () => {
    assert.equal(formatEntry('s', 'x'.repeat(10_000)).length, 4_000)
  })
})
