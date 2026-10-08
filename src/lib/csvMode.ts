import type { StreamParser } from '@codemirror/language'
import { type Tag, tags } from '@lezer/highlight'

/**
 * CSV / TSV の列ごとの色分け（#461）。VS Code の Rainbow CSV と同じ見せ方で、**列が替わるたびに
 * 色を替える**。幅の揃っていない CSV でも、どの値がどの列かを色で追える。
 *
 * **色はテーマのトークン色を借りる**（Rainbow CSV も同じ作りで、専用のパレットを持たない）。
 * 列の番号を既存のタグへ割り当てるだけなので、6 つのテーマのどれでもそのテーマの配色で出て、
 * テーマを足しても何も書かなくてよい。代償は、テーマによって隣の列が同じ色になりうること
 * （Default Light は `number` と `propertyName` が同じ青）。並びはそれが隣り合わないように
 * 置いてある。
 *
 * **`comment` は使わない。** どのテーマでも灰色で、その列だけ無効に見える。
 */
const COLUMN_TAGS: readonly Tag[] = [
  tags.name,
  tags.keyword,
  tags.labelName,
  tags.string,
  tags.typeName,
  tags.number,
  tags.url,
  tags.propertyName,
]

/** 列の番号 → トークン名（`tokenTable` のキー）。色は `COLUMN_TAGS` を巡回する。 */
const tokenOf = (column: number) => `csvColumn${column % COLUMN_TAGS.length}`

interface CsvState {
  /** 今の列（0 始まり）。 */
  column: number
  /** 引用符の中か。**行をまたいで持ち越す**（RFC 4180 は引用符の中の改行を許す）。 */
  quoted: boolean
  /** フィールドの先頭か。引用符がフィールドを開くのは先頭にあるときだけ。 */
  fieldStart: boolean
}

/**
 * 区切り文字ごとのモード。引用符の扱いはプレビューの `parseCsv`（`lib/csvPreview.ts`）と同じ
 * RFC 4180（`""` は引用符 1 つ、引用符の中の区切り文字と改行はフィールドの一部）。
 *
 * **区切り文字は、その手前の列の色で塗る**（Rainbow CSV と同じ）。次の列の色にすると、空の
 * フィールドが続く行（`a,,,b`）で色の変わり目が読めない。
 */
export function csvMode(delimiter: ',' | '\t'): StreamParser<CsvState> {
  /** 引用符の中を、閉じるか行末まで読む。 */
  function readQuoted(stream: Parameters<StreamParser<CsvState>['token']>[0], state: CsvState) {
    while (!stream.eol()) {
      if (stream.next() !== '"') continue
      // `""` は引用符そのもの。閉じではない。
      if (stream.eat('"')) continue
      state.quoted = false
      return
    }
  }

  return {
    name: delimiter === '\t' ? 'tsv' : 'csv',
    startState: () => ({ column: 0, quoted: false, fieldStart: true }),
    token(stream, state) {
      // 行頭で列を数え直す。引用符の中の改行は同じフィールドの続きなので数え直さない。
      if (stream.sol() && !state.quoted) {
        state.column = 0
        state.fieldStart = true
      }
      if (state.quoted) {
        readQuoted(stream, state)
        return tokenOf(state.column)
      }
      if (stream.eat(delimiter)) {
        const token = tokenOf(state.column)
        state.column++
        state.fieldStart = true
        return token
      }
      if (state.fieldStart && stream.eat('"')) {
        state.quoted = true
        state.fieldStart = false
        readQuoted(stream, state)
        return tokenOf(state.column)
      }
      state.fieldStart = false
      stream.eatWhile((ch) => ch !== delimiter)
      return tokenOf(state.column)
    },
    tokenTable: Object.fromEntries(COLUMN_TAGS.map((tag, i) => [tokenOf(i), tag])),
  }
}
