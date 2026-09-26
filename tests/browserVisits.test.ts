// ブラウザのタブの閲覧履歴に載せる時点（#412 / #416）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, mock, test } from 'node:test'
import { createVisitQueue } from '../src/lib/browserVisits.ts'

function setup(delayMs: number | null, initialUrl = '') {
  const committed: string[] = []
  const visits = createVisitQueue({ delayMs, initialUrl, commit: (url) => committed.push(url) })
  return { visits, committed }
}

describe('移動の知らせで決める（Windows）', () => {
  test('ユーザーの操作で離れたページは載せる', () => {
    const { visits, committed } = setup(null)
    visits.queue('https://a.example/')
    assert.deepEqual(committed, [])
    visits.navigationStarting(true)
    assert.deepEqual(committed, ['https://a.example/'])
  })

  test('スクリプトで離れたページはリダイレクトとして捨てる', () => {
    const { visits, committed } = setup(null)
    visits.queue('https://sso.example/redirecting')
    visits.navigationStarting(false)
    visits.queue('https://app.example/')
    visits.navigationStarting(true)
    assert.deepEqual(committed, ['https://app.example/'])
  })

  test('スクリプトが同じページを読み直しただけなら捨てない（location.reload / meta refresh）', () => {
    const { visits, committed } = setup(null)
    visits.queue('https://dash.example/')
    visits.navigationStarting(false)
    visits.queue('https://dash.example/')
    // 読み直したページは待たせたまま。このあとユーザーの操作で離れたら載る。
    visits.navigationStarting(true)
    assert.deepEqual(committed, ['https://dash.example/'])
  })

  test('スクリプトの移動でページが替わらなければ捨てない（ダウンロード・204）', () => {
    const { visits, committed } = setup(null)
    visits.queue('https://a.example/')
    visits.navigationStarting(false)
    visits.flush()
    assert.deepEqual(committed, ['https://a.example/'])
  })

  test('Pike が移動を起こす前に載せておけば、そのあとの知らせで捨てない（アドレス欄・戻る）', () => {
    const { visits, committed } = setup(null)
    visits.queue('https://a.example/')
    visits.flush()
    // `Navigate` の API も `history.back()` も、WebView2 から見るとユーザーの操作ではない
    visits.navigationStarting(false)
    visits.queue('https://b.example/')
    assert.deepEqual(committed, ['https://a.example/'])
  })

  test('待っているページが無ければ何もしない（最初の読み込み）', () => {
    const { visits, committed } = setup(null)
    visits.navigationStarting(false)
    visits.navigationStarting(true)
    assert.deepEqual(committed, [])
  })

  test('ページの中の移動で離れたら前のページを載せる', () => {
    const { visits, committed } = setup(null)
    visits.queue('https://github.com/a')
    visits.queue('https://github.com/b')
    assert.deepEqual(committed, ['https://github.com/a'])
  })

  test('閉じるときは待っているページを載せる', () => {
    const { visits, committed } = setup(null)
    visits.queue('https://a.example/')
    visits.flush()
    visits.flush()
    assert.deepEqual(committed, ['https://a.example/'])
  })

  test('時間では載せない', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { visits, committed } = setup(null)
      visits.queue('https://a.example/')
      mock.timers.tick(60_000)
      assert.deepEqual(committed, [])
    } finally {
      mock.timers.reset()
    }
  })

  test('復元したタブの URL は回さない（起動のたびに履歴の先頭へ上げない）', () => {
    const { visits, committed } = setup(null, 'https://restored.example/')
    visits.queue('https://restored.example/')
    visits.flush()
    assert.deepEqual(committed, [])
  })
})

describe('時間で近似する（macOS）', () => {
  test('待つ時間が過ぎたら載せる', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { visits, committed } = setup(3000)
      visits.queue('https://a.example/')
      mock.timers.tick(2999)
      assert.deepEqual(committed, [])
      mock.timers.tick(1)
      assert.deepEqual(committed, ['https://a.example/'])
    } finally {
      mock.timers.reset()
    }
  })

  test('待っているあいだに次へ移ったら前のページを捨てる', () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { visits, committed } = setup(3000)
      visits.queue('https://sso.example/redirecting')
      mock.timers.tick(1000)
      visits.queue('https://app.example/')
      mock.timers.tick(3000)
      assert.deepEqual(committed, ['https://app.example/'])
    } finally {
      mock.timers.reset()
    }
  })
})
