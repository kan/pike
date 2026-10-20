/**
 * 絵文字のショートコード（`:tada:` → 🎉、#482）をプレビューで置き換える marked 拡張。
 *
 * **対応表は `markdown-it-emoji` のデータだけを使う**（`lib/data/full.mjs`。名前 → 絵文字の
 * 平らな表で約 50KB）。中身は GitHub の gemoji と同じ名前の集合で、gemoji の npm 版（約 350KB。
 * 説明文とタグを持つ）より小さい。markdown-it のプラグイン本体は読まない。GitHub 独自の
 * カスタム絵文字（`:octocat:` など）は画像なので対象外。
 *
 * **表は使うときだけ読み込む**（`loadEmojiFor`）。表は `shallowRef` に持つので、読み込みを
 * 始めた computed（プレビューの HTML）は読み終えたときに組み直される。それまではショートコードが
 * 文字のまま見える。
 *
 * コードスパンとコードブロックの中は marked が先に取るので、この inline 拡張は入らない。
 * リンクの中では置き換える（GitHub と同じ）。
 */

import type { MarkedExtension, Tokens } from 'marked'
import { shallowRef } from 'vue'

/** ショートコード。表の名前は英小文字・数字・`_` `+` `-` だけでできている。 */
const SHORTCODE_RE = /^:([a-z0-9_+-]+):/
const HINT_RE = /:[a-z0-9_+-]+:/

/** 対応表。読み終えるまで null。 */
const table = shallowRef<Record<string, string> | null>(null)
let loading: Promise<void> | null = null

function load(): Promise<void> {
  loading ??= import('markdown-it-emoji/lib/data/full.mjs')
    .then((mod) => {
      table.value = mod.default
    })
    .catch(() => {
      loading = null // 次に要ったときに読み直す
    })
  return loading
}

/**
 * 本文にショートコードらしいものがあれば表を読み込む。
 *
 * **`table` は最初の `await` より前に読むので、computed の中で（待たずに）呼べば、読み終えたときに
 * その computed が組み直される。** 代入で HTML を組むマニュアルは待ってから描く。
 */
export async function loadEmojiFor(text: string): Promise<void> {
  if (!table.value && HINT_RE.test(text)) await load()
}

interface EmojiToken extends Tokens.Generic {
  emoji: string
}

export function emoji(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'emoji',
        level: 'inline',
        start(src: string) {
          if (!table.value) return undefined
          return HINT_RE.exec(src)?.index
        },
        tokenizer(src: string) {
          const m = SHORTCODE_RE.exec(src)
          // 表に無い名前（`12:30:00` の `:30:` など）は文字のまま。
          const found = m ? table.value?.[m[1]] : undefined
          if (!m || !found) return undefined
          return { type: 'emoji', raw: m[0], emoji: found } as EmojiToken
        },
        renderer(token: Tokens.Generic) {
          return (token as EmojiToken).emoji
        },
      },
    ],
  }
}
