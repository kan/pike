/**
 * エディタタブのプレビューの検索（#360）。
 *
 * 一致の求め方と強調の登録は `lib/domFind.ts`、見た目は `components/editor/FindBar.vue`。
 * ここに残るのは、**いつ数え直すか**と**いつ動かすか**の 2 つ。
 *
 * - **DOM が変わったら数え直す**（`MutationObserver`）。プレビューは打鍵が止まるたびに
 *   `v-html` で作り直され、そのあと mermaid の図や画像のチップが非同期に書き足されるので、
 *   `previewHtml` を watch するだけでは後処理のぶんを取りこぼす
 * - **数え直しでは動かさない。** 動かすのは検索語を変えたときと、前後へ移動したときだけ。
 *   分割表示で本文を打つたびにプレビューが一致へ飛ぶと、スクロールの同期でエディタまで動く
 * - **コンテナが消えたら閉じる**（Edit 表示へ切り替えたとき）。開いたまま残すと、次に
 *   プレビューを出したとき頼んでいない検索バーが出る
 */
import { onUnmounted, type Ref, ref, shallowRef, watch } from 'vue'
import {
  buildTextIndex,
  clearFindHighlights,
  EMPTY_FIND,
  findInIndex,
  revealRange,
  setFindCurrent,
  setFindHighlights,
  type TextIndex,
} from '../lib/domFind'

/** 一致の上限。超えたぶんは数えず、件数に `+` を付ける。 */
const MAX_MATCHES = 5000

/** DOM の変化をまとめる待ち時間（ms）。mermaid の差し替えは 1 図ずつ来る。 */
const RECOUNT_DELAY = 50

export function usePreviewFind(container: Ref<HTMLElement | undefined>, owner: string) {
  const open = ref(false)
  const query = ref('')
  const caseSensitive = ref(false)
  const currentIndex = ref(0)
  const result = shallowRef(EMPTY_FIND)

  // DOM が変わるまで使い回す（検索語を打つたびにテキストノードを歩き直さない）。
  let index: TextIndex | null = null
  let observer: MutationObserver | null = null
  let recountTimer: ReturnType<typeof setTimeout> | null = null

  function recount(reveal: boolean) {
    const el = container.value
    if (!open.value || !el || !query.value) {
      result.value = EMPTY_FIND
      clearFindHighlights(owner)
      return
    }
    index ??= buildTextIndex(el)
    const found = findInIndex(index, query.value, caseSensitive.value, MAX_MATCHES)
    result.value = found
    if (currentIndex.value >= found.ranges.length) currentIndex.value = 0
    setFindHighlights(owner, found.ranges, found.ranges[currentIndex.value] ?? null)
    if (reveal) revealCurrent()
  }

  function revealCurrent() {
    const range = result.value.ranges[currentIndex.value]
    if (range && container.value) revealRange(range, container.value)
  }

  function observe(el: HTMLElement | undefined) {
    observer?.disconnect()
    observer = null
    if (recountTimer) clearTimeout(recountTimer)
    recountTimer = null
    index = null
    if (!el || !open.value) return
    observer = new MutationObserver(() => {
      index = null
      if (recountTimer) clearTimeout(recountTimer)
      recountTimer = setTimeout(() => {
        recountTimer = null
        recount(false)
      }, RECOUNT_DELAY)
    })
    observer.observe(el, { childList: true, subtree: true, characterData: true })
  }

  // Split と Preview を行き来すると、プレビューの要素ごと作り直される。
  watch(container, (el) => {
    if (!el) return close()
    observe(el)
    recount(false)
  })

  watch([query, caseSensitive], () => {
    currentIndex.value = 0
    recount(true)
  })

  function step(delta: number) {
    const n = result.value.ranges.length
    if (n === 0) return
    currentIndex.value = (currentIndex.value + delta + n) % n
    setFindCurrent(owner, result.value.ranges[currentIndex.value])
    revealCurrent()
  }

  function show() {
    if (open.value) return
    open.value = true
    observe(container.value)
    recount(true)
  }

  function close() {
    open.value = false
    observe(undefined)
    recount(false)
  }

  onUnmounted(close)

  return { open, query, caseSensitive, currentIndex, result, step, show, close }
}
