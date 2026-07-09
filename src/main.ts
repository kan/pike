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
    const { init } = await import('@wdio/tauri-plugin')
    await init()
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
    const settings = useSettingsStore()
    ;(window as unknown as { __pikeE2E?: Record<string, unknown> }).__pikeE2E = {
      setLanguage: (lang: string) => {
        settings.language = lang
      },
      setDarkMode: (dark: boolean) => {
        settings.darkMode = dark
      },
    }
  }
}

void bootstrap()
