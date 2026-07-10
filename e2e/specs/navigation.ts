import {
  loadWorktrees,
  MATRIX,
  mockInvoke,
  openPanel,
  openQuickOpen,
  prepare,
  reloadTodo,
  setFakeProject,
  shoot,
} from '../support/prepare'

// worktree セレクタ / QuickOpen / TODO パネルを撮影する。いずれも簡単な invoke モックと
// __pikeE2E ヘルパーで決定的に再現できる。

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
      await openQuickOpen()
      await $('[data-testid="quickopen"]').waitForDisplayed({ timeout: 10_000 })
      await $('.quickopen-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('quickopen', lang, theme)
    })
  }
})

// --- TODO パネル -----------------------------------------------------------
// TODO store は project 変更時（immediate watch）に .pike/todo.md を fsReadFile で読む。
// fs_read_file をモックして決定的な内容を与える。
const TODO_MD = [
  '# デモの TODO',
  '',
  '- [x] スクリーンショット自動化の基盤を作る',
  '- [x] invoke モックパネルを撮る',
  '- [ ] エージェントチャットを撮る',
  '- [ ] マニュアルへ画像を差し替える',
  '',
].join('\n')

describe('screenshots: todo panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`todo-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('fs_read_file', { content: TODO_MD, encoding: 'utf-8', isNew: false })
      await setFakeProject()
      // 擬似プロジェクト id が固定で project watch が再発火しないため明示再ロード。
      await reloadTodo()
      await openPanel('todo')
      await $('[data-testid="todo-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.todo-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('todo-panel', lang, theme)
    })
  }
})
