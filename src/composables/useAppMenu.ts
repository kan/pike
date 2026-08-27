import { getCurrentWindow } from '@tauri-apps/api/window'
import { onMounted } from 'vue'
import { type AppActionId, useAppActions } from './useAppActions'

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

  onMounted(() => {
    void getCurrentWindow().listen<string>('pike://menu', (e) => {
      const action = actions[e.payload as AppActionId]
      // Rust 側の id と対応が切れたときに、黙って何も起きないのは避ける。
      if (action) action()
      else console.warn(`[appmenu] unknown action: ${e.payload}`)
    })
  })
}
