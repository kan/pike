import { type Highlighter, highlightCode, tagHighlighter } from '@lezer/highlight'
import DOMPurify from 'dompurify'
import type { MarkedExtension, Tokens } from 'marked'
import { type EditorThemeDef, getEditorTheme } from './editorThemes'
import { fenceLanguage } from './languages'
import { asHtml, escapeHtml, type Html } from './text'

/**
 * プレビューのコードブロックに色を付ける（#359）。
 *
 * **使う側は 4 つ**（Markdown プレビュー・rst の `code-block`・issue タブ・マニュアル）で、
 * どれもこのファイルの `highlightCodeBlock` を通る。marked を使う 3 つは `markedCodeHighlight`
 * を、rst は自前の変換からこの関数を直に呼ぶ。
 *
 * **依存は増やさない。** highlight.js / shiki / Prism は入れず、エディタが既に持っている
 * 言語のパーサ（言語名の解決は #344 の `fenceLanguage`）と `@lezer/highlight` の
 * `highlightCode` で組む。エディタと同じ解析なので、Split 表示で左右の色分けが食い違わない。
 *
 * **配色はエディタのテーマに合わせる**（`EditorThemeDef.highlightStyle`）。コードブロックの
 * 背景と文字色もテーマから取る: アプリがライトでエディタが One Dark のような組み合わせだと、
 * トークンの色がプレビューの地の色に対して読めなくなるため。
 */

/** テーマごとの塗り分け。`highlightCode` が返す class 名 → インラインの宣言。 */
interface ThemePaint {
  highlighter: Highlighter
  declarations: Map<string, string>
  /** `<pre>` に当てる背景と文字色。 */
  preStyle: string
}

const paints = new Map<string, ThemePaint>()

/** `fontWeight` → `font-weight`。 */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/**
 * テーマの配色を、インラインの `style` に書ける形へ落とす。**テーマ 1 つにつき 1 回だけ**。
 *
 * **class を CSS へ差し込む形にしない。** プレビューの `pre` / `code` の既定の見た目は
 * scoped CSS（`.md-preview :deep(pre)`）で、詳細度が高いうえ、差し込んだ `<style>` が勝つかは
 * 読み込み順に依存する（開発ビルドと本番で順序が違う）。インラインなら競合が起きない。
 * `style` 属性は DOMPurify の既定で通り、CSP も `style-src` の `'unsafe-inline'` を残してある
 * （`.claude/rules/build.md`）。
 *
 * class 名は spec の添字で振る（`tagHighlighter` が同じ tag の継承規則で当ててくれる）。
 * 入れ子のセレクタのような、インラインで書けない値は捨てる（Pike のテーマは使っていない）。
 */
function paintFor(theme: EditorThemeDef): ThemePaint {
  const cached = paints.get(theme.name)
  if (cached) return cached
  const declarations = new Map<string, string>()
  const rules: { tag: (typeof theme.highlightStyle.specs)[number]['tag']; class: string }[] = []
  theme.highlightStyle.specs.forEach((spec, i) => {
    const decl = Object.entries(spec)
      .filter(
        ([key, value]) => key !== 'tag' && key !== 'class' && (typeof value === 'string' || typeof value === 'number'),
      )
      .map(([key, value]) => `${kebab(key)}:${value}`)
      .join(';')
    if (!decl) return
    const cls = `h${i}`
    declarations.set(cls, decl)
    rules.push({ tag: spec.tag, class: cls })
  })
  const paint = {
    highlighter: tagHighlighter(rules),
    declarations,
    preStyle: `background:${theme.background};color:${theme.foreground}`,
  }
  paints.set(theme.name, paint)
  return paint
}

/**
 * 組んだ HTML のキャッシュ。**プレビューは打鍵のたびに作り直される**ので、触っていない
 * コードブロックまで毎回パースし直さないために持つ。キーはテーマ・言語・本文の 3 つ。
 * 増えすぎたら丸ごと捨てる（編集中のブロックは打鍵ごとに別のキーになり、古いものが溜まる）。
 *
 * **長いブロックは載せない**（`HTML_CACHE_MAX_CODE`）。上限は件数なので、数百 KB の
 * ```` ```json ```` の中を編集し続けると、捨てるまで「本文 ＋ その数倍の HTML」が 300 件ぶん
 * 溜まる。長いものは毎回パースし直すほうを採る。
 */
const htmlCache = new Map<string, Html>()
const HTML_CACHE_MAX = 300
const HTML_CACHE_MAX_CODE = 20_000

/**
 * フェンスの info 文字列から言語名を取り出す。**先頭の語だけ**（`ts title="x"` の属性は
 * 見ない）。エディタ側（lang-markdown の `getCodeParser`）と同じ切り方。
 */
function langOf(info: string | undefined): string {
  return /^\S*/.exec(info ?? '')?.[0] ?? ''
}

/**
 * コードブロック 1 つを色付きの `<pre>` にする。**色を付けられなければ `null`**（言語が
 * 書かれていない・当てるモードが無い）で、そのときは呼び出し側の既定の描画に任せる。
 *
 * `mermaid` もここで `null` になる（当てるモードが無い）ので、Markdown プレビューの図への
 * 差し替え（`code.language-mermaid` を探す）はそのまま効く。
 */
export function highlightCodeBlock(code: string, info: string | undefined, themeName: string): Html | null {
  const lang = langOf(info)
  if (!lang) return null
  const key = `${themeName}\0${lang}\0${code}`
  const cached = htmlCache.get(key)
  if (cached) return cached

  const language = fenceLanguage(lang)
  if (!language) return null
  const paint = paintFor(getEditorTheme(themeName))
  const out: string[] = []
  highlightCode(
    code,
    language.parser.parse(code),
    paint.highlighter,
    (text, classes) => {
      const style = classes
        .split(' ')
        .map((c) => paint.declarations.get(c))
        .filter(Boolean)
        .join(';')
      out.push(style ? `<span style="${style}">${escapeHtml(text)}</span>` : escapeHtml(text))
    },
    () => out.push('\n'),
  )
  const html = asHtml(
    `<pre style="${paint.preStyle}"><code class="language-${escapeHtml(lang)}">${out.join('')}</code></pre>`,
  )
  if (code.length <= HTML_CACHE_MAX_CODE) {
    if (htmlCache.size >= HTML_CACHE_MAX) htmlCache.clear()
    htmlCache.set(key, html)
  }
  return html
}

/**
 * 描き終わった DOM の中のコードブロックだけを、別のテーマで塗り直す。
 *
 * **マニュアルタブのため**（あそこは `html` を computed ではなく代入で持つ）。ページを丸ごと
 * 描き直すと、`<picture>` から作り直した画像が読み込み終わるまで高さ 0 になり、読んでいた
 * 位置が上へずれる。コードブロックだけ差し替えれば、画像にもスクロール位置にも触れない。
 *
 * 本文は `textContent` から取る（色付きの `<span>` を外せば元のコードに戻る）。色を
 * 付けられなかったブロックは `language-` の class を持っていても触らない。
 */
export function rehighlightCodeBlocks(root: ParentNode, themeName: string): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    const lang = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1]
    const pre = code.parentElement
    const html = highlightCodeBlock(code.textContent ?? '', lang, themeName)
    // 組んだ HTML は本文も言語名もエスケープ済みで、`style` の値はテーマの定数だけだが、
    // DOM へ入れる前に DOMPurify を通す、という他のプレビューの規約に揃える。
    if (html && pre) pre.outerHTML = DOMPurify.sanitize(html)
  }
}

/**
 * marked の拡張（Markdown プレビュー・issue タブ・マニュアルが共有する）。
 *
 * **テーマ名は関数で受ける。** marked のインスタンスはモジュールの先頭で 1 度だけ作るので、
 * 値で渡すと作った時点のテーマに固まる。描画のたびに読めば、呼び出し側の computed が
 * テーマ名に依存し、テーマを変えたときに組み直される。
 *
 * 色を付けられないブロックは `false` を返して marked の既定の描画に任せる。
 */
export function markedCodeHighlight(themeName: () => string): MarkedExtension {
  return {
    renderer: {
      code(token: Tokens.Code) {
        return highlightCodeBlock(token.text, token.lang, themeName()) ?? false
      },
    },
  }
}
