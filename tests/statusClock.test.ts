// ステータスバーの日付と時刻の表記。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  formatStatusClock,
  formatStatusDate,
  formatStatusTime,
  sanitizeStatusDateFormat,
  sanitizeStatusTimeFormat,
} from '../src/lib/statusClock.ts'

// 2026-01-05 は月曜。月と日が 1 桁の日で、桁を埋める表記と埋めない表記を見分ける。
const at = (h: number, min: number) => new Date(2026, 0, 5, h, min)

describe('formatStatusDate', () => {
  test('表記ごとの並びと桁', () => {
    const d = at(9, 5)
    assert.equal(formatStatusDate('off', d, 'ja'), '')
    assert.equal(formatStatusDate('iso', d, 'ja'), '2026-01-05')
    assert.equal(formatStatusDate('ymd', d, 'ja'), '2026/01/05')
    assert.equal(formatStatusDate('md', d, 'ja'), '1/5')
    assert.equal(formatStatusDate('mdy', d, 'ja'), '01/05/2026')
    assert.equal(formatStatusDate('dmy', d, 'ja'), '05/01/2026')
  })

  test('曜日の名前だけが言語に従う', () => {
    const d = at(9, 5)
    assert.equal(formatStatusDate('mdWeekday', d, 'ja'), '1/5 (月)')
    assert.equal(formatStatusDate('mdWeekday', d, 'en'), '1/5 (Mon)')
    assert.equal(formatStatusDate('ymdWeekday', d, 'ja'), '2026/01/05 (月)')
  })

  test('崩れた言語のタグで落ちない', () => {
    assert.match(formatStatusDate('mdWeekday', at(9, 5), 'ja_JP'), /^1\/5 \(.+\)$/)
  })
})

describe('formatStatusTime', () => {
  test('24 時間は時を 2 桁にする', () => {
    assert.equal(formatStatusTime('h24', at(9, 5)), '09:05')
    assert.equal(formatStatusTime('h24', at(0, 0)), '00:00')
    assert.equal(formatStatusTime('h24', at(23, 59)), '23:59')
  })

  test('AM/PM は 0 時と 12 時を 12 と書く', () => {
    assert.equal(formatStatusTime('h12', at(0, 0)), '12:00 AM')
    assert.equal(formatStatusTime('h12', at(9, 5)), '9:05 AM')
    assert.equal(formatStatusTime('h12', at(12, 0)), '12:00 PM')
    assert.equal(formatStatusTime('h12', at(23, 59)), '11:59 PM')
  })

  test('off は空', () => {
    assert.equal(formatStatusTime('off', at(9, 5)), '')
  })
})

describe('formatStatusClock', () => {
  test('片方だけのときに余分な空白を残さない', () => {
    const d = at(14, 32)
    assert.equal(formatStatusClock('md', 'h24', d, 'ja'), '1/5 14:32')
    assert.equal(formatStatusClock('off', 'h24', d, 'ja'), '14:32')
    assert.equal(formatStatusClock('md', 'off', d, 'ja'), '1/5')
    assert.equal(formatStatusClock('off', 'off', d, 'ja'), '')
  })
})

describe('sanitize', () => {
  test('知らない値は off に落とす', () => {
    assert.equal(sanitizeStatusDateFormat('ymd'), 'ymd')
    assert.equal(sanitizeStatusDateFormat(true), 'off')
    assert.equal(sanitizeStatusDateFormat(undefined), 'off')
    assert.equal(sanitizeStatusTimeFormat('h12'), 'h12')
    assert.equal(sanitizeStatusTimeFormat('24h'), 'off')
  })
})
