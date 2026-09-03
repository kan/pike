import {
  loadWorktrees,
  MATRIX,
  mockInvoke,
  openEditor,
  openQuickOpen,
  prepare,
  setFakeProject,
  setGitStatus,
  shoot,
} from '../support/prepare'

// worktree セレクタ / QuickOpen を撮影する。いずれも簡単な invoke モックと
// __pikeE2E ヘルパーで決定的に再現できる。内容面が空プレースホルダにならないよう、
// 背後に関連エディタを開いてから撮る（旧マニュアルの流儀）。

const APP_VUE = [
  '<script setup lang="ts">',
  "import { ref } from 'vue'",
  "import TabPane from './components/layout/TabPane.vue'",
  '',
  'const ready = ref(false)',
  "onMounted(() => { ready.value = true })",
  '</script>',
  '',
  '<template>',
  '  <TabPane v-if="ready" />',
  '</template>',
  '',
].join('\n')

// --- worktree セレクタ -----------------------------------------------------
const WORKTREES = [
  {
    path: 'C:/Users/dev/demo-app',
    branch: 'main',
    head: 'a1b2c3d',
    isBare: false,
    isDetached: false,
    isMain: true,
  },
  {
    path: 'C:/Users/dev/demo-app-feature',
    branch: 'feature/screenshots',
    head: 'd4e5f6a',
    isBare: false,
    isDetached: false,
    isMain: false,
  },
]

describe('screenshots: worktree selector', () => {
  for (const { lang, theme } of MATRIX) {
    it(`worktree-selector ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('git_worktree_list', WORKTREES)
      await setFakeProject()
      await openEditor({ path: 'src/App.vue', content: APP_VUE })
      // 一覧を読み込むと hasMultiple=true になり StatusBar にセレクタが出る。
      await loadWorktrees()
      const selector = await $('[data-testid="worktree-selector"]')
      await selector.waitForDisplayed({ timeout: 10_000 })
      // クリックでドロップダウンを開く（openWorktreeSwitcher が再フェッチ＋表示）。
      await selector.click()
      await $('.branch-dropdown').waitForDisplayed({ timeout: 10_000 })
      await shoot('worktree-selector', lang, theme)
    })
  }
})

// --- ブランチ切替（ローカル + リモート、#197）--------------------------------
const BRANCH_GIT_STATUS = {
  branch: 'main',
  head: 'a1b2c3d',
  isDirty: true,
  staged: [],
  unstaged: [{ path: 'src/App.vue', status: 'M' }],
  conflicted: [],
  ahead: 2,
  behind: 1,
}

const BRANCHES = {
  local: ['main', 'feature/screenshots'],
  // origin/main と origin/feature/screenshots はローカルに同名があるので一覧には出ない。
  remote: ['origin/main', 'origin/feature/screenshots', 'origin/feature/remote-branches', 'origin/hotfix/encoding'],
}

describe('screenshots: branch switcher', () => {
  for (const { lang, theme } of MATRIX) {
    it(`branch-switcher ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('git_branch_list', BRANCHES)
      // 開くと fetch → status/log の再読込が走る。素通しさせると実在しない
      // 擬似ルートで git が失敗し、status が null になってボタンごと消える。
      await mockInvoke('git_status', BRANCH_GIT_STATUS)
      await mockInvoke('git_log', [])
      await mockInvoke('git_fetch', null)
      await setFakeProject()
      await openEditor({ path: 'src/App.vue', content: APP_VUE })
      await setGitStatus(BRANCH_GIT_STATUS)
      const selector = await $('[data-testid="branch-selector"]')
      await selector.waitForDisplayed({ timeout: 10_000 })
      await selector.click()
      await $('.branch-dropdown').waitForDisplayed({ timeout: 10_000 })
      // 取得中スピナーはアニメーションなので、消えるまで待たないと実行ごとに差分が出る。
      await browser.waitUntil(async () => !(await $('.branch-dropdown .spin-icon').isExisting()), {
        timeout: 10_000,
        timeoutMsg: 'remote branch fetch spinner did not settle',
      })
      await shoot('branch-switcher', lang, theme)
    })
  }
})

// --- QuickOpen（Ctrl+P）----------------------------------------------------
const PROJECT_FILES = [
  'src/App.vue',
  'src/main.ts',
  'src/components/layout/StatusBar.vue',
  'src/components/panels/GitPanel.vue',
  'src/stores/tabs.ts',
  'src/stores/project.ts',
  'src/lib/tauri.ts',
  'src-tauri/src/lib.rs',
  'src-tauri/src/pty/mod.rs',
  'package.json',
  'README.md',
  'CLAUDE.md',
]

describe('screenshots: quick open', () => {
  for (const { lang, theme } of MATRIX) {
    it(`quickopen ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('list_project_files', PROJECT_FILES)
      await setFakeProject()
      await openEditor({ path: 'src/App.vue', content: APP_VUE })
      await openQuickOpen()
      await $('[data-testid="quickopen"]').waitForDisplayed({ timeout: 10_000 })
      await $('.quickopen-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('quickopen', lang, theme)
    })
  }
})
