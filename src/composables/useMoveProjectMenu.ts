/**
 * 「別のウィンドウへ移動」の行き先を選ぶメニューの開閉（#469）。
 *
 * **状態はモジュールに 1 つ**（`useConfirmDialog` と同じ形）で、メニューの実体は
 * `components/MoveProjectMenu.vue` を `App.vue` に 1 つ置く。入口が 3 つある（切替の
 * プルダウンの行・プロジェクトパネルの行・パレット）ので、それぞれに行き先の一覧と
 * 位置合わせを持たせると 3 つの写しになる。
 */
import { ref } from 'vue'

export interface MoveProjectMenuState {
  projectId: string
  /** 押したボタンの矩形。無ければ（パレットから）ウィンドウの上寄りの中央に出す。 */
  anchor: DOMRect | null
}

const state = ref<MoveProjectMenuState | null>(null)

/**
 * 行き先のメニューを開く。`anchor` は押した要素（そのそばに出す）。**矩形はここで測る**ので、
 * 押した要素が消える操作（プルダウンを閉じる）より前に呼ぶこと。
 */
export function openMoveProjectMenu(projectId: string, anchor?: EventTarget | null): void {
  const rect = anchor instanceof Element ? anchor.getBoundingClientRect() : null
  state.value = { projectId, anchor: rect }
}

export function closeMoveProjectMenu(): void {
  state.value = null
}

export function useMoveProjectMenu() {
  return { state, close: closeMoveProjectMenu }
}
