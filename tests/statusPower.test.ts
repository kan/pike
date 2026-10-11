// ステータスバーの電源の表示（#467）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { powerView } from '../src/lib/statusPower.ts'

describe('powerView', () => {
  test('電源につないで 100% なら、プラグだけで数字は出さない（バッテリー無しと区別できない）', () => {
    assert.deepEqual(powerView({ charging: true, level: 1 }), {
      plugged: true,
      percent: 100,
      showPercent: false,
      icon: 'plug',
      tone: 'normal',
    })
  })

  test('つないで 100% 未満なら残量を出す（充電の上限で止まっている機械を含む）', () => {
    const v = powerView({ charging: true, level: 0.8 })
    assert.equal(v?.icon, 'plug')
    assert.equal(v?.showPercent, true)
    assert.equal(v?.percent, 80)
  })

  test('つないでいるあいだは、残量が少なくても警告しない', () => {
    assert.equal(powerView({ charging: true, level: 0.05 })?.tone, 'normal')
  })

  test('数字を出すかの境目は丸めた後の 100%', () => {
    assert.equal(powerView({ charging: true, level: 0.995 })?.showPercent, false)
    assert.equal(powerView({ charging: true, level: 0.994 })?.showPercent, true)
    assert.equal(powerView({ charging: true, level: 0.994 })?.percent, 99)
  })

  test('バッテリーのときは残量で色が変わる', () => {
    const tone = (level: number) => powerView({ charging: false, level })?.tone
    assert.equal(tone(0.62), 'normal')
    assert.equal(tone(0.21), 'normal')
    assert.equal(tone(0.2), 'warn')
    assert.equal(tone(0.11), 'warn')
    assert.equal(tone(0.1), 'danger')
  })

  test('満充電でも、つないでいなければ電池のアイコンと数字', () => {
    const v = powerView({ charging: false, level: 1 })
    assert.equal(v?.plugged, false)
    assert.equal(v?.icon, 'full')
    assert.equal(v?.showPercent, true)
  })

  test('残量の帯の境目', () => {
    const icon = (level: number) => powerView({ charging: false, level })?.icon
    assert.equal(icon(0.7), 'full')
    assert.equal(icon(0.69), 'medium')
    assert.equal(icon(0.35), 'medium')
    assert.equal(icon(0.34), 'low')
    assert.equal(icon(0.11), 'low')
    assert.equal(icon(0.1), 'empty')
  })

  test('範囲外の残量は丸め、数でなければ何も出さない', () => {
    assert.equal(powerView({ charging: false, level: 1.5 })?.percent, 100)
    assert.equal(powerView({ charging: false, level: -1 })?.percent, 0)
    assert.equal(powerView({ charging: false, level: Number.NaN }), null)
  })
})
