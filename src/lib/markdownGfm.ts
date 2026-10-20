/**
 * プレビューの marked を組む（#482）。**Markdown プレビュー・issue タブ・マニュアルの 3 つが
 * 共有する。** どれも GitHub の拡張書式（alert・数式・絵文字・カラーコード）を同じように描く。
 *
 * **インスタンスは本文が要る block 拡張の組み合わせごとに作る。** block 拡張を 1 つでも登録すると
 * marked は `startBlock` の経路に入り、段落ごとに残り全文をコピーする（文書サイズに対して二次
 * オーダー。連結したマニュアルで 49KB なら +13%、390KB なら +136%）。プレビューは打鍵のたびに
 * 作り直されるので、脚注（`[^`）や行頭の `$$` を使わない文書にこれを払わせない。block 拡張でない
 * もの（alert は組み込みの tokenizer の差し替え、ほかは inline 拡張と renderer）は常に入れる。
 *
 * - 脚注（`lib/markdownFootnotes.ts`）は使う面だけが `footnotes` で頼む。issue タブは本文と
 *   コメントを別々に描くので番号と id が重なり、`#fn-1` へのリンクも行き先が無い
 * - `#123` の issue 参照（`lib/issueRefs.ts`）は呼ぶたびに渡す。エディタのプレビューは
 *   プロジェクトが GitHub のときだけ有効にするので、答えが途中で変わる
 * - 色付け（`markedCodeHighlight`）は数式より前に `use` する（```` ```math ```` を数式の側が先に取る）
 *
 * **絵文字の対応表は読み込みを始めるだけで待たない**（`loadEmojiFor`）。computed の中で呼べば、
 * 読み終えたときに組み直される。数式は描いたあとで `renderMath` を DOM に当てる。
 */

import { Marked, type MarkedExtension } from 'marked'
import { markedCodeHighlight } from './codeHighlight'
import { issueRefs } from './issueRefs'
import { alerts } from './markdownAlerts'
import { colorSwatches } from './markdownColors'
import { emoji, loadEmojiFor } from './markdownEmoji'
import { footnotes } from './markdownFootnotes'
import { hasMathBlock, math, mathBlock } from './markdownMath'

export interface PreviewParserOptions {
  /** 色付けのテーマ名。描画のたびに読む（テーマを変えると呼び出し側の computed が組み直される）。 */
  theme: () => string
  /** 脚注を描くか。 */
  footnotes?: boolean
}

/** 本文 → それを描く marked。 */
export type PreviewParser = (text: string, opts?: { issueRefs?: boolean }) => Marked

export function previewParser(options: PreviewParserOptions): PreviewParser {
  const parsers = new Map<string, Marked>()
  return (text, opts = {}) => {
    void loadEmojiFor(text)
    const withFootnotes = !!options.footnotes && text.includes('[^')
    const withMathBlock = hasMathBlock(text)
    const withRefs = !!opts.issueRefs
    const key = `${+withFootnotes}${+withMathBlock}${+withRefs}`
    let parser = parsers.get(key)
    if (!parser) {
      const extensions: MarkedExtension[] = []
      if (withFootnotes) extensions.push(footnotes())
      if (withMathBlock) extensions.push(mathBlock())
      if (withRefs) extensions.push(issueRefs())
      extensions.push(markedCodeHighlight(options.theme), alerts(), math(), emoji(), colorSwatches())
      parser = new Marked(...extensions)
      parsers.set(key, parser)
    }
    return parser
  }
}
