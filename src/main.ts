import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/theme.css'

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
    const { useGitStore } = await import('./stores/git')
    const { useAgentUsageStore } = await import('./stores/agentUsage')
    const { useEditorInfo } = await import('./composables/useEditorInfo')
    const { ptyRouter } = await import('./composables/usePtyRouter')
    const { globalMode } = await import('./lib/window')
    const settings = useSettingsStore()
    const tabs = useTabStore()
    const project = useProjectStore()
    const sidebar = useSidebarStore()
    const worktree = useWorktreeStore()
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
        // `darkMode` は解決結果の computed なので、書くのはモードのほう（#310）。
        // 撮影は明暗を明示するので、システム追従は使わない。
        settings.themeMode = dark ? 'dark' : 'light'
        // 撮影の light/dark を画面全体で統一するため、エディタ・ターミナルのテーマも
        // app モードに合わせる（既定では両者は darkMode と独立の設定だが、スクショでは揃える）。
        settings.editorThemeName = dark ? 'One Dark' : 'Default Light'
        settings.colorSchemeName = dark ? 'Default Dark' : 'Solarized Light'
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
      // エージェント状態タブ。集計は 30 秒ポーリング + 外部 CLI 依存なので、invoke を
      // 待たずにストアへ直接差す。
      // 引数は id → `AgentUsage`（#263 で 3 つのストアが 1 本に畳まれた）。
      openAgentStatus: (agents: Record<string, unknown>) => {
        project.showSwitcher = false
        for (const [id, usage] of Object.entries(agents)) {
          useAgentUsageStore(id as never).usage = usage as never
        }
        tabs.addAgentStatusTab()
      },
      // シェル一覧ドロップダウン(▾)は globalMode か Windows プロジェクトでのみ出る。
      // WSL 検出でシェルプロファイルを揃えてから globalMode を立てる。
      enterGlobalMode: () => {
        project.showSwitcher = false
        // global モードはプロジェクトレス。currentProject を残すと git のバックグラウンド
        // 更新が擬似 root で走りブランチが再表示されるため null にし、git ステータスと
        // エディタ情報（行/列/エンコード/言語）もクリアして StatusBar を素にする。
        project.currentProject = null
        useGitStore().status = null
        useEditorInfo().clear()
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
      // `remoteUrl` は既定で持たせない。付けると StatusBar にリポジトリリンクが増えて
      // 既存の撮影が変わるので、要る spec（issue パネル）だけが渡す。
      setFakeProject: (opts?: { remoteUrl?: string }) => {
        project.showSwitcher = false
        project.currentProject = {
          id: 'e2e-demo',
          name: 'demo-app',
          root: 'C:/Users/dev/demo-app',
          shell: { kind: 'powershell' },
          pinnedTabs: [],
          lastOpened: '2026-01-01T00:00:00Z',
          remoteUrl: opts?.remoteUrl,
        }
      },
      openPanel: (name: string) => {
        sidebar.openPanel(name as Exclude<typeof sidebar.activePanel, null>)
      },
      // ファイルツリーの git ステータス色を撮るため、gitStore.status を直接セットする。
      // 通常 git status はフェッチ駆動だが、files パネルだけ開くと発火しないため。
      setGitStatus: (status: unknown) => {
        useGitStore().status = status as ReturnType<typeof useGitStore>['status']
      },
      // E2E は @wdio/tauri-service が 1 つのアプリを全 spec で共有するため、先行 spec が
      // 開いたタブ（media.ts の spec.pdf 等）やサイドバーパネルが後続の撮影に残る。各撮影を
      // 素の状態から始めるため、prepare() でこれを await して全タブを閉じ、サイドバーも畳み、
      // グローバルモードも解除する（global 系 spec の設定が後続に残らないよう）。globalMode を
      // 先に false へ戻してから閉じることで「global で全タブを閉じるとウィンドウ close」を避ける。
      // パネル系 spec は prepare の後に openPanel、global 系は enterGlobalMode で開き直す。
      resetTabs: () => {
        globalMode.value = false
        sidebar.setPanel(null)
        return tabs.clearAllTabs()
      },
      // グローバルモードのエディタ撮影用に、複数ファイルを 1 ファイル 1 タブで開く
      // （openEditor は 1 枚に絞るが、こちらは複数タブを残す）。
      openEditors: (files: { path: string; content: string }[]) => {
        project.showSwitcher = false
        for (const t of [...tabs.tabs]) {
          if (t.kind === 'editor') void tabs.closeTab(t.id)
        }
        for (const f of files) tabs.addEditorTab({ path: f.path, initialContent: f.content })
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
    }
  }
}

void bootstrap()
