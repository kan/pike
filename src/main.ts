import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/theme.css'
import type { AgentCapabilities, AgentType } from './types/agent'
import type { ChatMessage } from './types/chat'

async function bootstrap() {
  // E2E 撮影ビルド (issue #142) でのみ wdio guest を初期化し、Tauri invoke を
  // モック可能にする。Pike が最初の invoke を呼ぶ前にラップを仕込むため mount 前に
  // await する。通常ビルドでは __PIKE_E2E__ が false 定数となり、この分岐ごと
  // Rollup が除去する（guest は本番バンドルに含まれない）。
  if (__PIKE_E2E__) {
    // e2e セットアップは撮影専用の補助であり、失敗しても本体の起動を止めない。
    // invoke モックの経路は lib/tauri.ts 側（唯一の invoke チョークポイント）に持つ。
    try {
      const { init } = await import('@wdio/tauri-plugin')
      await init()
    } catch (e) {
      console.error('[e2e] setup failed (continuing to mount):', e)
    }
  }

  const app = createApp(App)
  app.use(createPinia())
  app.mount('#app')

  // E2E 撮影の再現性固定用に、テーマ・言語をリロードなしで切り替える制御 API を
  // 露出する（issue #142）。localStorage + reload 方式だと wdio プラグインの
  // runtime capability が reload 後に失効し、フォーカス補助の警告が氾濫するため、
  // store の reactive ref を直接更新して即時反映させる。本番では分岐ごと除去される。
  if (__PIKE_E2E__) {
    const { useSettingsStore } = await import('./stores/settings')
    const { useTabStore } = await import('./stores/tabs')
    const { useProjectStore } = await import('./stores/project')
    const { useSidebarStore } = await import('./stores/sidebar')
    const { useWorktreeStore } = await import('./stores/worktree')
    const { useTodoStore } = await import('./stores/todo')
    const { useAgentStore } = await import('./stores/agent')
    const { ptyRouter } = await import('./composables/usePtyRouter')
    const { globalMode } = await import('./lib/window')
    const settings = useSettingsStore()
    const tabs = useTabStore()
    const project = useProjectStore()
    const sidebar = useSidebarStore()
    const worktree = useWorktreeStore()
    const todo = useTodoStore()
    const agent = useAgentStore()
    // 撮影を 1 タブに保つため、ファイル系コンテンツタブを閉じる補助（media 系ヘルパー用）。
    const closeContentTabs = () => {
      for (const t of [...tabs.tabs]) {
        if (
          t.kind === 'editor' ||
          t.kind === 'preview' ||
          t.kind === 'diff' ||
          t.kind === 'history' ||
          t.kind === 'pdf'
        ) {
          void tabs.closeTab(t.id)
        }
      }
    }
    ;(window as unknown as { __pikeE2E?: Record<string, unknown> }).__pikeE2E = {
      setLanguage: (lang: string) => {
        settings.language = lang
      },
      setDarkMode: (dark: boolean) => {
        settings.darkMode = dark
      },
      openSwitcher: () => {
        project.showSwitcher = true
      },
      closeSwitcher: () => {
        project.showSwitcher = false
      },
      openSettings: () => {
        project.showSwitcher = false
        tabs.addSettingsTab()
      },
      // シェル一覧ドロップダウン(▾)は globalMode か Windows プロジェクトでのみ出る。
      // WSL 検出でシェルプロファイルを揃えてから globalMode を立てる。
      enterGlobalMode: () => {
        project.showSwitcher = false
        void (async () => {
          try {
            const { detectWslDistros } = await import('./lib/tauri')
            settings.syncShellProfiles(await detectWslDistros())
          } catch {
            // 検出失敗時はデフォルトのプロファイルのまま globalMode に入る
          }
          globalMode.value = true
        })()
      },
      // invoke モックでパネルを撮るための擬似プロジェクト。root を持つ
      // currentProject を差すと activeRoot が定まり、Git/Docker/ファイルツリー等の
      // invoke 駆動パネルが有効になる。データ自体はテスト側の invoke モックが返す。
      setFakeProject: () => {
        project.showSwitcher = false
        project.currentProject = {
          id: 'e2e-demo',
          name: 'demo-app',
          root: 'C:/Users/dev/demo-app',
          shell: { kind: 'powershell' },
          pinnedTabs: [],
          lastOpened: '2026-01-01T00:00:00Z',
        }
      },
      openPanel: (name: string) => {
        sidebar.activePanel = name as typeof sidebar.activePanel
      },
      // QuickOpen（Ctrl+P）を開く。開いた時に list_project_files 等をフェッチするので
      // モックは呼ぶ前に設定する。
      openQuickOpen: () => {
        project.showSwitcher = false
        project.showQuickOpen = true
      },
      // 各撮影を素の状態から始めるため、前の spec で開いたままの overlay を閉じる。
      // ProjectSwitcher / QuickOpen は store、StatusBar の worktree ドロップダウン等は
      // window mousedown で閉じる popover なので合成 mousedown で畳む。
      closeOverlays: () => {
        project.showSwitcher = false
        project.showQuickOpen = false
        window.dispatchEvent(new MouseEvent('mousedown'))
      },
      // worktree セレクタは worktrees が 2 件以上の時だけ表示される。git_worktree_list を
      // モックした上でこれを呼ぶと一覧が入り StatusBar にセレクタが出る。
      loadWorktrees: () => {
        void worktree.loadWorktrees()
      },
      // TODO は project 変更（immediate watch）でロードされるが、撮影は擬似プロジェクトの
      // id が全 spec で同一なため、最初の setFakeProject（fs_read_file 未モック時）の失敗結果が
      // 残り watch も再発火しない。fs_read_file モック後に明示再ロードするための口。
      reloadTodo: () => {
        void todo.load()
      },
      // エディタ/プレビュー/アウトライン撮影用に、決定的な内容でエディタタブを開く。
      // initialContent を渡すと EditorTab は fs_read_file を読まずその内容で描画するため
      // invoke モック不要。initialViewMode は markdown 等プレビュー可能な拡張子でのみ効く。
      // 既存エディタタブは data-testid/セレクタ競合を避けるため閉じてから開く。
      openEditor: (opts: { path: string; content: string; viewMode?: 'edit' | 'split' | 'preview' }) => {
        project.showSwitcher = false
        for (const t of [...tabs.tabs]) {
          if (t.kind === 'editor') void tabs.closeTab(t.id)
        }
        tabs.addEditorTab({ path: opts.path, initialContent: opts.content, initialViewMode: opts.viewMode })
      },
      // 画像ビューワ（PreviewTab）を dataUrl 直指定で開く（fs_read_file_base64 不要）。
      openImage: (opts: { path: string; dataUrl: string }) => {
        project.showSwitcher = false
        closeContentTabs()
        tabs.addPreviewTab({ path: opts.path, dataUrl: opts.dataUrl })
      },
      // 差分タブ（DiffTab）を unified diff 文字列直指定で開く（invoke 不要）。
      openDiff: (opts: { filePath: string; diff: string }) => {
        project.showSwitcher = false
        closeContentTabs()
        tabs.addDiffTab({ filePath: opts.filePath, diff: opts.diff })
      },
      // ファイル履歴タブ（HistoryTab）を開く。onMounted で git_log_file を叩くのでモック前提。
      openHistory: (opts: { filePath: string }) => {
        project.showSwitcher = false
        closeContentTabs()
        tabs.addHistoryTab({ filePath: opts.filePath })
      },
      // PDF タブ（PdfTab）を開く。onMounted で fs_read_file_base64 を叩くのでモック前提。
      openPdf: (opts: { path: string }) => {
        project.showSwitcher = false
        closeContentTabs()
        tabs.addPdfTab({ path: opts.path })
      },
      // ターミナルを 1 枚開く（pty_spawn はモックして実プロセスは起動しない）。
      // 複数あると data-testid が競合するので、既存ターミナルは閉じてから開く。
      openTerminal: () => {
        project.showSwitcher = false
        for (const t of [...tabs.tabs]) {
          if (t.kind === 'terminal') void tabs.closeTab(t.id)
        }
        tabs.addTerminalTab({ shell: { kind: 'powershell' } })
      },
      // pty_output と同じ経路で合成出力を xterm に流す（実 PTY 非依存の撮影用）。
      feedTerminal: (id: string, data: string) => {
        ptyRouter.feed(id, data)
      },
      // アクティブなターミナルタブの ptyId を解決して合成出力を流す。
      // pty_spawn がユニーク id を返す前提（id 固定だと閉じたタブの unregister と
      // 競合してハンドラが消える）。
      feedActiveTerminal: (data: string) => {
        const active = tabs.tabs.find((t) => t.id === tabs.activeTabId)
        if (active?.kind === 'terminal' && active.ptyId) {
          ptyRouter.feed(active.ptyId, data)
        }
      },
      // エージェントチャット（Codex / Claude Code）を実セッションなしで撮影するため、
      // タブを 1 枚開いて store の session 状態を決定的な会話で直接構築する。
      // AgentChatTab.onMounted の ensureConnected は connected=true を先に立てておけば
      // スキップされる（addAgentChatTab の直後・mount 前に設定するのがミソ）。
      // agent_start_session 等の invoke を一切呼ばないので backend 非依存。
      openAgentChat: (opts: {
        agentType: AgentType
        capabilities: AgentCapabilities
        authEmail?: string | null
        sessionTitle?: string | null
        selectedModel?: string | null
        tokenUsage?: { input: number; output: number } | null
        detectedInstructionsFile?: string | null
        messages: ChatMessage[]
      }) => {
        project.showSwitcher = false
        // data-testid/セレクタ競合を避けるため既存の agent-chat は閉じてから開く。
        for (const t of [...tabs.tabs]) {
          if (t.kind === 'agent-chat') void tabs.closeTab(t.id)
        }
        const id = tabs.addAgentChatTab({ agentType: opts.agentType })
        const sess = agent.getSession(id)
        sess.connected = true
        sess.agentType = opts.agentType
        sess.capabilities = opts.capabilities
        sess.authState = {
          status: 'authenticated',
          mode: 'chatgpt',
          planType: 'Pro',
          email: opts.authEmail ?? null,
        }
        sess.messages = opts.messages
        sess.selectedModel = opts.selectedModel ?? null
        sess.tokenUsage = opts.tokenUsage ?? null
        sess.sessionTitle = opts.sessionTitle ?? null
        sess.detectedInstructionsFile = opts.detectedInstructionsFile ?? null
        sess.isGenerating = false
      },
    }
  }
}

void bootstrap()
