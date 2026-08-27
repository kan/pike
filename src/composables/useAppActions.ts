import { getCurrentWindow } from '@tauri-apps/api/window'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
import { confirmAndExit } from './useBusyExit'
import { useShortcutsModal } from './useShortcutsModal'

/**
 * ショートカットと macOS メニューが共有するアクション表（#254）。
 *
 * 同じ操作の入口が 2 つある（window の keydown と、ネイティブメニューの
 * menu event）。**実装をここに 1 本だけ置き**、両方はキー／メニュー id からこの
 * id への対応表だけを持つ。片方にしか無い動作が生まれると、macOS では
 * メニューが正・Windows ではキーが正、という食い違いになる。
 *
 * ここに足したアクションは `KeyboardShortcuts.vue` とマニュアルにも反映する。
 */
export type AppActionId =
  | 'quickOpen'
  | 'projectSwitcher'
  | 'newTerminal'
  | 'newFile'
  | 'closeTab'
  | 'closeWindow'
  | 'settings'
  | 'nextTab'
  | 'prevTab'
  | 'manual'
  | 'shortcuts'
  | 'quit'

/**
 * プロジェクトスイッチャー / QuickOpen が開いていても通すアクション（#254）。
 *
 * **入口が 2 つあるので一覧はここに 1 本だけ置く。** メニュー側（`useAppMenu`）は
 * この集合で弾き、キーボード側（`useKeyboardShortcuts`）は該当する 2 つの分岐を
 * オーバーレイの早期 return より前に置くことで同じ結果にしている。増やすときは
 * 両方を直すこと（片方だけだと macOS のメニューとキーで挙動が割れる）。
 */
export const OVERLAY_ALLOWED_ACTIONS: ReadonlySet<AppActionId> = new Set(['quickOpen', 'projectSwitcher'])

export function useAppActions(): Record<AppActionId, () => void> & {
  /**
   * `Mod+1`〜`Mod+9` でタブへ飛ぶ。**`9` は最後のタブ**（ブラウザ・ターミナルの
   * 慣習）。数字の解釈をここに置くのは、呼び出し側で `9` を特別扱いすると
   * 入口ごとに規則が割れるため。メニューには載せないので `AppActionId` の外側。
   */
  selectTabByDigit: (digit: string) => void
} {
  const tabStore = useTabStore()
  const projectStore = useProjectStore()
  const shortcutsModal = useShortcutsModal()

  return {
    quickOpen: () => projectStore.toggleQuickOpen(),
    projectSwitcher: () => projectStore.toggleSwitcher(),
    newTerminal: () => {
      const project = projectStore.currentProject
      tabStore.addTerminalTab(project ? { cwd: project.root, shell: project.shell } : undefined)
    },
    newFile: () => tabStore.addBlankEditorTab(),
    // タブが 1 つも無ければウィンドウを閉じる。macOS の ⌘W はタブを畳みきったら
    // ウィンドウに進むのが慣習で、グローバルモードのウィンドウが最後のタブを
    // 閉じた時点で自分から閉じるのとも揃う。
    closeTab: () => {
      if (tabStore.activeTabId) tabStore.closeTab(tabStore.activeTabId)
      else void getCurrentWindow().close()
    },
    // `close()` は CloseRequested を経由するので、close-to-tray・実行中ターミナルの
    // 確認・セッション保存という既存の閉じる経路にそのまま乗る。
    closeWindow: () => void getCurrentWindow().close(),
    settings: () => tabStore.addSettingsTab(),
    nextTab: () => tabStore.cycleTab('next'),
    prevTab: () => tabStore.cycleTab('prev'),
    manual: () => tabStore.addManualTab(),
    shortcuts: () => shortcutsModal.toggle(),
    // macOS の ⌘Q。predefined の Quit と違い、走っているコマンドがあれば確認を挟む
    // （#178。閉じる経路と同じ確認で、ここだけ素通りすると全ウィンドウの PTY が黙って死ぬ）。
    quit: () => void confirmAndExit(),
    selectTabByDigit: (digit: string) => {
      const index = digit === '9' ? tabStore.tabs.length - 1 : Number(digit) - 1
      const tab = tabStore.tabs[index]
      if (tab) tabStore.setActiveTab(tab.id)
    },
  }
}
