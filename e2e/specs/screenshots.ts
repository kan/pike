import { callE2E, MATRIX, mockInvoke, prepare, setFakeProject, shoot } from '../support/prepare'

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

// globalMode に入りセッション状態を変えるため、他シナリオへの影響を避けて最後に置く。
describe('screenshots: shell dropdown', () => {
  for (const { lang, theme } of MATRIX) {
    it(`shell-dropdown ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      // ▾ プルダウンは globalMode（または Windows プロジェクト）のときだけ出る。
      await callE2E('enterGlobalMode')
      const arrow = await $('[data-testid="tab-add-arrow"]')
      await arrow.waitForDisplayed({ timeout: 15_000 })
      // ▾ はトグル。前イテレーションで開いたままのことがあるので、閉じている時だけ開く。
      const menu = await $('[data-testid="shell-menu"]')
      if (!(await menu.isDisplayed())) {
        await arrow.click()
      }
      await menu.waitForDisplayed({ timeout: 10_000 })
      await shoot('shell-dropdown', lang, theme)
    })
  }
})

// 設定の「エージェント」節（#275 / #299）。起動行の一覧と hook の登録先を撮る。
// hook の状態は実際の settings.json を読むので、撮影機の環境に依らないよう固定する。
const HOOK_STATUS = {
  targets: [
    {
      configDir: 'C:\Users\dev\.claude',
      settingsPath: 'C:\Users\dev\.claude\settings.json',
      registered: true,
      hasAny: true,
      active: true,
      installKey: 'windows',
      command: 'pike.exe agent-hook --install-key=windows',
    },
    {
      configDir: '/home/dev/.claude',
      settingsPath: '/home/dev/.claude/settings.json',
      registered: false,
      hasAny: false,
      active: false,
      installKey: 'wsl:Ubuntu',
      command: 'pike.exe agent-hook --install-key=wsl:Ubuntu',
    },
  ],
  declared: 'C:\Users\dev\.claude',
}

describe('screenshots: settings agents', () => {
  for (const { lang, theme } of MATRIX) {
    it(`settings-agents ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('agent_hook_status', HOOK_STATUS)
      // hook の一覧はプロジェクトを開いているときだけ出る（どの settings.json かが
      // 決まらないため）。
      await setFakeProject()
      await callE2E('openSettings')
      await $('[data-testid="settings-agents"]').waitForExist({ timeout: 10_000 })
      await browser.execute(() => {
        document.querySelector('[data-testid="settings-agents"]')?.scrollIntoView({ block: 'start' })
      })
      await browser.pause(200)
      await shoot('settings-agents', lang, theme)
    })
  }
})
