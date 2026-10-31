// issue パネルで隠すラベル（#531）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { hasHiddenLabel, hiddenLabelSet, sanitizeLabelList } from '../src/lib/issueLabels.ts'

describe('sanitizeLabelList', () => {
  test('配列でなければ空', () => {
    assert.deepEqual(sanitizeLabelList(null), [])
    assert.deepEqual(sanitizeLabelList('on-hold'), [])
  })

  test('文字列でないもの・空のものを落とし、前後の空白を除く', () => {
    assert.deepEqual(sanitizeLabelList([' on-hold ', 1, '', '  ', 'wontfix']), ['on-hold', 'wontfix'])
  })

  test('大小を無視して重複を落とし、最初の綴りを残す', () => {
    assert.deepEqual(sanitizeLabelList(['On-Hold', 'on-hold', 'ON-HOLD']), ['On-Hold'])
  })

  test('ラベル名の中の空白とカンマは残す（区切り文字として扱わない）', () => {
    const labels = ['good first issue', 'blocked, waiting']
    assert.deepEqual(sanitizeLabelList(labels), labels)
  })
})

describe('hasHiddenLabel', () => {
  const hidden = hiddenLabelSet(['On-Hold'])

  test('隠すラベルが 1 つでも付いていれば真（大小は無視）', () => {
    assert.equal(hasHiddenLabel([{ name: 'bug' }, { name: 'on-hold' }], hidden), true)
  })

  test('付いていなければ偽', () => {
    assert.equal(hasHiddenLabel([{ name: 'bug' }], hidden), false)
    assert.equal(hasHiddenLabel([], hidden), false)
  })

  test('隠すラベルが空なら常に偽', () => {
    assert.equal(hasHiddenLabel([{ name: 'on-hold' }], hiddenLabelSet([])), false)
  })
})
