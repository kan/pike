import {
  type AgentChatFixture,
  enterGlobalMode,
  feedActiveTerminal,
  MATRIX,
  mockInvoke,
  mockPtySpawnUniqueIds,
  openAgentChat,
  openEditor,
  openEditors,
  openPanel,
  openTerminal,
  prepare,
  setFakeProject,
  shoot,
} from '../support/prepare'

// マニュアル TOP / 画面構成 / グローバルモード / README ヒーローの新規撮影。
// overview・screen-layout は通常プロジェクトの代表的な作業状態、global-* はサイドバーを
// 持たないグローバルモードのウィンドウ、hero-git は README 用の Git パネル + Claude Code。

const GIT_STATUS = {
  branch: 'main',
  head: 'a1b2c3d',
  isDirty: true,
  staged: [{ path: 'src/App.vue', status: 'M' }],
  unstaged: [{ path: 'README.md', status: 'M' }],
  conflicted: [],
  ahead: 2,
  behind: 1,
}

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

const APP_VUE = [
  '<script setup lang="ts">',
  "import { onMounted, ref } from 'vue'",
  "import SideBar from './components/layout/SideBar.vue'",
  "import TabPane from './components/layout/TabPane.vue'",
  "import StatusBar from './components/layout/StatusBar.vue'",
  '',
  'const ready = ref(false)',
  'onMounted(() => {',
  '  ready.value = true',
  '})',
  '</script>',
  '',
  '<template>',
  '  <div class="app-shell">',
  '    <SideBar />',
  '    <TabPane v-if="ready" />',
  '    <StatusBar />',
  '  </div>',
  '</template>',
  '',
].join('\n')

const TABS_TS = [
  "import { defineStore } from 'pinia'",
  "import { ref } from 'vue'",
  '',
  "export const useTabStore = defineStore('tabs', () => {",
  '  const tabs = ref<Tab[]>([])',
  '  const activeTabId = ref<string | null>(null)',
  '',
  '  function addEditorTab(opts: { path: string; initialContent?: string }): string {',
  '    const id = genId()',
  "    tabs.value.push({ id, kind: 'editor', path: opts.path })",
  '    activeTabId.value = id',
  '    return id',
  '  }',
  '',
  '  function closeTab(id: string) {',
  '    const idx = tabs.value.findIndex((t) => t.id === id)',
  '    if (idx >= 0) tabs.value.splice(idx, 1)',
  '  }',
  '',
  '  return { tabs, activeTabId, addEditorTab, closeTab }',
  '})',
  '',
].join('\n')

// --- overview（マニュアル TOP: ファイルツリー + エディタ）--------------------
describe('screenshots: overview', () => {
  for (const { lang, theme } of MATRIX) {
    it(`overview ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('git_status', GIT_STATUS)
      await mockInvoke('fs_list_dir', FILE_ENTRIES)
      await setFakeProject()
      await openEditor({ path: 'src/App.vue', content: APP_VUE })
      await openPanel('files')
      await $('[data-testid="files-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.cm-editor').waitForDisplayed({ timeout: 10_000 })
      await shoot('overview', lang, theme)
    })
  }
})

// --- screen-layout（画面の各部名称: アウトライン + エディタ）-----------------
describe('screenshots: screen layout', () => {
  for (const { lang, theme } of MATRIX) {
    it(`screen-layout ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('git_status', GIT_STATUS)
      await setFakeProject()
      await openEditor({ path: 'src/stores/tabs.ts', content: TABS_TS })
      await openPanel('outline')
      await $('[data-testid="outline-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.cm-editor').waitForDisplayed({ timeout: 10_000 })
      await shoot('screen-layout', lang, theme)
    })
  }
})

// --- global-editor（グローバルモード: サイドバーなし + 複数エディタ）---------
const A_RS = [
  'fn main() {',
  '    let name = std::env::args().nth(1).unwrap_or_else(|| "world".into());',
  '    println!("Hello, {name}!");',
  '}',
  '',
].join('\n')

const NOTES_MD = ['# メモ', '', '- pike a.rs README.md で複数ファイルを開く', '- 存在しないパスは new バッジ付きで開く', ''].join(
  '\n',
)

describe('screenshots: global editor', () => {
  for (const { lang, theme } of MATRIX) {
    it(`global-editor ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await enterGlobalMode()
      await openEditors([
        { path: 'src/main.rs', content: A_RS },
        { path: 'README.md', content: NOTES_MD },
      ])
      // global 初期はレイアウト確定前で isDisplayed が安定しないため、存在確認 + settle。
      await $('.cm-editor').waitForExist({ timeout: 10_000 })
      await browser.pause(600)
      await shoot('global-editor', lang, theme)
    })
  }
})

// --- global-terminal（グローバルモード: サイドバーなし + ターミナル）---------
const PS_SESSION = [
  '\x1b[32mPS\x1b[0m C:\\Users\\dev\\demo-app> git status',
  'On branch main',
  "Your branch is up to date with 'origin/main'.",
  '',
  'nothing to commit, working tree clean',
  '',
  '\x1b[32mPS\x1b[0m C:\\Users\\dev\\demo-app> ',
].join('\r\n')

describe('screenshots: global terminal', () => {
  for (const { lang, theme } of MATRIX) {
    it(`global-terminal ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockPtySpawnUniqueIds()
      await mockInvoke('pty_resize', null)
      await mockInvoke('pty_write', null)
      await mockInvoke('pty_kill', null)
      await enterGlobalMode()
      await openTerminal()
      await $('.xterm').waitForDisplayed({ timeout: 10_000 })
      await feedActiveTerminal(PS_SESSION)
      await browser.pause(500)
      await shoot('global-terminal', lang, theme)
    })
  }
})

// --- hero-git（README 用: Git パネル + Claude Code チャット）------------------
// README の「Git パネルと Claude Code」ヒーローを外枠合成の素に使う。Git サイドバーの
// 横に Claude Code の統一チャットを内容として置く。
const HERO_GIT_LOG = [
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
]

const CLAUDE_CAPS: AgentChatFixture['capabilities'] = {
  displayName: 'Claude Code',
  supportsModelSelection: false,
  supportsSessionResume: true,
  supportsRollback: false,
  supportsCompact: false,
  supportsSandboxConfig: false,
  supportsApprovalConfig: false,
  supportsAuthFlow: false,
}

function heroClaudeFixture(): AgentChatFixture {
  return {
    agentType: 'claude-code',
    capabilities: CLAUDE_CAPS,
    authEmail: null,
    sessionTitle: 'スクショ撮影の自動化',
    selectedModel: null,
    tokenUsage: { input: 14_320, output: 2_180 },
    detectedInstructionsFile: 'CLAUDE.md',
    messages: [
      { id: 'u1', role: 'user', text: 'コミット前に diff を確認して、要点を日本語でまとめて。', segments: [], items: [], completed: true },
      {
        id: 'a1',
        role: 'agent',
        text: '',
        completed: true,
        items: [],
        segments: [
          {
            kind: 'item',
            item: {
              type: 'commandExecution',
              id: 'c1',
              completed: true,
              data: { command: 'git diff --stat', output: ' src/App.vue   | 8 +++++---\n README.md     | 2 +-\n 2 files changed, 6 insertions(+), 4 deletions(-)', exitCode: 0 },
            },
          },
          {
            kind: 'text',
            text: ['変更の要点です。', '', '- `src/App.vue`: TabPane を `ready` 後に描画するよう修正（初期化順の不具合を解消）', '- `README.md`: 見出しの表記ゆれを 1 箇所修正', '', 'このままコミットして問題なさそうです。'].join('\n'),
          },
        ],
      },
    ],
  }
}

// --- hero-editor（README 用: ファイルツリー + Markdown の Split プレビュー）------
// README の「エディタとファイルツリー」ヒーロー。overview（コードエディタ）と別絵にする
// ため、ファイルツリー + README の Split（編集 + プレビュー）で撮る。
const HERO_README = [
  '# Pike',
  '',
  '**AI エージェント × ターミナル**に特化した、軽量な Windows 向け開発環境。',
  '',
  '## 主な機能',
  '',
  '- エディタ・ターミナル・チャットを同一タブで扱う',
  '- CodeMirror 6（29 言語）、ミニマップ、検索・置換、git diff ガター',
  '- Markdown / Mermaid / CSV / JSON / SVG / PDF プレビュー',
  '- Git 統合（差分・履歴・コミットグラフ・worktree 切替）',
  '',
  '## はじめに',
  '',
  '```bash',
  'npm install',
  'npm run tauri:dev',
  '```',
  '',
].join('\n')

describe('screenshots: hero editor + file tree', () => {
  for (const { lang, theme } of MATRIX) {
    it(`hero-editor ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('git_status', GIT_STATUS)
      await mockInvoke('fs_list_dir', FILE_ENTRIES)
      await setFakeProject()
      await openEditor({ path: 'README.md', content: HERO_README, viewMode: 'split' })
      await openPanel('files')
      await $('[data-testid="files-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.preview-pane').waitForDisplayed({ timeout: 10_000 })
      await shoot('hero-editor', lang, theme)
    })
  }
})

describe('screenshots: hero git + claude', () => {
  for (const { lang, theme } of MATRIX) {
    it(`hero-git ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('git_status', GIT_STATUS)
      await mockInvoke('git_log', HERO_GIT_LOG)
      await mockInvoke('git_branch_list', ['main', 'develop'])
      await setFakeProject()
      await openAgentChat(heroClaudeFixture())
      await openPanel('git')
      await $('[data-testid="git-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.msg-agent').waitForDisplayed({ timeout: 10_000 })
      await shoot('hero-git', lang, theme)
    })
  }
})
