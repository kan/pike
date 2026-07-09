import { MATRIX, mockInvoke, openPanel, prepare, setFakeProject, shoot } from '../support/prepare'

// Phase 1: invoke 駆動パネルへ決定的なダミーデータを invoke モックで与えて撮影する。
// 擬似プロジェクトを差して activeRoot を確定させ、各パネルの invoke を横取りする。

const GIT_STATUS = {
  branch: 'main',
  head: 'a1b2c3d',
  isDirty: true,
  staged: [
    { path: 'src/main.ts', status: 'M' },
    { path: 'src/components/Toolbar.vue', status: 'A' },
  ],
  unstaged: [
    { path: 'src/App.vue', status: 'M' },
    { path: 'README.md', status: 'M' },
    { path: 'src/lib/format.ts', status: 'M' },
  ],
  conflicted: [],
  ahead: 2,
  behind: 1,
}

const GIT_LOG = [
  {
    hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    parents: ['b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1'],
    refs: 'HEAD -> main, origin/main',
    author: 'Kan Fushihara',
    date: '2026-01-06 14:32',
    message: 'feat: スクリーンショット自動化を追加',
  },
  {
    hash: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
    parents: ['c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2'],
    refs: '',
    author: 'Kan Fushihara',
    date: '2026-01-05 09:11',
    message: 'fix: ターミナルの再描画不具合を修正',
  },
  {
    hash: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
    parents: ['d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3'],
    refs: 'v0.23.0',
    author: 'Kan Fushihara',
    date: '2026-01-03 20:45',
    message: 'docs: README を更新',
  },
]

const GIT_WORKTREES = [
  {
    path: 'C:/Users/dev/demo-app',
    branch: 'main',
    head: 'a1b2c3d',
    isBare: false,
    isDetached: false,
    isMain: true,
  },
]

async function mockGit(): Promise<void> {
  await mockInvoke('git_status', GIT_STATUS)
  await mockInvoke('git_log', GIT_LOG)
  await mockInvoke('git_branch_list', ['main', 'develop', 'feature/screenshots'])
  await mockInvoke('git_remote_url', 'https://github.com/kan/demo-app.git')
  await mockInvoke('git_worktree_list', GIT_WORKTREES)
}

describe('screenshots: git panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`git-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockGit()
      await setFakeProject()
      await openPanel('git')
      await $('[data-testid="git-panel"]').waitForDisplayed({ timeout: 10_000 })
      await shoot('git-panel', lang, theme)
    })
  }
})
