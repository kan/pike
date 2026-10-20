/**
 * GitHub の alert 記法（`> [!NOTE]` など、#482）をプレビューで描く marked 拡張。
 *
 * ```markdown
 * > [!WARNING]
 * > この操作は元に戻せません。
 * ```
 *
 * **block 拡張にしない。** 組み込みの `blockquote` の tokenizer を差し替える形にしてある。
 * block 拡張を 1 つでも登録すると marked は `startBlock` の経路に入り、段落ごとに残り全文を
 * コピーする（`EditorTab.vue` の `parserFor` の doc）。差し替えならその経路に入らないので、
 * 全部のプレビューに常に入れておける。
 *
 * GitHub と揃えたこと:
 * - 種類は 5 つだけ。**未知の種類（`[!FOO]`）は普通の引用のまま**
 * - 種類名は大文字小文字を区別しない（`[!note]` も通る）
 * - 印は 1 行目に単独で書く。**同じ行に続きを書いたもの（`[!NOTE] 本文`）と、本文が空のものは
 *   普通の引用のまま**
 *
 * 既存の拡張 `marked-alert` は種類名の大文字小文字を区別する（`[!note]` が通らない）ので
 * 採っていない。
 */

import { type MarkedExtension, Tokenizer, type Tokens } from 'marked'

/**
 * 種類ごとのアイコン（lucide の info / lightbulb / message-square-warning / triangle-alert /
 * octagon-alert）。**種類の一覧の正本はこの表**で、印の正規表現と見出しはここから作る。
 */
const ICON_PATHS = {
  note: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  tip: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  important:
    '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M12 15h.01"/><path d="M12 7v4"/>',
  warning:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  caution:
    '<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z"/>',
} as const
type AlertKind = keyof typeof ICON_PATHS

/** 引用の本文（`>` を外したもの）の 1 行目に置かれた印。 */
const MARKER_RE = new RegExp(String.raw`^\[!(${Object.keys(ICON_PATHS).join('|')})\][ \t]*(?:\n|$)`, 'i')

/** 見出しの文言（`Note` など）。GitHub と同じく英語で出す（記法の名前でもあるので訳さない）。 */
function title(kind: AlertKind): string {
  return kind[0].toUpperCase() + kind.slice(1)
}

/**
 * アイコンは SVG の文字列で埋める（`lib/editorSearch.ts` と同じ形）。本文は `v-html` で描くので、
 * lucide のコンポーネントは置けない。DOMPurify は `svg` / `path` / `circle` を既定で通す。
 */
function icon(kind: AlertKind): string {
  return `<svg class="markdown-alert-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[kind]}</svg>`
}

interface AlertBlockquote extends Tokens.Blockquote {
  alert?: AlertKind
}

export function alerts(): MarkedExtension {
  return {
    tokenizer: {
      blockquote(src: string) {
        // 組み込みの tokenizer で引用の範囲（遅延継続行を含む）を決めてもらい、1 行目が印なら
        // 本文を読み直す。範囲の判定を自前で書くと、CommonMark の遅延継続の規則を写すことになる。
        const token = Tokenizer.prototype.blockquote.call(this, src) as AlertBlockquote | undefined
        if (!token) return token
        const m = MARKER_RE.exec(token.text)
        if (!m) return token
        const body = token.text.slice(m[0].length)
        if (!body.trim()) return token
        token.alert = m[1].toLowerCase() as AlertKind
        // 印を含んだまま読んだぶんは捨てる（その段落の inline の処理は marked の待ち行列に
        // 残るが、どこからも描かれないので結果に出ない）。
        // 組み込みの blockquote と同じく、中身は最上位として読む（`state.top`）。リストの中の
        // alert で、外側の値のまま読むと段落が `<p>` の無い素の文字になる。
        const top = this.lexer.state.top
        this.lexer.state.top = true
        token.tokens = this.lexer.blockTokens(body, [])
        this.lexer.state.top = top
        return token
      },
    },
    renderer: {
      blockquote(token: Tokens.Blockquote) {
        const kind = (token as AlertBlockquote).alert
        if (!kind) return false
        const heading = `<p class="markdown-alert-title">${icon(kind)}${title(kind)}</p>`
        return `<div class="markdown-alert markdown-alert-${kind}">${heading}\n${this.parser.parse(token.tokens)}</div>\n`
      },
    },
  }
}
