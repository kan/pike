/**
 * Mermaid の図を SVG の文字列にする（#417）。
 *
 * **描画器は 2 つ持つ。** 見た目の良い `beautiful-mermaid` を先に試し、描けない図は本家の
 * `mermaid` に回す。beautiful-mermaid が扱うのは flowchart / state / sequence / class / ER /
 * xychart の 6 種だけで、gantt・pie・gitGraph・mindmap などは持たない。しかも**知らない図を
 * flowchart として読みにいく**（`detectDiagramType` の既定が flowchart）ので、見出しの行を
 * こちらで見て振り分ける（`isBeautifulDiagram`）。6 種でも構文の対応が本家より狭いので、
 * 投げたら本家に回す（エラーの文言も本家のほうが詳しい）。投げずに読み違える flowchart / state は
 * `misreadsGraph` で拾って本家に回す。
 *
 * どちらも遅延 import する（beautiful-mermaid は elkjs を抱えて約 2MB、mermaid はそれ以上）。
 */
import type mermaidType from 'mermaid'

let mermaidInstance: typeof mermaidType | null = null
let mermaidDark: boolean | null = null

async function getMermaid(dark: boolean): Promise<typeof mermaidType> {
  if (!mermaidInstance) {
    const mod = await import('mermaid')
    mermaidInstance = mod.default
  }
  if (mermaidDark !== dark) {
    mermaidDark = dark
    mermaidInstance.initialize({
      startOnLoad: false,
      theme: dark ? 'dark' : 'default',
      // 'antiscript' keeps HTML labels enabled (htmlLabels defaults to true
      // regardless of securityLevel, so foreignObject labels still get the
      // theme's colors) while mermaid's own DOMPurify pass strips scripts and
      // event handlers from label text. Unlike 'loose' it also blocks the
      // click/`javascript:` href interactions. We insert the rendered SVG as-is
      // (mermaid's documented usage) — do NOT run it through our SVG_PURIFY_OPTS
      // sanitizer, which drops the foreignObject label contents and blanks every
      // label. Untrusted standalone .svg files are still sanitized in EditorTab.
      securityLevel: 'antiscript',
    })
  }
  return mermaidInstance
}

/**
 * beautiful-mermaid に渡す図か。**1 行目の見出しだけで決める**（あちらの判定と同じ位置を見る）。
 * 先頭がフロントマター（`---`）・`%%{init}%%`・コメントの図は本家に回す: 設定を読むのは本家だけで、
 * あちらは 1 行目が見出しでないと種類を取り違える。
 */
export function isBeautifulDiagram(source: string): boolean {
  const first = source.trim().split(/[\n;]/, 1)[0]?.trim() ?? ''
  return (
    /^(?:graph|flowchart)\s+(?:TD|TB|LR|BT|RL)$/i.test(first) ||
    /^(?:stateDiagram(?:-v2)?|sequenceDiagram|classDiagram|erDiagram)$/i.test(first) ||
    /^xychart(?:-beta)?\b/i.test(first)
  )
}

/**
 * beautiful-mermaid が扱わない文。flowchart / state のパーサは**知らない行を黙って捨てるか、
 * その語を名前にしたノードを作る**（`click A "url"` が `click` というノードになる）ので、
 * 見つけたら本家に回す。
 */
const UNSUPPORTED_STATEMENT = /^\s*(?:click|call|callback|href|note|accTitle|accDescr)\b/im
/** 矢印の読み損ねが残ったノード名（`A-->B` が `A--` に、`A-.->C` が `A-` になる）。 */
const MISREAD_NODE_ID = /--|==|-\.|[-=.]$/

type BeautifulMermaid = typeof import('beautiful-mermaid')

/**
 * flowchart / state を beautiful-mermaid が読み違えていないか。**あちらは投げずに崩れた図を返す**
 * ことがある（空白を挟まない `A-->B` でエッジが消え、ノード名が `A--` に化ける）。投げた図は
 * 呼び出し側で本家に回るので、ここでは投げずに誤読したものだけを拾う。他の 4 種は構文の
 * 取りこぼしで図が崩れるところまでは見つかっていないので見ない。
 */
export function misreadsGraph(bm: BeautifulMermaid, source: string): boolean {
  if (!/^(?:graph|flowchart|stateDiagram)/i.test(source.trim())) return false
  if (UNSUPPORTED_STATEMENT.test(source)) return true
  const { nodes } = bm.parseMermaid(source)
  for (const id of nodes.keys()) if (MISREAD_NODE_ID.test(id)) return true
  return false
}

/**
 * SVG の中の `<style>` を、その SVG の中だけに効くように書き換える。
 *
 * beautiful-mermaid は `text { font-family }` や `svg { --_line: … }` のような素のセレクタで
 * 書くので、そのまま文書へ埋めると**ページ中の SVG に効く**（別タブの SVG プレビューの文字の
 * 書体が変わる、など）。本家の出力は `#id` で絞ってあるので通さない。
 * `@scope` を使わないのは、macOS の古い WKWebView が規則ごと捨てて図の色が全部抜けるため。
 * 同じ理由で書き換えは CSSOM に解析させる（正規表現で選択子を探さない）。
 *
 * Google Fonts の `@import` も落とす。CSP（`style-src`）が止めるので読めないうえ、
 * 止められるたびにコンソールへ違反が出る。書体は `font` で UI のものを渡している。
 */
export function scopeSvgStyles(svg: string, id: string): string {
  const scope = `#${CSS.escape(id)}`
  const scoped = svg.replace(/<style>([\s\S]*?)<\/style>/g, (_, css: string) => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css.replace(/@import\s+url\([^)]*\)\s*;/g, ''))
    const rules = Array.from(sheet.cssRules, (rule) => {
      if (rule instanceof CSSStyleRule) {
        rule.selectorText = rule.selectorText
          .split(',')
          .map((s) => (s.trim() === 'svg' ? scope : `${scope} ${s.trim()}`))
          .join(', ')
      }
      return rule.cssText
    })
    return `<style>${rules.join('\n')}</style>`
  })
  return scoped.replace('<svg ', `<svg id="${id}" `)
}

/** `rgb` の 3 つ組（`theme.css` の `--bg-primary-rgb` の形）を `#rrggbb` にする。 */
function rgbTripleToHex(triple: string): string | undefined {
  const parts = triple.trim().split(/\s+/).map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined
  return `#${parts.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`
}

/**
 * 図の配色を app のテーマから取る。**CSS 変数の参照（`var(--text-primary)`）ではなく実際の色を
 * 渡す**: xychart は系列の色を accent と背景の 16 進から JS で計算するので、`var()` だと
 * 既定の青に落ちる。そのぶんテーマの切り替えでは描き直しが要る（EditorTab が `darkMode` を見る）。
 */
function diagramColors(): { bg?: string; fg?: string; accent?: string } {
  const root = getComputedStyle(document.documentElement)
  const read = (name: string) => root.getPropertyValue(name).trim() || undefined
  return {
    bg: rgbTripleToHex(root.getPropertyValue('--bg-primary-rgb')),
    fg: read('--text-primary'),
    accent: read('--accent'),
  }
}

export interface MermaidTheme {
  /** 解決済みのライト／ダーク（`settingsStore.darkMode`）。 */
  dark: boolean
  /** 図の文字の書体（`settingsStore.uiFontFamily`。空ならシステムの既定）。 */
  font: string
}

/**
 * beautiful-mermaid の出力（絞り込む前）のキャッシュ。`null` は「本家に回す」と決めた図。
 * **Markdown のプレビューは打鍵のたびに全部の図を描き直す**（`v-html` が DOM を作り直す）ので、
 * 無いと変わっていない図まで毎回 ELK の同期レイアウトでメインスレッドを塞ぐ。id は描くたびに
 * 変わるので、絞り込み（`scopeSvgStyles`）は毎回かける。本家の出力は id が中に焼き込まれるので載せない。
 */
const beautifulCache = new Map<string, string | null>()
const BEAUTIFUL_CACHE_MAX = 64

async function renderBeautiful(source: string, theme: MermaidTheme): Promise<string | null> {
  const key = `${theme.dark}\n${theme.font}\n${source}`
  const hit = beautifulCache.get(key)
  if (hit !== undefined) {
    // 使ったものを後ろへ回す（Map は挿入順なので、先頭が最も古い）
    beautifulCache.delete(key)
    beautifulCache.set(key, hit)
    return hit
  }
  let svg: string | null = null
  try {
    const bm = await import('beautiful-mermaid')
    if (!misreadsGraph(bm, source)) {
      svg = bm.renderMermaidSVG(source, { ...diagramColors(), font: theme.font || undefined, transparent: true })
    }
  } catch {
    // 構文の対応が本家より狭い。本家に回す
  }
  beautifulCache.set(key, svg)
  if (beautifulCache.size > BEAUTIFUL_CACHE_MAX) beautifulCache.delete(beautifulCache.keys().next().value as string)
  return svg
}

/**
 * 図を描いて SVG の文字列を返す。描けなければ本家の例外をそのまま投げる。
 * `id` は文書の中で一意にすること（本家も beautiful-mermaid の `<style>` の絞り込みもこれを使う）。
 *
 * **返す SVG はそのまま `innerHTML` に入れる前提。** beautiful-mermaid はラベルも属性値も
 * 自前でエスケープする（`escapeXml` / `escapeAttr`）。本家の扱いは `getMermaid` のコメント。
 */
export async function renderMermaid(source: string, id: string, theme: MermaidTheme): Promise<string> {
  if (isBeautifulDiagram(source)) {
    const svg = await renderBeautiful(source, theme)
    if (svg !== null) return scopeSvgStyles(svg, id)
  }
  const mermaid = await getMermaid(theme.dark)
  const { svg } = await mermaid.render(id, source)
  return svg
}
