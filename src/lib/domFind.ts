/**
 * 描画済みの DOM に対するページ内検索（#360。エディタタブのプレビュー）。
 *
 * **CodeMirror の検索も diff の検索（`diffSearch.ts`）も使えない。** プレビューは Markdown・rst・
 * CSV・JSON を HTML にしたものを `v-html` で流し込み、そのあと mermaid の図・画像のチップ・
 * 見出しの id を DOM の上で書き足すので、一致を取れるのは出来上がった DOM しかない。
 *
 * **一致の強調は CSS Custom Highlight API で描く**（`CSS.highlights`）。`<mark>` で包む形は
 * 採らない: DOM を書き換えると、打鍵のたびに作り直される `v-html` の中身と取り合い、
 * mermaid や画像の後処理が見る要素まで変わる。強調は範囲を登録するだけなので、DOM に一切
 * 触らない。API が無い WebView（macOS の古い WebKit）では強調が出ないだけで、件数と移動は
 * そのまま効く。
 *
 * **一致は `StaticRange` で持つ。** 生きた `Range` は DOM が変わるたびにブラウザが境界を
 * 補正するので、数千件を抱えたまま `v-html` が作り直されると、その差し替え自体が重くなる。
 * 生きた `Range` が要るのは測るとき（`revealRange`）だけ。
 */
import { findRanges } from './text'

/**
 * 文字列の境目を入れる要素。ここをまたいで一致させない（「表のセル A の末尾」と「セル B の
 * 先頭」が続けて読めてしまうのを防ぐ）。入力欄は 1 行なので、境目の `\n` に一致する検索語は来ない。
 */
const BLOCK_TAGS = new Set(
  (
    'ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DETAILS DIV DL DT FIGCAPTION FIGURE FOOTER ' +
    'H1 H2 H3 H4 H5 H6 HEADER HR LI OL P PRE SECTION SUMMARY TABLE TBODY TD TFOOT TH THEAD TR UL'
  ).split(' '),
)

/** 読めない文字を持つ要素。部分木ごと飛ばす。SVG の `<style>` は `SVG_PURIFY_OPTS` が通す。 */
const SKIP_SELECTOR = 'style, script, [hidden]'

/** 1 つのコンテナの文字を 1 本につないだもの。DOM が変わるまで使い回す。 */
export interface TextIndex {
  text: string
  /** 大文字小文字を区別しない検索のための小文字版。初めて要ったときに 1 回だけ作る。 */
  lower?: string
  nodes: Text[]
  /** `nodes[i]` が `text` のどこから始まるか（昇順）。 */
  starts: number[]
}

export function buildTextIndex(root: Element): TextIndex {
  // 要素も歩くのは 2 つのため。読めない部分木を根で飛ばす（テキストノードごとに `closest` で
  // 上へたどらない）ことと、`<br>` で境目を入れること（子にテキストを持たないので `blockOf` には
  // 現れず、`foo<br>bar` が `foobar` として読める）。
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
      if ((n as Element).matches(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT
      return n.nodeName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  let prevParent: Element | null = null
  let prevBlock: Element | null = null
  let lineBreak = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType !== Node.TEXT_NODE) {
      lineBreak = true
      continue
    }
    const node = n as Text
    if (!node.data) continue
    // 隣り合うテキストノードは親を共有することが多いので、たどり直さない。
    const block: Element = node.parentElement === prevParent && prevBlock ? prevBlock : blockOf(node, root)
    if (prevBlock && (lineBreak || block !== prevBlock)) text += '\n'
    prevParent = node.parentElement
    prevBlock = block
    lineBreak = false
    nodes.push(node)
    starts.push(text.length)
    text += node.data
  }
  return { text, nodes, starts }
}

function blockOf(node: Text, root: Element): Element {
  let el = node.parentElement
  while (el && el !== root && !BLOCK_TAGS.has(el.tagName.toUpperCase())) el = el.parentElement
  return el ?? root
}

export interface FindResult {
  ranges: StaticRange[]
  /** `limit` で打ち切ったか。 */
  truncated: boolean
}

export const EMPTY_FIND: FindResult = { ranges: [], truncated: false }

/**
 * 一致を範囲にする。**上限を持つ**: 1 文字の検索語は 1 万行の CSV で数万件になり、
 * そのぶんの範囲と強調の登録が打鍵のたびに走る。
 */
export function findInIndex(index: TextIndex, query: string, caseSensitive: boolean, limit: number): FindResult {
  if (!caseSensitive) index.lower ??= index.text.toLowerCase()
  const hits = caseSensitive
    ? findRanges(index.text, query, true, limit)
    : findRanges(index.lower ?? '', query.toLowerCase(), true, limit)
  const truncated = hits.length > limit
  if (truncated) hits.length = limit
  const ranges = hits.map(([start, end]) => {
    const [startContainer, startOffset] = locate(index, start, false)
    const [endContainer, endOffset] = locate(index, end, true)
    return new StaticRange({ startContainer, startOffset, endContainer, endOffset })
  })
  return { ranges, truncated }
}

/**
 * 通し位置をテキストノードと、その中のオフセットに戻す。`isEnd` のときは「その位置で
 * 終わるノード」を選ぶ（ノードの境目ちょうどで終わる一致を、次のノードの先頭にしない）。
 *
 * **オフセットはノードの長さで抑える。** `toLowerCase` は一部の文字（`İ` など）で長さが
 * 変わるので、区別しない検索では位置が少しずれうる。範囲外のオフセットは測るときに例外になる。
 */
function locate(index: TextIndex, pos: number, isEnd: boolean): [Text, number] {
  const { nodes, starts } = index
  let lo = 0
  let hi = nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const s = starts[mid]
    if (s < pos || (!isEnd && s === pos)) lo = mid
    else hi = mid - 1
  }
  const node = nodes[lo]
  return [node, Math.max(0, Math.min(pos - starts[lo], node.length))]
}

/** 横に寄せるときの余白（px）。端に貼り付くと前後が読めない（diff タブの検索と共有）。 */
export const REVEAL_PAD = 40

/**
 * 一致をコンテナの中で見える位置へ動かす。
 *
 * **`scrollIntoView` を使わない。** あれは `overflow: hidden` の祖先まで動かすので、タブの外の
 * レイアウトがずれる（diff タブの `overflow: clip` と同じ話）。コンテナまでのスクロールできる
 * 要素だけを、縦は中央へ、横は見えていなければ見える分だけ動かす（コードブロックの `pre` が
 * 横スクロールを持つ）。
 */
export function revealRange(found: StaticRange, container: HTMLElement) {
  const start = found.startContainer.parentElement
  if (!start || !container.contains(start)) return
  // 畳まれた `<details>`（フロントマター）の中は描かれていないので、測る前に開く。
  for (let d = start.closest('details'); d && container.contains(d); d = d.parentElement?.closest('details') ?? null) {
    d.open = true
  }
  const range = document.createRange()
  range.setStart(found.startContainer, found.startOffset)
  range.setEnd(found.endContainer, found.endOffset)
  for (let el: HTMLElement | null = start; el; el = el === container ? null : el.parentElement) {
    if (el !== container && !isScrollable(el)) continue
    const r = range.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    if (el === container || r.top < box.top || r.bottom > box.bottom) {
      el.scrollTop += r.top - box.top - (box.height - r.height) / 2
    }
    el.scrollLeft += horizontalReveal(r, box)
  }
}

/** 横方向に見せるための `scrollLeft` の差分（diff タブの検索と共有）。見えていれば 0。 */
export function horizontalReveal(target: DOMRect, box: DOMRect): number {
  if (target.left < box.left) return -(box.left - target.left + REVEAL_PAD)
  if (target.right > box.right) return target.right - box.right + REVEAL_PAD
  return 0
}

function isScrollable(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) return false
  const style = getComputedStyle(el)
  return /(auto|scroll)/.test(style.overflowX + style.overflowY)
}

// --- 強調の登録 -------------------------------------------------------------

/**
 * `CSS.highlights` は**文書に 1 つの表**で、名前は CSS（`theme.css` の `::highlight`）と
 * 対になる固定のもの。エディタタブは v-show で全部マウントされ、分割すると 2 枚が同時に
 * 見えるので、持ち主ごとの範囲をここに集めて登録する。
 *
 * **`Highlight` はモジュールに 1 組だけ持って中身を入れ替える。** 前後へ移動するたびに
 * 全件を足し直すと、現在位置を 1 つ動かすだけで数千件の挿入になる。
 */
const owners = new Map<string, { all: StaticRange[]; current: StaticRange | null }>()

const highlights =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined' ? createHighlights() : null

function createHighlights() {
  const all = new Highlight()
  const current = new Highlight()
  // 現在の一致は全体の強調の上に塗る。
  current.priority = 1
  CSS.highlights.set('pike-find', all)
  CSS.highlights.set('pike-find-current', current)
  return { all, current }
}

/** 一致の集合が変わったとき。 */
export function setFindHighlights(owner: string, all: StaticRange[], current: StaticRange | null) {
  owners.set(owner, { all, current })
  syncAll()
}

/** 現在位置だけが動いたとき。 */
export function setFindCurrent(owner: string, current: StaticRange | null) {
  const entry = owners.get(owner)
  if (!entry) return
  entry.current = current
  syncCurrent()
}

export function clearFindHighlights(owner: string) {
  if (owners.delete(owner)) syncAll()
}

function syncAll() {
  if (!highlights) return
  highlights.all.clear()
  for (const entry of owners.values()) for (const r of entry.all) highlights.all.add(r)
  syncCurrent()
}

function syncCurrent() {
  if (!highlights) return
  highlights.current.clear()
  for (const entry of owners.values()) if (entry.current) highlights.current.add(entry.current)
}
