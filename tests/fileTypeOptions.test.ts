// ファイルタイプの一覧（StatusBar のドロップダウン、#461）。`just test-ts` で走る。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileTypeKey, fileTypeLabelOf } from '../src/lib/fileType.ts'
import { languageByKey, languageOptions } from '../src/lib/languages.ts'

test('色付けのモードが無くても、プレビューのある種別は一覧に出る', () => {
  const byLabel = new Map(languageOptions().map((o) => [o.label, o.key]))
  // CSV と TSV は区切り文字が違うので別の項目。Mermaid は 1 つに畳む。
  assert.equal(byLabel.get('CSV'), 'csv')
  assert.equal(byLabel.get('TSV'), 'tsv')
  assert.equal(byLabel.get('Mermaid'), 'mermaid')
  // 色は付かない（モードを持たないまま一覧に出している）。
  assert.equal(languageByKey('csv'), null)
  assert.equal(languageByKey('mermaid'), null)
})

test('一覧はラベルで畳まれ、Plain Text は出ない', () => {
  const labels = languageOptions().map((o) => o.label)
  assert.equal(new Set(labels).size, labels.length)
  assert.ok(!labels.includes('Plain Text'))
})

test('CSV と Mermaid のファイルは種別を名乗る', () => {
  assert.equal(fileTypeKey('data.tsv'), 'tsv')
  assert.equal(fileTypeLabelOf('flow.mmd'), 'Mermaid')
})
