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

// --- Docker パネル ---------------------------------------------------------
// composeProjectName は root ディレクトリ名（demo-app）を小文字化し非英数字を
// 除去した "demoapp"。container.composeProject をこれに揃えるとサービス行に紐づく。

const DOCKER_SERVICES = [{ name: 'web' }, { name: 'db' }, { name: 'redis' }]

const DOCKER_CONTAINERS = {
  containers: [
    {
      id: 'c0ffee01',
      name: 'demo-app-web-1',
      image: 'nginx:1.27',
      state: 'running',
      status: 'Up 12 minutes',
      composeService: 'web',
      composeProject: 'demoapp',
    },
    {
      id: 'c0ffee02',
      name: 'demo-app-db-1',
      image: 'postgres:16',
      state: 'running',
      status: 'Up 12 minutes (healthy)',
      composeService: 'db',
      composeProject: 'demoapp',
    },
    {
      id: 'c0ffee03',
      name: 'demo-app-redis-1',
      image: 'redis:7',
      state: 'exited',
      status: 'Exited (0) 3 minutes ago',
      composeService: 'redis',
      composeProject: 'demoapp',
    },
  ],
  tunnels: [{ tunnelId: 't1', targetId: 'c0ffee01', targetPort: 80, localPort: 49160 }],
}

async function mockDocker(): Promise<void> {
  await mockInvoke('docker_ping', true)
  await mockInvoke('docker_compose_services', DOCKER_SERVICES)
  await mockInvoke('docker_list_containers', DOCKER_CONTAINERS)
}

describe('screenshots: docker panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`docker-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockDocker()
      await setFakeProject()
      await openPanel('docker')
      await $('[data-testid="docker-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.container-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('docker-panel', lang, theme)
    })
  }
})

// --- ファイルツリー パネル -------------------------------------------------
// fs_list_dir は path 引数によらず同じ値を返すため、ルート直下だけ展開した状態で
// 撮る（サブディレクトリは折り畳んだまま）。

const FILE_ENTRIES = [
  { name: '.github', isDir: true, ignored: false },
  { name: 'docs', isDir: true, ignored: false },
  { name: 'src', isDir: true, ignored: false },
  { name: 'src-tauri', isDir: true, ignored: false },
  { name: 'node_modules', isDir: true, ignored: true },
  { name: '.gitignore', isDir: false, ignored: false },
  { name: 'CLAUDE.md', isDir: false, ignored: false },
  { name: 'README.md', isDir: false, ignored: false },
  { name: 'package.json', isDir: false, ignored: false },
  { name: 'vite.config.ts', isDir: false, ignored: false },
]

describe('screenshots: file tree panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`files-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('fs_list_dir', FILE_ENTRIES)
      await setFakeProject()
      await openPanel('files')
      await $('[data-testid="files-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.tree-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('files-panel', lang, theme)
    })
  }
})

// --- タスク パネル ---------------------------------------------------------

const TASK_GROUPS = [
  {
    runner: 'npm',
    label: 'package.json',
    sourceFile: 'package.json',
    cwd: 'C:/Users/dev/demo-app',
    tasks: [
      { name: 'dev', command: 'vite', runner: 'npm' },
      { name: 'build', command: 'vue-tsc --noEmit && vite build', runner: 'npm' },
      { name: 'lint', command: 'biome check src/', runner: 'npm' },
      { name: 'test', command: 'vitest run', runner: 'npm' },
    ],
  },
  {
    runner: 'cargo',
    label: 'src-tauri',
    sourceFile: 'src-tauri/Cargo.toml',
    cwd: 'C:/Users/dev/demo-app/src-tauri',
    tasks: [
      { name: 'build', command: 'cargo build', runner: 'cargo' },
      { name: 'test', command: 'cargo test', runner: 'cargo' },
      { name: 'clippy', command: 'cargo clippy', runner: 'cargo' },
    ],
  },
]

describe('screenshots: tasks panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`tasks-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('task_discover', TASK_GROUPS)
      await setFakeProject()
      await openPanel('tasks')
      await $('[data-testid="tasks-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.task-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('tasks-panel', lang, theme)
    })
  }
})

// --- 検索 パネル -----------------------------------------------------------
// 検索はユーザー入力駆動なので、モックを差した上で実入力欄にクエリを打鍵し Enter。

const SEARCH_RESULT = {
  matches: [
    { path: 'src/lib/tauri.ts', line: 19, content: "const invoke: typeof tauriInvoke = __PIKE_E2E__" },
    { path: 'src/lib/tauri.ts', line: 141, content: "  return invoke<FsEntry[]>('fs_list_dir', { shell, path })" },
    { path: 'src/stores/tasks.ts', line: 22, content: '  const groups = await taskDiscover(project.shell, root)' },
    { path: 'src/stores/docker.ts', line: 39, content: '  const [r] = await Promise.all([dockerListContainers()])' },
    { path: 'src/components/panels/SearchPanel.vue', line: 31, content: '  searchStore.search(query.value, isRegex.value)' },
  ],
  truncated: false,
}

describe('screenshots: search panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`search-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('search_detect_backend', 'rg')
      await mockInvoke('search_execute', SEARCH_RESULT)
      await setFakeProject()
      await openPanel('search')
      await $('[data-testid="search-panel"]').waitForDisplayed({ timeout: 10_000 })
      const input = await $('[data-testid="search-input"]')
      await input.click()
      await input.setValue('invoke')
      await browser.keys('Enter')
      await $('.result-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('search-panel', lang, theme)
    })
  }
})
