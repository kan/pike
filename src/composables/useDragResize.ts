/**
 * 大きさを変えるドラッグの配線（サイドバーのパネル幅・diff タブの分割線・コミットタブの
 * 左の列）。
 *
 * **やっているのは listener の出し入れと、ドラッグ中の body のカーソル・選択の抑止だけ。**
 * 何をどう動かすかは呼び出し側が決める（片方は Pinia のストア、もう片方は DOM への直書き）。
 * 動かす対象まで抱えると、両者の事情の違いが引数に出てくるだけで共有する意味が無くなる。
 *
 * `onMove` が受け取るのは**押した位置からの差**。押した時点の値は `onStart` で控える。
 * 縦に動かすものは `axis: 'y'`（#396。カーソルもそちらに合わせる）。
 */

import { onUnmounted } from 'vue'

export interface DragResizeHandlers {
  /** 動かす向き。既定は横。 */
  axis?: 'x' | 'y'
  /** 押した時点の値を控える。 */
  onStart?: () => void
  /** 押した位置からの差（px）。向きは `axis` に従う。 */
  onMove: (delta: number) => void
  /** 離したとき。ドラッグ中に省いた後始末をここで行う。 */
  onEnd?: () => void
}

export function useDragResize(handlers: DragResizeHandlers) {
  const vertical = handlers.axis === 'y'
  let startX = 0
  let dragging = false

  function move(e: MouseEvent) {
    if (dragging) handlers.onMove((vertical ? e.clientY : e.clientX) - startX)
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
    startX = vertical ? e.clientY : e.clientX
    dragging = true
    handlers.onStart?.()
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', stop)
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }

  // ドラッグの途中で消えても、document のリスナと body のスタイルを残さない。
  onUnmounted(stop)

  return { start, stop }
}
