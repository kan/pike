import { callE2E, MATRIX, mockInvoke, prepare, setFakeProject, shoot } from '../support/prepare'

// Phase 1: バックエンド非依存の WebView UI を ja/en × light/dark で自動撮影する。
// 手撮り backlog（project-switcher / settings / settings-shells）を埋める。
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

// 設定の同期（#403）。同期先は SettingToggle の並び（none / gist / file）で選ぶ。**撮ったら
// 「同期しない」へ戻す**: 同期先はマシンごとの設定として localStorage に残り、衝突の印（歯車の
// ドット）が後ろの spec の撮影に写り込む。
async function setSyncTarget(index: 1 | 2 | 3): Promise<void> {
  await $(`[data-testid="sync-target"] .mode-btn:nth-child(${index})`).click()
}

async function scrollToSync(): Promise<void> {
  await $('[data-testid="sync-target"]').waitForExist({ timeout: 10_000 })
  await browser.execute(() => {
    document.querySelector('[data-testid="sync-target"]')?.closest('section')?.scrollIntoView({ block: 'start' })
  })
  await browser.pause(200)
}

const GIST_LIST = [
  { id: '4f2c9a1b7e3d4c5a8b9e0f1a2b3c4d5e', description: 'Pike settings sync', updatedAt: '2026-09-22T09:14:00Z' },
  { id: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b', description: 'Pike settings sync', updatedAt: '2026-08-30T21:02:00Z' },
]

describe('screenshots: settings sync', () => {
  for (const { lang, theme } of MATRIX) {
    it(`settings-sync ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('detect_wsl_distros', ['Ubuntu'])
      await mockInvoke('sync_gist_list', GIST_LIST)
      await callE2E('openSettings')
      await scrollToSync()
      await setSyncTarget(2)
      // Gist の ID は入れない（入れると自動の同期が走り、時刻入りの状態が写る）。一覧だけ出す。
      await $('[data-testid="sync-gist-choose"]').click()
      await $('[data-testid="sync-gist-list"]').waitForDisplayed({ timeout: 10_000 })
      await scrollToSync()
      await shoot('settings-sync', lang, theme)
      await setSyncTarget(1)
    })
  }
})

// 同期の衝突（#403）。固定のパスの同期先で「今すぐ同期」を押し、手元と違う値を持つ同期
// ファイルを読ませる。前回の内容が無い初めての同期なので、値の違う項目が衝突として並ぶ。
const SYNC_FILE = JSON.stringify({
  fontSize: 17,
  editorTabSize: 8,
  colorSchemeName: 'Dracula',
  uiFontSize: 15,
})

describe('screenshots: sync conflicts', () => {
  for (const { lang, theme } of MATRIX) {
    it(`sync-conflicts ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('settings_sync_read', SYNC_FILE)
      await mockInvoke('settings_sync_write', null)
      // 前のバリアントの同期が残した「前回の内容」を捨てる。書き込みはモックなので同期
      // ファイルは変わらず、残すとテーマの切り替えなどが「リモートで消した」と読まれる。
      await browser.execute(() => {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('pike:sync-base:') || key.startsWith('pike:sync-last:')) localStorage.removeItem(key)
        }
      })
      await callE2E('openSettings')
      await scrollToSync()
      await setSyncTarget(3)
      await browser.execute(() => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="sync-file-path"]')
        if (!input) return
        input.value = 'C:\\Users\\dev\\Dropbox\\pike\\pike-settings.json'
        input.dispatchEvent(new Event('change'))
      })
      await $('[data-testid="sync-now"]').click()
      const open = await $('[data-testid="sync-open-conflicts"]')
      await open.waitForDisplayed({ timeout: 15_000 })
      await open.click()
      await $('[data-testid="sync-conflicts"] .row').waitForDisplayed({ timeout: 10_000 })
      await shoot('sync-conflicts', lang, theme)
      // 後ろの spec に衝突の印を残さない（同期先を外すと状態も捨てる）。
      await callE2E('openSettings')
      await scrollToSync()
      await setSyncTarget(1)
    })
  }
})

// globalMode に入りセッション状態を変えるため、他シナリオへの影響を避けて最後に置く。
describe('screenshots: shell dropdown', () => {
  for (const { lang, theme } of MATRIX) {
    it(`shell-dropdown ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      // シェルの行は globalMode（または Windows プロジェクト）のときだけ出る。
      await callE2E('enterGlobalMode')
      // メニューを開くのは「+」（#396。▾ は `tabAddDirect` を ON にしたときだけ出る）。
      const add = await $('[data-testid="tab-add"]')
      await add.waitForDisplayed({ timeout: 15_000 })
      // トグルなので、前イテレーションで開いたままのことがある。閉じている時だけ開く。
      const menu = await $('[data-testid="shell-menu"]')
      if (!(await menu.isDisplayed())) {
        await add.click()
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
