import { MATRIX, prepare, shoot } from '../support/prepare'

// Phase 1: バックエンド非依存の WebView UI を ja/en × light/dark で自動撮影する。
// まずはアプリ改変なしで到達できる画面から。空プロファイルの e2e ビルドでは
// 起動時に ProjectSwitcher が開く。
describe('screenshots: project switcher', () => {
  for (const { lang, theme } of MATRIX) {
    it(`project-switcher ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      // 起動直後に開く ProjectSwitcher モーダルを撮る。
      await shoot('project-switcher', lang, theme)
    })
  }
})
