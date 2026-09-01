/**
 * 横幅を変えるドラッグの配線（サイドバーのパネル幅・diff タブの分割線）。
 *
 * **やっているのは listener の出し入れと、ドラッグ中の body のカーソル・選択の抑止だけ。**
 * 何をどう動かすかは呼び出し側が決める（片方は Pinia のストア、もう片方は DOM への直書き）。
 * 動かす対象まで抱えると、両者の事情の違いが引数に出てくるだけで共有する意味が無くなる。
 *
 * `onMove` が受け取るのは**押した位置からの差**。押した時点の値は `onStart` で控える。
 */

import { onUnmounted } from 'vue'

export interface DragResizeHandlers {
  /** 押した時点の値を控える。 */
  onStart?: () => void
  /** 押した位置からの x の差（px）。 */
  onMove: (dx: number) => void
  /** 離したとき。ドラッグ中に省いた後始末をここで行う。 */
  onEnd?: () => void
}

export function useDragResize(handlers: DragResizeHandlers) {
  let startX = 0
  let dragging = false

  function move(e: MouseEvent) {
    if (dragging) handlers.onMove(e.clientX - startX)
  }

  function stop() {
    if (!dragging) return
    dragging = false
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', stop)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    handlers.onEnd?.()
  }

  function start(e: MouseEvent) {
    startX = e.clientX
    dragging = true
    handlers.onStart?.()
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', stop)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }

  // ドラッグの途中で消えても、document のリスナと body のスタイルを残さない。
  onUnmounted(stop)

  return { start, stop }
}
