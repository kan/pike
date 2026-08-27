import { getCurrentWindow } from '@tauri-apps/api/window'
import { onMounted } from 'vue'
import { isMacHost } from '../lib/host'
import { type AppActionId, OVERLAY_ALLOWED_ACTIONS } from '../lib/shortcuts'
import { useProjectStore } from '../stores/project'
import { useAppActions } from './useAppActions'

/**
 * macOS のメニューバーからの操作を受ける（#254）。
 *
 * `Cmd` 付きのショートカットはネイティブメニューのアクセラレータで、AppKit が
 * WebView より先に処理する。つまり **macOS ではこれがショートカットの主経路**で、
 * `useKeyboardShortcuts` の `hasMod` 分岐は Windows / Linux 用に残っている。
 * 動作の実体はどちらも `useAppActions` の 1 本を通る。
 *
 * **`getCurrentWindow().listen()` で受けること。** Rust は `emit_to` で
 * フォーカス中のウィンドウ 1 枚に送っているが、素の `listen()` は target が
 * `Any` なので全ウィンドウで発火する（`.claude/rules/project.md`）。
 *
 * リスナは解除しない。App.vue が 1 回だけ呼び、寿命はウィンドウと同じ
 * （`useCliOpen` の `cli_open` と同じ扱い）。
 */
export function useAppMenu() {
  const actions = useAppActions()
  const projectStore = useProjectStore()

  onMounted(() => {
    // macOS 以外ではメニューそのものが無く（`lib.rs` の cfg スタブ）、このイベントは
    // 一度も飛ばない。`listen` は IPC の往復と、ウィンドウの寿命ぶん残るハンドラを
    // 作るので、起動時に復元するウィンドウの枚数だけ無駄になる。
    if (!isMacHost) return

    void getCurrentWindow().listen<string>('pike://menu', (e) => {
      const id = e.payload as AppActionId
      // オーバーレイが出ているあいだは、キーボード側と同じく無視する。
      // ここを素通しにすると、macOS だけ ⌘T / ⌘W がスイッチャーの裏で
      // タブを増やしたり閉じたりする（キーの経路には無い挙動）。
      if ((projectStore.showSwitcher || projectStore.showQuickOpen) && !OVERLAY_ALLOWED_ACTIONS.has(id)) {
        return
      }
      const action = actions[id]
      // Rust 側の id と対応が切れたときに、黙って何も起きないのは避ける。
      if (action) action()
      else console.warn(`[appmenu] unknown action: ${e.payload}`)
    })
  })
}
