// ファイルタイプの一覧（StatusBar のドロップダウン）と CSV の列の色分け（#461）。
// `just test-ts` で走る。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StringStream } from '@codemirror/language'
import { csvMode } from '../src/lib/csvMode.ts'
import { fileTypeKey, fileTypeLabelOf } from '../src/lib/fileType.ts'
import { languageByKey, languageOptions } from '../src/lib/languages.ts'

test('CSV・TSV・Mermaid は一覧に出る', () => {
  const byLabel = new Map(languageOptions().map((o) => [o.label, o.key]))
  // CSV と TSV は区切り文字が違うので別の項目。Mermaid は 1 つに畳む。
  assert.equal(byLabel.get('CSV'), 'csv')
  assert.equal(byLabel.get('TSV'), 'tsv')
  assert.equal(byLabel.get('Mermaid'), 'mermaid')
  // CSV / TSV は列の色分けのモードを持つ。Mermaid はモードを持たないまま一覧に出している。
  assert.ok(languageByKey('csv'))
  assert.ok(languageByKey('tsv'))
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

/** 各行を `文字列@列番号` の並びにする（列番号はトークン名の末尾）。 */
function columns(delimiter: ',' | '\t', lines: string[]): string[][] {
  const mode = csvMode(delimiter)
  const state = mode.startState?.(2)
  assert.ok(state)
  return lines.map((line) => {
    const out: string[] = []
    const stream = new StringStream(line, 2, 2)
    while (!stream.eol()) {
      stream.start = stream.pos
      const token = mode.token(stream, state)
      out.push(`${stream.current()}@${token?.replace('csvColumn', '')}`)
    }
    return out
  })
}

test('列ごとにトークンが替わり、区切り文字は手前の列に付く', () => {
  assert.deepEqual(columns(',', ['a,bb,,d']), [['a@0', ',@0', 'bb@1', ',@1', ',@2', 'd@3']])
  // TSV はタブで区切り、カンマは値の一部。
  assert.deepEqual(columns('\t', ['a,b\tc']), [['a,b@0', '\t@0', 'c@1']])
})

test('引用符の中の区切り文字と改行は同じ列のまま', () => {
  assert.deepEqual(columns(',', ['x,"a,""b""', 'c",z', 'p,q']), [
    ['x@0', ',@0', '"a,""b""@1'],
    // 引用符が閉じていないので、次の行も 2 列目の続き。
    ['c"@1', ',@1', 'z@2'],
    // 閉じたあとの行は列を数え直す。
    ['p@0', ',@0', 'q@1'],
  ])
  // フィールドの途中の引用符は開かない。
  assert.deepEqual(columns(',', ['a"b,c']), [['a"b@0', ',@0', 'c@1']])
})

test('列の色は 8 色を巡回する', () => {
  const [row] = columns(',', ['0,1,2,3,4,5,6,7,8'])
  assert.equal(row.at(-1), '8@0')
})
