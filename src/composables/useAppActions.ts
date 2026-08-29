import { getCurrentWindow } from '@tauri-apps/api/window'
import type { AppActionId } from '../lib/shortcuts'
import { globalMode } from '../lib/window'
import { useDiagnosticsStore } from '../stores/diagnostics'
import { useGitStore } from '../stores/git'
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'
import { useSidebarStore } from '../stores/sidebar'
import { useTabStore } from '../stores/tabs'
import type { ShellType, SidebarPanel } from '../types/tab'
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
export function useAppActions(): Record<AppActionId, () => void> & {
  /**
   * 新規ターミナル。**タブバーの「+」と ▾ もこれを通す**（`TabPane.vue`）。
   * シェルの決め方が入口ごとに割れると、同じ「新規ターミナル」が別のシェルを
   * 起動する（実際に `Ctrl+T` だけがグローバルモードの `globalShell` を無視していた）。
   *
   * `shellOverride` は ▾ から明示的に選んだシェル。
   */
  openTerminal: (shellOverride?: ShellType) => void
  /**
   * `Mod+1`〜`Mod+9` でタブへ飛ぶ。**`9` は最後のタブ**（ブラウザ・ターミナルの
   * 慣習）。数字の解釈をここに置くのは、呼び出し側で `9` を特別扱いすると
   * 入口ごとに規則が割れるため。メニューには載せないので `AppActionId` の外側。
   */
  selectTabByDigit: (digit: string) => void
} {
  // タブ・プロジェクト・設定はどの消費者も使うので先に取り、パネルや git のように
  // 一部のアクションでしか要らないものはクロージャの中で取る（`TabPane` は
  // `openTerminal` 目的でこれを呼ぶので、そこで無関係なストアを起こさない）。
  const tabStore = useTabStore()
  const projectStore = useProjectStore()
  const settings = useSettingsStore()
  const shortcutsModal = useShortcutsModal()

  function openPanel(panel: SidebarPanel) {
    useSidebarStore().togglePanel(panel)
  }

  function openTerminal(shellOverride?: ShellType) {
    // プロジェクトを持たないウィンドウは設定の `globalShell` で開く。ここを
    // `undefined` にすると、バックエンドの `host_default()`（Windows なら PowerShell）に
    // 落ちて、WSL を既定にしている環境で「+」と `Ctrl+T` が別のシェルを起動する。
    if (globalMode.value) {
      tabStore.addTerminalTab({ shell: shellOverride ?? settings.globalShell })
      return
    }
    const project = projectStore.currentProject
    // cwd は `activeRoot`（選択中の worktree）。`project.root` を読むと、worktree を
    // 切り替えたウィンドウで開いた新しいターミナルだけが main を指す（#269）。
    tabStore.addTerminalTab(
      project ? { cwd: projectStore.activeRoot, shell: shellOverride ?? project.shell } : undefined,
    )
  }

  return {
    quickOpen: () => projectStore.toggleQuickOpen(),
    projectSwitcher: () => projectStore.toggleSwitcher(),
    newTerminal: () => openTerminal(),
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
    // エディタタブ以外では何もしない（履歴を出す対象が無い）。メニューには載せない。
    gitHistory: () => {
      const active = tabStore.activeTab
      if (active?.kind === 'editor') tabStore.addHistoryTab({ filePath: active.path })
    },
    // macOS の ⌘Q。predefined の Quit と違い、走っているコマンドがあれば確認を挟む
    // （#178。閉じる経路と同じ確認で、ここだけ素通りすると全ウィンドウの PTY が黙って死ぬ）。
    quit: () => void confirmAndExit(),
    // パネル（#270）。トグルなので、開いているものをもう一度選ぶと閉じる（アイコンを
    // クリックしたときと同じ挙動）。
    panelFiles: () => openPanel('files'),
    panelGit: () => openPanel('git'),
    panelSearch: () => openPanel('search'),
    panelDocker: () => openPanel('docker'),
    panelTasks: () => openPanel('tasks'),
    panelTodo: () => openPanel('todo'),
    panelOutline: () => openPanel('outline'),
    panelDiagnostics: () => openPanel('diagnostics'),
    panelProjects: () => openPanel('projects'),
    // 失敗の通知はストア側（`setError`）。入口ごとに書くと、どれかが漏れる。
    gitPull: () => void useGitStore().pull(),
    gitPush: () => void useGitStore().push(),
    gitRefresh: () => void useGitStore().refreshAll(),
    diagnosticsRun: () => void useDiagnosticsStore().run(),
    agentClaude: () => tabStore.addAgentChatTab({ agentType: 'claude-code' }),
    agentCodex: () => tabStore.addAgentChatTab({ agentType: 'codex' }),
    openTerminal,
    selectTabByDigit: (digit: string) => {
      const list = tabStore.visibleTabs
      const index = digit === '9' ? list.length - 1 : Number(digit) - 1
      const tab = list[index]
      if (tab) tabStore.setActiveTab(tab.id)
    },
  }
}
