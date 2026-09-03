import { getCurrentWindow } from '@tauri-apps/api/window'
import type { AppActionId } from '../lib/shortcuts'
import { pickFolder } from '../lib/tauri'
import { globalMode } from '../lib/window'
import { useDiagnosticsStore } from '../stores/diagnostics'
import { useGitStore } from '../stores/git'
import { useProjectStore } from '../stores/project'
import { useSearchStore } from '../stores/search'
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN, useSettingsStore } from '../stores/settings'
import { useSidebarStore } from '../stores/sidebar'
import { useTabStore } from '../stores/tabs'
import type { ShellType, SidebarPanel } from '../types/tab'
import { confirmAndExit } from './useBusyExit'
import { useOutlineSource } from './useOutlineSource'
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

  async function pickAndOpenDirectory() {
    const path = await pickFolder(projectStore.pickerStartDir())
    if (!path) return
    projectStore.showSwitcher = false
    await projectStore.openDirectory(path)
  }

  function zoomFont(step: number) {
    const editor = tabStore.activeTab?.kind === 'editor'
    const current = editor ? settings.editorFontSize : settings.fontSize
    const next = step === 0 ? FONT_SIZE_DEFAULT : Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, current + step))
    if (editor) settings.editorFontSize = next
    else settings.fontSize = next
  }

  function togglePanel(panel: SidebarPanel) {
    useSidebarStore().togglePanel(panel)
  }

  /**
   * 全体検索を開く（#307）。**ここだけトグルしない**: このキーは「検索したい」という
   * 意思表示なので、開いているときに押しても閉じない（VSCode と同じ）。押すたびに入力欄へ
   * フォーカスを戻し、選択していれば入れ直す。
   */
  function openSearch() {
    // **グローバルモードでは何もしない。** サイドバーを描かないので `SearchPanel` は一生
    // マウントされず、`activePanel` に書いた値だけが localStorage に残って次に開く
    // プロジェクトウィンドウの既定パネルを変えてしまう。8 つのパネルアクションのうち
    // **キーを持つのはこれだけ**なので、グローバルウィンドウから飛んでくるのもこれだけ。
    if (globalMode.value) return
    useSearchStore().requestOpen(editorSelection())
    useSidebarStore().openPanel('search')
  }

  /** 選択が長すぎたら検索語として使わない（minify 済みの 1 行を全選択したときなど）。 */
  const MAX_SEED_LEN = 200

  /**
   * アクティブなエディタで選択している文字列。**`useOutlineSource` の登録を借りる**:
   * `EditorTab` は自分がアクティブでなくなったところで `clear` するので、ここに入って
   * いるのは常に「今見えているエディタ」の生きた `EditorView` になる。
   *
   * **切り出す前に弾く。** `Ctrl+A` のあとに押すと、文書全体（最大 2MB）を文字列にして
   * から改行を見つけて捨てることになる。行番号の比較は木を降りるだけで済む。
   */
  function editorSelection(): string | null {
    const view = useOutlineSource().current.value?.view
    if (!view) return null
    const { from, to } = view.state.selection.main
    if (from === to || to - from > MAX_SEED_LEN) return null
    const { doc } = view.state
    if (doc.lineAt(from).number !== doc.lineAt(to).number) return null
    // 空白だけの選択も捨てる。インデントをドラッグで選んだまま押すと、入力欄が
    // 空白で埋まって結果が全部消える。
    const text = doc.sliceString(from, to)
    return text.trim() ? text : null
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
    // フォルダを選んで、登録せずに開く（#230 の一時プロジェクト）。グローバルモードの
    // ウィンドウはプロジェクトを持たないので、別ウィンドウで開く（スイッチャーの
    // 「ディレクトリを開く」と同じ判断）。
    openDirectory: () => void pickAndOpenDirectory(),
    projectSwitcher: () => projectStore.toggleSwitcher(),
    newTerminal: () => openTerminal(),
    newFile: () => tabStore.addBlankEditorTab(),
    /**
     * **タブが尽きたら何もしない（#301）。** ウィンドウを閉じてよいかを決めるのはここでは
     * なく `App.vue` の `tabs.length` の watcher で、あちらはタブが尽きる全経路（コンテキスト
     * メニューの一括クローズ、プロセス終了による自動クローズ）を見ている。ここで閉じると、
     * 保持しているプロジェクトを失う条件が `Mod+W` にだけぶら下がる（理由は `heldIds`）。
     */
    closeTab: () => {
      if (tabStore.activeTabId) tabStore.closeTab(tabStore.activeTabId)
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
    // 文字の大きさ（#260）。**見ているものに効かせる**: エディタのタブならエディタの、
    // それ以外（ターミナル・チャット・ログ）ならターミナルのフォント。設定画面まで
    // 行かずに変えられることが目的なので、今フォーカスしている面が対象で自然。
    fontIncrease: () => zoomFont(1),
    fontDecrease: () => zoomFont(-1),
    fontReset: () => zoomFont(0),
    // パネル（#270）。トグルなので、開いているものをもう一度選ぶと閉じる（アイコンを
    // クリックしたときと同じ挙動）。**検索だけは例外**で、キーを持つぶん「検索したい」と
    // いう意思表示に対して閉じるのは答えになっていない（#307）。
    panelFiles: () => togglePanel('files'),
    panelGit: () => togglePanel('git'),
    panelSearch: openSearch,
    panelDocker: () => togglePanel('docker'),
    panelTasks: () => togglePanel('tasks'),
    panelOutline: () => togglePanel('outline'),
    panelDiagnostics: () => togglePanel('diagnostics'),
    panelProjects: () => togglePanel('projects'),
    // 失敗の通知はストア側（`setError`）。入口ごとに書くと、どれかが漏れる。
    gitPull: () => void useGitStore().pull(),
    gitPush: () => void useGitStore().push(),
    gitRefresh: () => void useGitStore().refreshAll(),
    diagnosticsRun: () => void useDiagnosticsStore().run(),
    openTerminal,
    selectTabByDigit: (digit: string) => {
      const list = tabStore.visibleTabs
      const index = digit === '9' ? list.length - 1 : Number(digit) - 1
      const tab = list[index]
      if (tab) tabStore.setActiveTab(tab.id)
    },
  }
}
