import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EARLY_EXPIRY_DAYS, EXPIRY_WARN_DAYS, loginExpiry } from '../src/lib/loginExpiry'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-17T00:00:00.000Z')
const at = (days: number) => new Date(NOW + days * DAY).toISOString()

test('幅は期限の 3 日前から期限まで、残り日数は切り上げ', () => {
  // 手元の実例：11/21 23:45 に切れる → 最も早い日は 11/18 23:45。
  const e = loginExpiry('2026-11-21T23:45:11.205Z', NOW)
  assert.ok(e)
  assert.equal(e.expiresAt.getTime() - e.earliest.getTime(), EARLY_EXPIRY_DAYS * DAY)
  assert.equal(e.daysToEarliest, 2)
  assert.equal(e.daysToExpiry, 5)
  assert.equal(e.soon, true)
  assert.equal(e.expired, false)
})

test('最も早い日までの残りが 7 日以内なら警告、超えれば出さない', () => {
  const edge = EARLY_EXPIRY_DAYS + EXPIRY_WARN_DAYS
  assert.equal(loginExpiry(at(edge), NOW)?.soon, true)
  assert.equal(loginExpiry(at(edge + 0.01), NOW)?.soon, false)
  assert.equal(loginExpiry(at(30), NOW)?.soon, false)
})

test('最も早い日を過ぎていれば残りは 0 で、警告のまま', () => {
  const e = loginExpiry(at(1), NOW)
  assert.ok(e)
  assert.equal(e.daysToEarliest, 0)
  assert.equal(e.daysToExpiry, 1)
  assert.equal(e.soon, true)
})

test('期限を過ぎたら消さずに期限切れとして返す', () => {
  for (const e of [loginExpiry(at(0), NOW), loginExpiry(at(-1), NOW)]) {
    assert.ok(e)
    assert.equal(e.expired, true)
    assert.equal(e.soon, true)
    assert.equal(e.daysToEarliest, 0)
    assert.equal(e.daysToExpiry, 0)
  }
})

test('期限を持たない・読めない値は null', () => {
  assert.equal(loginExpiry(null, NOW), null)
  assert.equal(loginExpiry(undefined, NOW), null)
  assert.equal(loginExpiry('', NOW), null)
  assert.equal(loginExpiry('not a date', NOW), null)
})
