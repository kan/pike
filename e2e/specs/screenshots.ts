import { callE2E, MATRIX, prepare, shoot } from '../support/prepare'

// Phase 1: バックエンド非依存の WebView UI を ja/en × light/dark で自動撮影する。
// 手撮り backlog（project-switcher / new-project / settings / settings-shells）を埋める。
// 空プロファイルの e2e ビルドを使い、data-testid と __pikeE2E ナビで到達する。

describe('screenshots: project switcher', () => {
  for (const { lang, theme } of MATRIX) {
    it(`project-switcher ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await callE2E('openSwitcher')
      await $('[data-testid="project-switcher"]').waitForDisplayed({ timeout: 10_000 })
      await shoot('project-switcher', lang, theme)
    })
  }
})

describe('screenshots: new project form', () => {
  for (const { lang, theme } of MATRIX) {
    it(`new-project ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      // showSwitcher の false→true 遷移で新規フォーム状態がリセットされるため、
      // 前イテレーションの残り状態を消すには一度閉じてから開き直す。
      await callE2E('closeSwitcher')
      await callE2E('openSwitcher')
      await $('[data-testid="switcher-new-project"]').waitForDisplayed({ timeout: 10_000 })
      await $('[data-testid="switcher-new-project"]').click()
      await $('[data-testid="new-project-form"]').waitForDisplayed({ timeout: 10_000 })
      await shoot('new-project', lang, theme)
    })
  }
})

describe('screenshots: settings', () => {
  for (const { lang, theme } of MATRIX) {
    it(`settings ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await callE2E('openSettings')
      await $('[data-testid="settings-screen"]').waitForDisplayed({ timeout: 10_000 })
      await shoot('settings', lang, theme)
    })
  }
})

describe('screenshots: settings shells', () => {
  for (const { lang, theme } of MATRIX) {
    it(`settings-shells ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await callE2E('openSettings')
      await $('[data-testid="settings-shells"]').waitForExist({ timeout: 10_000 })
      // .settings-scroll の入れ子スクロールコンテナ内で確実に見せるため、
      // ページ内でネイティブ scrollIntoView を実行する。
      await browser.execute(() => {
        document
          .querySelector('[data-testid="settings-shells"]')
          ?.scrollIntoView({ block: 'center' })
      })
      await browser.pause(200)
      await shoot('settings-shells', lang, theme)
    })
  }
})
