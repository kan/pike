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
    const { globalMode } = await import('./lib/window')
    const settings = useSettingsStore()
    const tabs = useTabStore()
    const project = useProjectStore()
    const sidebar = useSidebarStore()
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
    }
  }
}

void bootstrap()
