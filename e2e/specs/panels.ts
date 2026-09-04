import { MATRIX, mockInvoke, openEditor, openPanel, prepare, setFakeProject, setGitStatus, shoot } from '../support/prepare'

// Phase 1: invoke 駆動パネルへ決定的なダミーデータを invoke モックで与えて撮影する。
// 擬似プロジェクトを差して activeRoot を確定させ、各パネルの invoke を横取りする。
// パネルは左サイドバー。内容面が空プレースホルダにならないよう、各パネルに関連する
// エディタ（Docker なら compose.yml 等）を背後に開いてから撮る（旧マニュアルの流儀）。

// 内容面に開く背景エディタの中身（パネルごとに関連ファイル）。
const COMPOSE_YML = [
  '# compose.yml',
  'services:',
  '  web:',
  '    image: nginx:1.27',
  '    ports:',
  '      - "8080:80"',
  '  db:',
  '    image: postgres:16',
  '    environment:',
  '      POSTGRES_PASSWORD: example',
  '    ports:',
  '      - "5432:5432"',
  '  redis:',
  '    image: redis:7',
  '    ports:',
  '      - "6379:6379"',
  '',
].join('\n')

const PACKAGE_JSON = [
  '{',
  '  "name": "demo-app",',
  '  "version": "0.1.0",',
  '  "type": "module",',
  '  "scripts": {',
  '    "dev": "vite",',
  '    "build": "vue-tsc --noEmit && vite build",',
  '    "lint": "biome check src/",',
  '    "test": "vitest run"',
  '  }',
  '}',
  '',
].join('\n')

const TAURI_TS = [
  "import { invoke as tauriInvoke } from '@tauri-apps/api/core'",
  '',
  '// E2E 撮影ビルドでは invoke をモック可能にする（唯一の invoke チョークポイント）。',
  'export const invoke: typeof tauriInvoke = __PIKE_E2E__ ? mockableInvoke : tauriInvoke',
  '',
  'export function fsListDir(shell: ShellConfig, path: string) {',
  "  return invoke<FsEntry[]>('fs_list_dir', { shell, path })",
  '}',
  '',
  'export function taskDiscover(shell: ShellConfig, root: string) {',
  "  return invoke<TaskGroup[]>('task_discover', { shell, root })",
  '}',
  '',
].join('\n')

const README_MD = [
  '# demo-app',
  '',
  'AI エージェントとターミナルに特化した軽量開発環境のデモ。',
  '',
  '## 主な機能',
  '',
  '- エディタ・ターミナル・ログを同一タブで扱う',
  '- Git 統合（差分・履歴・ブランチ切替・コミットグラフ）',
  '- Docker パネルとポートフォワード',
  '',
].join('\n')

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
  operation: null,
}

// グラフ表示で複数レーン + マージが出るよう、feature ブランチを main へマージした
// 小さな DAG にする（A = merge, B = main, F = feature、C で分岐）。
const GIT_LOG = [
  {
    hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    parents: ['b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1', 'f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5'],
    refs: 'HEAD -> main, origin/main',
    author: 'Kan Fushihara',
    date: '2026-01-06 14:32',
    message: 'Merge branch feature/screenshots',
  },
  {
    hash: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
    parents: ['c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2'],
    refs: '',
    author: 'Kan Fushihara',
    date: '2026-01-06 11:20',
    message: 'feat: スクリーンショット自動化を追加',
  },
  {
    hash: 'f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5',
    parents: ['c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2'],
    refs: 'feature/screenshots',
    author: 'Kan Fushihara',
    date: '2026-01-05 18:03',
    message: 'wip: 撮影シナリオを追加',
  },
  {
    hash: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
    parents: ['d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3'],
    refs: 'v0.23.0',
    author: 'Kan Fushihara',
    date: '2026-01-05 09:11',
    message: 'fix: ターミナルの再描画不具合を修正',
  },
  {
    hash: 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3',
    parents: [],
    refs: '',
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
  await mockInvoke('git_branch_list', {
    local: ['main', 'develop', 'feature/screenshots'],
    remote: ['origin/main', 'origin/develop', 'origin/feature/tab-tooltip'],
  })
  await mockInvoke('git_remote_url', 'https://github.com/kan/demo-app.git')
  await mockInvoke('git_worktree_list', GIT_WORKTREES)
}

/** Git パネルを開いた状態まで持っていく（背景エディタ込み）。 */
async function openGitPanel(variant: (typeof MATRIX)[number]): Promise<void> {
  await prepare(variant)
  await mockGit()
  await setFakeProject()
  await openEditor({ path: 'README.md', content: README_MD })
  await openPanel('git')
  await $('[data-testid="git-panel"]').waitForDisplayed({ timeout: 10_000 })
}

describe('screenshots: git panel (graph)', () => {
  for (const variant of MATRIX) {
    const { lang, theme } = variant
    it(`git-graph ${lang} ${theme}`, async () => {
      await openGitPanel(variant)
      // コミット履歴をグラフ表示に切り替える（マニュアルの「コミットグラフ」に合わせる）。
      // .view-toggle の 2 つ目（最後）のボタンがグラフ。
      await $('.view-toggle .view-btn:last-child').click()
      await $('.graph-row').waitForDisplayed({ timeout: 10_000 })
      // クリックしたボタンにフォーカスリングが残ると、実行のたびに画像へ差分が出る。
      await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur())
      await shoot('git-graph', lang, theme)
    })
  }
})

// pull / push の右クリックメニュー（#179）。ボタンの右クリックという導線は
// 説明を読まないと気付けないので、マニュアルに図を載せる。
describe('screenshots: pull/push option menu', () => {
  for (const variant of MATRIX) {
    const { lang, theme } = variant
    it(`git-sync-menu ${lang} ${theme}`, async () => {
      await openGitPanel(variant)
      await $('[data-testid="git-push"]').waitForDisplayed({ timeout: 10_000 })
      // WebDriver の右クリック（pointer action）からは contextmenu が発火しないので、
      // ボタンの位置で DOM イベントを直接投げる。メニューはこの座標に出る。
      await browser.execute(() => {
        const btn = document.querySelector('[data-testid="git-push"]')
        if (!btn) return
        const r = btn.getBoundingClientRect()
        btn.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.bottom),
          }),
        )
      })
      await $('[data-testid="sync-menu"]').waitForDisplayed({ timeout: 10_000 })
      await shoot('git-sync-menu', lang, theme)
    })
  }
})

// --- Docker パネル ---------------------------------------------------------
// compose ファイルごとにグループを出す（#221）。コンテナの紐付けは Compose 自身が
// 記録する composeWorkingDir と group.dir の一致で決まるので、擬似プロジェクトの
// root（C:/Users/dev/demo-app）に揃える。ネストしたグループも 1 つ置いて、
// モノレポ構成の見え方を撮影に含める。

const DOCKER_COMPOSE_PROJECTS = [
  {
    dir: 'C:/Users/dev/demo-app',
    file: 'compose.yml',
    name: 'demo-app',
    services: [{ name: 'web' }, { name: 'db' }, { name: 'redis' }],
  },
  {
    dir: 'C:/Users/dev/demo-app/apps/api',
    file: 'apps/api/compose.yml',
    name: 'api',
    services: [{ name: 'worker' }],
  },
]

const DOCKER_CONTAINERS = {
  containers: [
    {
      id: 'c0ffee01',
      name: 'demo-app-web-1',
      image: 'nginx:1.27',
      state: 'running',
      status: 'Up 12 minutes',
      composeService: 'web',
      composeProject: 'demo-app',
      composeWorkingDir: 'C:/Users/dev/demo-app',
    },
    {
      id: 'c0ffee02',
      name: 'demo-app-db-1',
      image: 'postgres:16',
      state: 'running',
      status: 'Up 12 minutes (healthy)',
      composeService: 'db',
      composeProject: 'demo-app',
      composeWorkingDir: 'C:/Users/dev/demo-app',
    },
    {
      id: 'c0ffee03',
      name: 'demo-app-redis-1',
      image: 'redis:7',
      state: 'exited',
      status: 'Exited (0) 3 minutes ago',
      composeService: 'redis',
      composeProject: 'demo-app',
      composeWorkingDir: 'C:/Users/dev/demo-app',
    },
  ],
  tunnels: [{ tunnelId: 't1', targetId: 'c0ffee01', targetPort: 80, localPort: 49160 }],
}

async function mockDocker(): Promise<void> {
  await mockInvoke('docker_ping', true)
  await mockInvoke('docker_compose_discover', DOCKER_COMPOSE_PROJECTS)
  await mockInvoke('docker_list_containers', DOCKER_CONTAINERS)
}

describe('screenshots: docker panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`docker-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockDocker()
      await setFakeProject()
      await openEditor({ path: 'compose.yml', content: COMPOSE_YML })
      await openPanel('docker')
      await $('[data-testid="docker-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.container-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('docker-panel', lang, theme)
    })
  }
})

// --- ファイルツリー パネル（git ステータス色 + gitignore）-------------------
// fs_list_dir は path 引数によらず同じ値を返すため、ルート直下だけ展開した状態で撮る。
// 各 git 状態の色を見せる: 変更(M)/追加(A)/未追跡(?)/gitignore/IGNORED_DIRS。
const FILE_ENTRIES = [
  { name: '.github', isDir: true, ignored: false, gitignored: false },
  { name: 'logs', isDir: true, ignored: false, gitignored: true }, // gitignore（展開可能）
  { name: 'node_modules', isDir: true, ignored: true, gitignored: true }, // IGNORED_DIRS（非展開）
  { name: 'src', isDir: true, ignored: false, gitignored: false }, // 変更を含む→色付く
  { name: '.env', isDir: false, ignored: false, gitignored: true }, // gitignore ファイル
  { name: '.gitignore', isDir: false, ignored: false, gitignored: false },
  { name: 'CLAUDE.md', isDir: false, ignored: false, gitignored: false },
  { name: 'draft.md', isDir: false, ignored: false, gitignored: false }, // 未追跡(?)
  { name: 'logo.svg', isDir: false, ignored: false, gitignored: false }, // 追加(A)
  { name: 'package.json', isDir: false, ignored: false, gitignored: false },
  { name: 'README.md', isDir: false, ignored: false, gitignored: false }, // 変更(M)
]

// gitStatusMap はサブパスを親ディレクトリへ伝播するので、src/App.vue の変更で src も色付く。
const FILE_TREE_STATUS = {
  branch: 'main',
  head: 'a1b2c3d',
  isDirty: true,
  staged: [{ path: 'logo.svg', status: 'A' }],
  unstaged: [
    { path: 'README.md', status: 'M' },
    { path: 'draft.md', status: '?' },
    { path: 'src/App.vue', status: 'M' },
  ],
  conflicted: [],
  ahead: 0,
  behind: 0,
  operation: null,
}

const FILE_TREE_README = ['# demo-app', '', 'AI エージェントとターミナルに特化した軽量開発環境のデモ。', ''].join('\n')

describe('screenshots: file tree panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`file-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('fs_list_dir', FILE_ENTRIES)
      await setFakeProject()
      // git status を直接セットしてツリーの色を出す（files パネルだけだとフェッチが発火しない）。
      await setGitStatus(FILE_TREE_STATUS)
      await openEditor({ path: 'README.md', content: FILE_TREE_README })
      await openPanel('files')
      await $('[data-testid="files-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.tree-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('file-panel', lang, theme)
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
  {
    runner: 'just',
    label: 'just recipes',
    sourceFile: 'justfile',
    cwd: 'C:/Users/dev/demo-app',
    tasks: [
      // just だけが description（doc comment）を持つ。行内の薄い文字で出る
      { name: 'check', command: 'just check', description: 'コミット前チェック一式', runner: 'just' },
      { name: 'e2e', command: 'just e2e', description: 'スクリーンショットを撮り直す', runner: 'just' },
      { name: 'bump', command: 'just bump VERSION', description: 'バージョンを上げる', runner: 'just' },
    ],
  },
]

describe('screenshots: tasks panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`tasks-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('task_discover', TASK_GROUPS)
      await setFakeProject()
      await openEditor({ path: 'package.json', content: PACKAGE_JSON })
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
    { path: 'src/lib/tauri.ts', line: 19, content: 'const invoke: typeof tauriInvoke = __PIKE_E2E__' },
    { path: 'src/lib/tauri.ts', line: 141, content: "  return invoke<FsEntry[]>('fs_list_dir', { shell, path })" },
    { path: 'src/stores/tasks.ts', line: 22, content: '  const groups = await taskDiscover(project.shell, root)' },
    { path: 'src/stores/docker.ts', line: 39, content: '  const [r] = await Promise.all([dockerListContainers()])' },
    { path: 'src/components/panels/SearchPanel.vue', line: 31, content: '  searchStore.search({ query: query.value })' },
  ],
  truncated: false,
}

/** `search_detect_backend` は `SearchBackendInfo` を返す（#304）。文字列だと `backend`
 *  computed が null になり、パネルの版バッジが丸ごと消えたまま撮影される。 */
const SEARCH_BACKEND = { backend: 'rg', version: '15.2.0', pcre2: true }

describe('screenshots: search panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`search-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('search_detect_backend', SEARCH_BACKEND)
      await mockInvoke('search_execute', SEARCH_RESULT)
      await setFakeProject()
      await openEditor({ path: 'src/lib/tauri.ts', content: TAURI_TS })
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

// --- issue パネル -----------------------------------------------------------
// `gh` の実行結果を invoke モックで差す（#278）。パネルが出る条件は「origin が GitHub」
// なので、この spec だけ `setFakeProject` に remoteUrl を渡す。
//
// **`updatedAt` は 30 日以上前にする。** `relativeDate` はそれより新しいと「3 日前」の
// ような相対表記になり、撮るたびに文字が変わって差分が出る（30 日を超えると絶対日付）。
const ISSUE_LIST = {
  issues: [
    {
      number: 312,
      title: 'file type の決定に shebang の情報も使う',
      url: 'https://github.com/kan/pike/issues/312',
      author: 'kan',
      updatedAt: '2026-06-02T10:15:00Z',
      labels: [{ name: 'enhancement', color: 'a2eeef' }],
      parent: null,
    },
    {
      number: 311,
      title: '外部 URL を開く確認をドメイン単位で省略できるようにする',
      url: 'https://github.com/kan/pike/issues/311',
      author: 'kan',
      updatedAt: '2026-06-01T18:40:00Z',
      labels: [{ name: 'enhancement', color: 'a2eeef' }],
      parent: null,
    },
    {
      number: 310,
      title: 'システムのダークモード設定に追随するモードを追加する',
      url: 'https://github.com/kan/pike/issues/310',
      author: 'kan',
      updatedAt: '2026-05-30T09:05:00Z',
      labels: [{ name: 'enhancement', color: 'a2eeef' }],
      parent: null,
    },
    {
      number: 306,
      title: 'リネームしたファイルが Git パネルで壊れて見える',
      url: 'https://github.com/kan/pike/issues/306',
      author: 'kan',
      updatedAt: '2026-05-28T14:20:00Z',
      labels: [{ name: 'bug', color: 'd73a4a' }],
      parent: null,
    },
    {
      number: 307,
      title: '検索欄にフォーカスが入らない',
      url: 'https://github.com/kan/pike/issues/307',
      author: 'kan',
      updatedAt: '2026-05-27T11:00:00Z',
      labels: [{ name: 'bug', color: 'd73a4a' }],
      parent: 306,
    },
  ],
  error: null,
}

describe('screenshots: issues panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`issues-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('issues_gh_available', true)
      await mockInvoke('issues_list', ISSUE_LIST)
      await setFakeProject({ remoteUrl: 'git@github.com:kan/pike.git' })
      await openEditor({ path: 'src/lib/tauri.ts', content: TAURI_TS })
      await openPanel('issues')
      await $('[data-testid="issues-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.issue-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('issues-panel', lang, theme)
    })
  }
})

// --- プロジェクト パネル ----------------------------------------------------
// #203 の見た目（グループ別表示・アイコン・現在のプロジェクトの塗り）を撮る。
// パネルは mount 時に project_list / project_groups_list / fs_dirs_exist を呼ぶので、
// それらをモックしてから開く。setFakeProject と同じ id を先頭に置き、その行が
// 「このウィンドウで開いている」塗りになるようにしてある。
const PANEL_PROJECTS = [
  {
    id: 'e2e-demo',
    name: 'demo-app',
    root: 'C:/Users/dev/demo-app',
    shell: { kind: 'powershell' },
    pinnedTabs: [],
    lastOpened: '2026-08-01T09:00:00Z',
    color: 'blue',
    icon: '🚀',
    group: 'work',
    order: 0,
  },
  {
    id: 'billing-api',
    name: 'billing-api',
    root: '/home/dev/billing-api',
    shell: { kind: 'wsl', distro: 'Ubuntu-22.04' },
    pinnedTabs: [],
    lastOpened: '2026-07-31T12:00:00Z',
    color: 'green',
    icon: '📡',
    group: 'work',
    order: 1,
  },
  {
    id: 'infra-tools',
    name: 'infra-tools',
    root: '/home/dev/infra-tools',
    shell: { kind: 'wsl', distro: 'Ubuntu-22.04' },
    pinnedTabs: [],
    lastOpened: '2026-07-29T08:30:00Z',
    color: 'orange',
    icon: '🐳',
    group: 'work',
    order: 2,
  },
  {
    id: 'markdown-lint',
    name: 'markdown-lint',
    root: '/home/dev/oss/markdown-lint',
    shell: { kind: 'wsl', distro: 'Ubuntu-22.04' },
    pinnedTabs: [],
    lastOpened: '2026-07-25T21:10:00Z',
    color: 'purple',
    icon: '📝',
    group: 'oss',
    order: 0,
  },
  {
    id: 'sandbox',
    name: 'sandbox',
    root: 'C:/Users/dev/sandbox',
    shell: { kind: 'powershell' },
    pinnedTabs: [],
    lastOpened: '2026-07-20T18:45:00Z',
    icon: '🌱',
  },
]

const PANEL_GROUPS = ['work', 'oss']

describe('screenshots: project panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`project-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('project_list', PANEL_PROJECTS)
      await mockInvoke('project_groups_list', PANEL_GROUPS)
      // 存在チェックと origin 取得はバケット単位で呼ばれるので、件数分の true / null を返す。
      await mockInvoke('fs_dirs_exist', [true, true, true, true, true])
      await mockInvoke('git_remote_urls', [null, null, null, null, null])
      await mockInvoke('detect_wsl_distros', ['Ubuntu-22.04'])
      await setFakeProject()
      await openPanel('projects')
      await $('[data-testid="project-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.project-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('project-panel', lang, theme)
    })
  }
})

// Problems の背景に開くソース。診断が指す行が本文にある状態で撮る。
const RUST_SAMPLE = [
  'use std::collections::HashMap;',
  '',
  'pub fn format_tokens(name: String, count: u64) -> String {',
  '    let label = name;',
  '    // 42 行目あたり: 移動済みの値を再び借りる',
  '    format!("{label}: {count}")',
  '}',
  '',
  'pub fn summarize(rows: &HashMap<String, u64>) -> String {',
  '    let total: u64 = rows.values().sum();',
  '    rows.keys().cloned().collect::<Vec<_>>().join(", ")',
  '}',
  '',
].join('\n')

// --- Problems（診断）パネル -------------------------------------------------
// 常駐 LSP は持たず、検出したツールチェインの CLI を 1 回走らせた結果を出す
// （`.claude/rules/editor.md`）。撮影では `diagnostics_run` を横取りして、
// 種類の違う 3 つ（rustc のエラー / go vet の警告 / tsc のエラー）を並べる。
// providers はヘッダの「どのチェッカーが走ったか」に出る。
const DIAGNOSTICS = {
  diagnostics: [
    {
      file: 'src/lib/format.rs',
      line: 42,
      column: 9,
      severity: 'error',
      message: 'borrow of moved value: `name`',
      source: 'rustc',
      code: 'E0382',
    },
    {
      file: 'src/lib/format.rs',
      line: 58,
      column: 5,
      severity: 'warning',
      message: 'unused variable: `total`',
      source: 'rustc',
      code: 'unused_variables',
    },
    {
      file: 'cmd/server/main.go',
      line: 17,
      column: 2,
      severity: 'warning',
      message: 'fmt.Printf format %d has arg name of wrong type string',
      source: 'go vet',
      code: null,
    },
    {
      file: 'src/stores/tasks.ts',
      line: 23,
      column: 14,
      severity: 'error',
      message: "Property 'reload' does not exist on type 'TaskStore'.",
      source: 'tsc',
      code: 'TS2339',
    },
  ],
  providers: [
    { name: 'rust', dir: '.', command: 'cargo check --message-format=json', ok: true, error: null, count: 2 },
    { name: 'go', dir: 'cmd/server', command: 'go vet ./...', ok: true, error: null, count: 1 },
    { name: 'ts', dir: '.', command: 'npx vue-tsc --noEmit --pretty false', ok: true, error: null, count: 1 },
  ],
  truncated: false,
  golangciAvailable: false,
}

describe('screenshots: problems panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`problems-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('diagnostics_run', DIAGNOSTICS)
      await setFakeProject()
      await openEditor({ path: 'src/lib/format.rs', content: RUST_SAMPLE })
      await openPanel('diagnostics')
      await $('[data-testid="diagnostics-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('[data-testid="diagnostics-panel"] .diag-row').waitForDisplayed({ timeout: 10_000 })
      await shoot('problems-panel', lang, theme)
    })
  }
})

// --- 止まった操作の再開バナー（#222） ---------------------------------------
// `git_status` の `operation` が埋まっているときだけ Git パネル最上部に出る。
// 競合が残っているあいだ「続行」は押せないので、conflicted も一緒に入れて
// 実際に見る形（バナー + Conflicts セクション）にする。
const GIT_STATUS_STOPPED = {
  ...GIT_STATUS,
  branch: '(detached)',
  conflicted: [
    { path: 'src/App.vue', status: 'UU' },
    { path: 'src/lib/format.ts', status: 'UU' },
  ],
  operation: {
    kind: 'rebase',
    branch: 'feature/screenshots',
    step: 2,
    total: 5,
    stop: 'conflict',
    stoppedSha: null,
    stoppedSubject: null,
    canContinue: true,
  },
}

describe('screenshots: stopped git operation', () => {
  for (const variant of MATRIX) {
    const { lang, theme } = variant
    it(`git-operation ${lang} ${theme}`, async () => {
      await openGitPanel(variant)
      await setGitStatus(GIT_STATUS_STOPPED)
      await $('[data-testid="git-operation"]').waitForDisplayed({ timeout: 10_000 })
      await shoot('git-operation', lang, theme)
    })
  }
})
