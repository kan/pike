/**
 * Markdown の数式（#482）。GitHub と同じ 4 つの書き方を受け付ける。
 *
 * - インライン `$x^2$` と、GitHub の `` $`x^2`$ ``（ドル記号とバッククォートの組み合わせ）
 * - ブロック `$$ ... $$`（行頭から書いたもの）と、コードブロック ```` ```math ````
 *
 * **描画は 2 段に分ける。** marked の段階では数式のソースを印（`.math`）の付いた要素に包んで
 * 出すだけで、KaTeX は DOM に入れたあとで `renderMath` が当てる。理由は 2 つある。
 *
 * - **KaTeX は数式を含む文書を開いたときだけ読み込む**（本体約 260KB とフォント）。プレビューは
 *   同期の computed で組むので、marked の描画の中では読み込みを待てない。mermaid と同じ扱い。
 *   版を固定している理由は `.claude/rules/preview.md` の数式の節
 * - **KaTeX の出力を DOMPurify に通さずに済む。** 出力は MathML と、寸法を持つインラインの
 *   `style` を大量に含み、プレビューの許可設定で通すと崩れる。KaTeX は `trust: false`（既定）で
 *   `\href` や `\htmlClass` のような外へ出る命令を描かないので、出力をそのまま入れてよい
 *
 * 読み込む前と、構文エラーのときはソースがそのまま見えている（本文を消さない）。
 *
 * **ブロック `$$` は block 拡張なので別に分けてある**（`mathBlock`）。登録するだけで marked が
 * 二次の経路に入るので、本文に `$$` が行頭にある文書にだけ使う（`hasMathBlock`）。インラインと
 * ```` ```math ```` は常に入れておける。
 *
 * 既存の拡張 `marked-katex-extension` は KaTeX を静的に import して描画の中で呼ぶので、遅延
 * 読み込みにできず、`` $`…`$ `` と ```` ```math ```` も扱わない。そのため自前で持つ。
 */

import type { MarkedExtension, Tokens } from 'marked'
import { escapeHtml } from './text'

/**
 * `$…$`。GitHub（と pandoc）の規則で、**開きの直後と閉じの直前が空白なら数式にしない**。
 * 閉じの直後が数字のときと、開きの直前が英数字のとき（`US$5`）も外す。`$5 と $10` のような
 * 金額を拾わないための線引き。
 */
const DOLLAR_RE = /^\$(?![\s$])((?:\\[\s\S]|[^\\$])+?)\$(?!\d)/
/** `$`…`$`。中身はバッククォートの数で閉じる（コードスパンと同じ）。 */
const BACKTICK_RE = /^\$(`+)(?!`)([\s\S]*?[^`])\1\$/
/** 段落の中の `$$…$$`。表示形式（display）で描く。 */
const DISPLAY_RE = /^\$\$(?!\$)((?:\\[\s\S]|[^\\$])+?)\$\$/
/**
 * 行頭からの `$$`。閉じの `$$` のあとは行末まで空白だけ。**中身は空行と `$$` をまたがない。**
 * またぐと、閉じていない `$$`（`$$x$$ の説明` や、シェルの `$$`）から次のブロックの閉じまでの
 * 段落とコードブロックが 1 つの数式に飲まれる。
 */
const BLOCK_RE = /^ {0,3}\$\$((?:(?!\$\$|\n[ \t]*\n)[\s\S])+?)\$\$[ \t]*(?:\n+|$)/

interface MathToken extends Tokens.Generic {
  text: string
  display: boolean
}

/** KaTeX を当てる前の印。中身は数式のソースそのもの（読み込む前と構文エラーのときに見える）。 */
function placeholder(source: string, display: boolean, block: boolean): string {
  const tag = block ? 'div' : 'span'
  const cls = display ? 'math math-display' : 'math math-inline'
  return `<${tag} class="${cls}">${escapeHtml(source)}</${tag}>`
}

/** 行頭に `$$` があるか（block 拡張の要る本文か）。 */
export function hasMathBlock(text: string): boolean {
  return /(?:^|\n) {0,3}\$\$/.test(text)
}

/** インラインの数式と ```` ```math ````。 */
export function math(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'mathInline',
        level: 'inline',
        // **`\$` は手前のバックスラッシュの位置を返す。** `$` の位置で文字の連なりを切ると、
        // `\` が前の文字に残ってエスケープとして読まれず、`a \$x$` が数式になる。手前で切れば
        // marked の escape が `\$` をまとめて取る。
        start(src: string) {
          return /\\?\$/.exec(src)?.index
        },
        tokenizer(src: string, tokens?: Tokens.Generic[]) {
          // inline の拡張は位置ごとに呼ばれるので、`$` で始まらなければ先に抜ける。
          if (src[0] !== '$') return undefined
          // 英数字の直後の `$`（`US$5`）は開きにしない。日本語の直後（`値$x$を`）は数式として
          // 読む。tokenizer は現在位置から先しか受け取らないので、直前の文字は 1 つ前のトークンの
          // 末尾から見る（`lib/issueRefs.ts` と同じ）。前のトークンは段落の中で伸び続けるので、
          // 正規表現を全体に当てず末尾の 1 文字だけを見る。
          const prev = tokens?.[tokens.length - 1]
          if (typeof prev?.raw === 'string' && /[A-Za-z0-9]/.test(prev.raw.slice(-1))) return undefined
          const display = DISPLAY_RE.exec(src)
          if (display) {
            return { type: 'mathInline', raw: display[0], text: display[1].trim(), display: true } as MathToken
          }
          const backtick = BACKTICK_RE.exec(src)
          if (backtick) {
            return { type: 'mathInline', raw: backtick[0], text: backtick[2].trim(), display: false } as MathToken
          }
          const dollar = DOLLAR_RE.exec(src)
          // 閉じの直前の空白は正規表現で書くと遅くなるので、取れたあとで見る。
          if (dollar && !/\s$/.test(dollar[1])) {
            return { type: 'mathInline', raw: dollar[0], text: dollar[1], display: false } as MathToken
          }
          return undefined
        },
        renderer(token: Tokens.Generic) {
          const t = token as MathToken
          return placeholder(t.text, t.display, false)
        },
      },
    ],
    renderer: {
      // 色付け（`markedCodeHighlight`）より後に `use` すること。後から入れた renderer が先に
      // 呼ばれ、`false` を返すと前のものへ回る。
      code(token: Tokens.Code) {
        if (token.lang?.trim().toLowerCase() !== 'math') return false
        return `${placeholder(token.text.trim(), true, true)}\n`
      },
    },
  }
}

/** 行頭からの `$$ … $$`。本文に要るときだけ使う（`hasMathBlock`）。 */
export function mathBlock(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'mathBlock',
        level: 'block',
        // `start` は先頭 1 文字を除いた src を受け取り、marked は `index + 1` で段落を切る。
        // 行の途中を返すと段落が割れるので、改行の直後だけを返す（`markdownFootnotes.ts` と同じ）。
        start(src: string) {
          const m = /\n {0,3}\$\$/.exec(src)
          return m ? m.index + 1 : undefined
        },
        tokenizer(src: string) {
          const m = BLOCK_RE.exec(src)
          if (!m?.[1].trim()) return undefined
          return { type: 'mathBlock', raw: m[0], text: m[1].trim(), display: true } as MathToken
        },
        renderer(token: Tokens.Generic) {
          return `${placeholder((token as MathToken).text, true, true)}\n`
        },
      },
    ],
  }
}

// --- KaTeX ---------------------------------------------------------------------

type Katex = typeof import('katex')['default']

let katexLoading: Promise<Katex> | null = null

/** KaTeX と CSS（フォントを含む）を読む。失敗したら次の呼び出しで読み直す。 */
function loadKatex(): Promise<Katex> {
  katexLoading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([mod]) => mod.default)
    .catch((e) => {
      katexLoading = null
      throw e
    })
  return katexLoading
}

/**
 * 描いた結果。構文エラーはメッセージで持つ（同じ誤りを打鍵のたびに投げ直させない）。
 * 描けたものは**解析済みの `<template>`** で持つ。KaTeX の出力は式 1 つで数 KB あり、打鍵の
 * たびに `innerHTML` で解析し直すより、木を複製するほうが安い。
 */
type Rendered = { template: HTMLTemplateElement } | { error: string }

/**
 * 描いた結果のキャッシュ。**プレビューは打鍵のたびに作り直される**ので、触っていない数式まで
 * 毎回組み直さない。編集中の式は打鍵ごとに別の
 * キーになって溜まるので、上限を超えたら丸ごと捨てる（`codeHighlight.ts` と同じ）。
 */
const cache = new Map<string, Rendered>()
const CACHE_LIMIT = 500

function renderOne(katex: Katex, source: string, display: boolean): Rendered {
  const key = `${display ? 'D' : 'I'}${source}`
  const hit = cache.get(key)
  if (hit) return hit
  let out: Rendered
  try {
    // `strict: 'ignore'`: 数式の中の日本語などで、描けるのにコンソールへ警告を出し続けないため。
    const template = document.createElement('template')
    template.innerHTML = katex.renderToString(source, { displayMode: display, throwOnError: true, strict: 'ignore' })
    out = { template }
  } catch (e) {
    out = { error: e instanceof Error ? e.message : String(e) }
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, out)
  return out
}

/**
 * `root` の中の数式の印に KaTeX を当てる。印が無ければ何も読み込まない。
 *
 * KaTeX を読み終えていれば、待つのはマイクロタスク 1 つだけなので、`v-html` で差し替わった
 * 直後に呼べば描画の前に置き換わる（打鍵のたびにソースが一瞬見えることはない）。
 */
export async function renderMath(root: ParentNode): Promise<void> {
  const targets = root.querySelectorAll<HTMLElement>('.math:not(.math-done)')
  if (targets.length === 0) return
  let katex: Katex
  try {
    katex = await loadKatex()
  } catch {
    return // 読めなければソースのまま
  }
  for (const el of targets) {
    // 待っているあいだに本文が描き直されて外れた要素は飛ばす。
    if (!el.isConnected) continue
    const out = renderOne(katex, el.textContent ?? '', el.classList.contains('math-display'))
    el.classList.add('math-done')
    if ('template' in out) {
      el.replaceChildren(out.template.content.cloneNode(true))
    } else {
      // ソースは残したまま、誤りだと分かる見た目にする。理由はポイントすると読める。
      el.classList.add('math-error')
      el.title = out.error
    }
  }
}
