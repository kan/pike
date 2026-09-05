/**
 * タブを掴んでいるあいだの状態（#308）。
 *
 * **モジュール単位のシングルトンにしてある**（`useConfirmDialog` と同じ形）。作業領域を
 * 分割するとタブバーが 2 本になるが、掴めるタブは同時に 1 枚しかないので、状態も 1 つで
 * 足りる。逆に `useDragAndDrop` を各バーで呼ぶ形だと、掴んだ側と落とす側が別の `dragId`
 * を見ることになり、**ペインをまたぐドラッグだけが無言で効かない**（掴んだ id が相手側で
 * null に見えるので、ドロップの印も出ない）。
 *
 * 何を動かすかは呼び出し側の担当（`tabStore.reorderTab` が並べ替えと置き場の変更を持つ）。
 * ここが持つのは「今どれを掴んでいて、どのタブのどちら側に落ちようとしているか」だけ。
 */

import { ref } from 'vue'
import { useDragAndDrop } from './useDragAndDrop'

const { dragId, dragOverTarget, startDrag, resetDrag } = useDragAndDrop<string>()

/** 落とす先のタブの左右どちら側か（挿入位置の印）。 */
const dragSide = ref<'left' | 'right'>('left')

export function useTabDrag() {
  return { dragId, dragOverTarget, dragSide, startDrag, resetDrag }
}
