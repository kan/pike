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

// 全体レイアウト系は実使用時の画面比率（サイドバーとエディタ領域のバランス）を
// 見せるのが目的なので、パネル・ダイアログのクローズアップ（既定 1280×832）より
// 大きい実用サイズで撮る。テキストの精読は不要なため縮小表示での可読性低下は許容。
const FULL = { width: 1600, height: 1000 }

// 外枠を合成して README / マニュアル TOP に載せるヒーロー画像（hero-* と overview）は
// FULL の 2 倍で撮る。掲載時は幅に合わせて縮小されるので、実質的に高精細な素材になる。
const HERO = { width: FULL.width * 2, height: FULL.height * 2 }

const GIT_STATUS = {
  branch: 'main',
  head: 'a1b2c3d',
  isDirty: true,
  staged: [
    { path: 'src/App.vue', status: 'M' },
    { path: 'src/components/layout/StatusBar.vue', status: 'M' },
  ],
  unstaged: [
    { path: 'README.md', status: 'M' },
    { path: 'src/stores/git.ts', status: 'M' },
    { path: 'docs/manual/git.md', status: 'M' },
  ],
  conflicted: [],
  ahead: 2,
  behind: 1,
}

const FILE_ENTRIES = [
  { name: '.github', isDir: true, ignored: false },
  { name: 'docs', isDir: true, ignored: false },
  { name: 'e2e', isDir: true, ignored: false },
  { name: 'plugins', isDir: true, ignored: false },
  { name: 'scripts', isDir: true, ignored: false },
  { name: 'src', isDir: true, ignored: false },
  { name: 'src-tauri', isDir: true, ignored: false },
  { name: 'node_modules', isDir: true, ignored: true },
  { name: '.gitignore', isDir: false, ignored: false },
  { name: 'biome.json', isDir: false, ignored: false },
  { name: 'CHANGELOG.md', isDir: false, ignored: false },
  { name: 'CLAUDE.md', isDir: false, ignored: false },
  { name: 'LICENSE', isDir: false, ignored: false },
  { name: 'package.json', isDir: false, ignored: false },
  { name: 'README.md', isDir: false, ignored: false },
  { name: 'tsconfig.json', isDir: false, ignored: false },
  { name: 'vite.config.ts', isDir: false, ignored: false },
]

// overview は HERO サイズで撮るので、20 行では下 2/3 が空く。実際の作業画面らしく
// 見える程度（60 行前後）の内容を置いて、シンタックスハイライトと折り返しの
// ある行が両方入るようにする。
const APP_VUE = [
  '<script setup lang="ts">',
  "import { computed, onMounted, onUnmounted, ref, watch } from 'vue'",
  "import SideBar from './components/layout/SideBar.vue'",
  "import TabPane from './components/layout/TabPane.vue'",
  "import StatusBar from './components/layout/StatusBar.vue'",
  "import ConfirmDialog from './components/ConfirmDialog.vue'",
  "import { usePtyRouter } from './composables/usePtyRouter'",
  "import { useFsWatcher } from './composables/useFsWatcher'",
  "import { useProjectStore } from './stores/project'",
  "import { useSettingsStore } from './stores/settings'",
  '',
  'const project = useProjectStore()',
  'const settings = useSettingsStore()',
  'const ready = ref(false)',
  '',
  '// サイドバーを畳んでいても分かるよう、プロジェクトカラーは',
  '// ウィンドウ左端の縦ラインとして描く（issue #121）。',
  'const accent = computed(() => project.currentProject?.color ?? null)',
  '',
  'usePtyRouter()',
  'useFsWatcher()',
  '',
  'onMounted(async () => {',
  '  await project.restoreLastProject()',
  '  ready.value = true',
  '})',
  '',
  '// worktree の切り替えとプロジェクトの切り替えを 1 箇所で扱う。',
  '// ファイル監視の張り直しはここが唯一の所有者。',
  'watch(',
  '  () => project.activeRoot,',
  '  (root) => {',
  '    if (root) useFsWatcher().repoint(root)',
  '  },',
  ')',
  '',
  'onUnmounted(() => {',
  '  useFsWatcher().stop()',
  '})',
  '</script>',
  '',
  '<template>',
  '  <div class="app-shell" :data-theme="settings.darkMode ? \'dark\' : \'light\'">',
  '    <span v-if="accent" class="window-accent" :style="{ background: accent }" />',
  '    <SideBar v-if="!globalMode" />',
  '    <TabPane v-if="ready" />',
  '    <StatusBar />',
  '    <ConfirmDialog />',
  '  </div>',
  '</template>',
  '',
  '<style scoped>',
  '.app-shell {',
  '  display: flex;',
  '  height: 100vh;',
  '  overflow: hidden;',
  '}',
  '',
  '.window-accent {',
  '  position: absolute;',
  '  inset: 0 auto 0 0;',
  '  width: 3px;',
  '  pointer-events: none;',
  '}',
  '</style>',
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
      await prepare({ lang, theme, ...HERO })
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
      await prepare({ lang, theme, ...FULL })
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
      await prepare({ lang, theme, ...FULL })
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
      await prepare({ lang, theme, ...FULL })
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
  {
    hash: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
    parents: ['d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3'],
    refs: '',
    author: 'Kan Fushihara',
    date: '2026-01-04 18:47',
    message: 'docs: マニュアルの画像を差し替え',
  },
  {
    hash: 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3',
    parents: ['e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4'],
    refs: 'tag: v0.32.0',
    author: 'Kan Fushihara',
    date: '2026-01-04 10:05',
    message: 'Bump version to v0.32.0',
  },
  {
    hash: 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4',
    parents: ['f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5'],
    refs: '',
    author: 'Kan Fushihara',
    date: '2026-01-03 21:30',
    message: 'feat: リモートブランチへの切替に対応',
  },
  {
    hash: 'f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5',
    parents: ['a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6'],
    refs: '',
    author: 'Kan Fushihara',
    date: '2026-01-03 14:12',
    message: 'feat: 見切れたタブタイトルにツールチップを出す',
  },
  {
    hash: 'a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6',
    parents: ['b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7'],
    refs: '',
    author: 'Kan Fushihara',
    date: '2026-01-02 19:58',
    message: 'chore(deps): 依存更新を取り込む',
  },
  {
    hash: 'b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7',
    parents: [],
    refs: '',
    author: 'Kan Fushihara',
    date: '2026-01-02 09:24',
    message: 'fix: ウィンドウ位置の復元をプロジェクト単位にする',
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
      // HERO サイズだと 1 往復ではチャット面が空くので、実際の使用時に近い
      // 往復数まで足す（ツール実行 → 説明 → 追加依頼 → 差分の提示）。
      {
        id: 'u2',
        role: 'user',
        text: 'ついでに CHANGELOG の書き出しも作って。',
        segments: [],
        items: [],
        completed: true,
      },
      {
        id: 'a2',
        role: 'agent',
        text: '',
        completed: true,
        items: [],
        segments: [
          {
            kind: 'item',
            item: {
              type: 'commandExecution',
              id: 'c2',
              completed: true,
              data: {
                command: 'git log --oneline -3',
                output: 'a1b2c3d feat: スクリーンショット自動化を追加\nb2c3d4e fix: ターミナルの再描画不具合を修正\nc3d4e5f docs: マニュアルの画像を差し替え',
                exitCode: 0,
              },
            },
          },
          {
            kind: 'text',
            text: [
              '直近 3 コミットから、次のリリース分の書き出しを作りました。',
              '',
              '```markdown',
              '## [0.33.0] - 2026-07-30',
              '',
              '### Features',
              '',
              '- **スクリーンショットの撮影を自動化した**: 撮影 → 同期を 1 コマンドにまとめました',
              '',
              '### Bug Fixes',
              '',
              '- **ターミナルの再描画不具合を修正**: タブ切替後に画面が崩れることがありました',
              '```',
              '',
              'このまま `CHANGELOG.md` の先頭に差し込みますか。',
            ].join('\n'),
          },
        ],
      },
      {
        id: 'u3',
        role: 'user',
        text: 'お願い。入れたらテストも走らせて。',
        segments: [],
        items: [],
        completed: true,
      },
      {
        id: 'a3',
        role: 'agent',
        text: '',
        completed: true,
        items: [],
        segments: [
          {
            kind: 'item',
            item: {
              type: 'commandExecution',
              id: 'c3',
              completed: true,
              data: {
                command: 'npm run lint && cargo test',
                output:
                  'Checked 142 files in 118ms. No fixes applied.\n\nrunning 84 tests\ntest result: ok. 84 passed; 0 failed; 0 ignored',
                exitCode: 0,
              },
            },
          },
          {
            kind: 'text',
            text: [
              '`CHANGELOG.md` の先頭に差し込みました。lint と cargo test はどちらも通っています。',
              '',
              '- biome: 142 ファイル、指摘なし',
              '- cargo test: 84 passed',
              '',
              'コミットしていいか判断をお願いします。差分は Git パネルから確認できます。',
            ].join('\n'),
          },
        ],
      },
      {
        id: 'u4',
        role: 'user',
        text: 'マニュアルの該当ページも直っているか確認して。',
        segments: [],
        items: [],
        completed: true,
      },
      {
        id: 'a4',
        role: 'agent',
        text: '',
        completed: true,
        items: [],
        segments: [
          {
            kind: 'item',
            item: {
              type: 'commandExecution',
              id: 'c4',
              completed: true,
              data: {
                command: 'npm run check:docs',
                output: 'ドキュメント整合チェック: 問題なし',
                exitCode: 0,
              },
            },
          },
          {
            kind: 'text',
            text: [
              '`docs/manual/git.md` にブランチ切替の節があり、スクリーンショットも同じ版で入っています。',
              '整合チェックも通ったので、ドキュメント側の追従は済んでいます。',
            ].join('\n'),
          },
        ],
      },
      {
        id: 'u5',
        role: 'user',
        text: 'コミットメッセージの案を出して。',
        segments: [],
        items: [],
        completed: true,
      },
      {
        id: 'a5',
        role: 'agent',
        text: '',
        completed: true,
        items: [],
        segments: [
          {
            kind: 'text',
            text: [
              '2 つに分けるのが素直です。',
              '',
              '```',
              'feat(git): リモートブランチへの切替に対応 (#197)',
              '',
              'ステータスバーのブランチ切替に「リモートブランチ」セクションを追加し、',
              'ローカルに無いブランチを選ぶと追跡ブランチを作って切り替える。',
              '```',
              '',
              '```',
              'docs(manual): ブランチ切替のスクリーンショットを追加',
              '```',
              '',
              '前者はコード、後者はマニュアルだけなので、レビューの粒度としても分けたほうが読みやすいはずです。',
            ].join('\n'),
          },
        ],
      },
    ],
  }
}

// --- hero-editor（README 用: ファイルツリー + Markdown の Split プレビュー）------
// README の「エディタとファイルツリー」ヒーロー。overview（コードエディタ）と別絵にする
// ため、ファイルツリー + README の Split（編集 + プレビュー）で撮る。
// HERO サイズ（FULL の 2 倍）だと 20 行程度では画面の下半分が空くので、編集ペインと
// プレビューの両方が埋まる長さにしてある。表・引用・コードブロックを混ぜて、
// プレビューが何を描けるかが 1 枚で伝わるようにする。
const HERO_README = [
  '# Pike',
  '',
  '**AI エージェント × ターミナル**に特化した、軽量な Windows 向け開発環境。',
  '',
  '## 主な機能',
  '',
  '- エディタ・ターミナル・チャットを同一タブで扱う',
  '- CodeMirror 6（30 言語）、ミニマップ、検索・置換、git diff ガター',
  '- Markdown / Mermaid / CSV / JSON / SVG / PDF プレビュー',
  '- Git 統合（差分・履歴・コミットグラフ・worktree 切替）',
  '- Claude Code / Codex を統一チャットタブで',
  '',
  '## はじめに',
  '',
  '```bash',
  'npm install',
  'npm run tauri:dev',
  '```',
  '',
  '> 初回起動時はプロジェクトスイッチャーが開きます。`Ctrl+Shift+P` でいつでも呼び出せます。',
  '',
  '## ショートカット',
  '',
  '| キー | 動作 |',
  '|------|------|',
  '| `Ctrl+P` | コマンドパレット |',
  '| `Ctrl+T` | 新規ターミナル |',
  '| `Ctrl+N` | 新規エディタ |',
  '| `F1` | マニュアル |',
  '',
  '## プロジェクトを登録する',
  '',
  '1. サイドバーの 📁 からプロジェクトパネルを開く',
  '2. 「追加」でルートとシェルを選ぶ',
  '3. WSL なら distro、Windows なら既定シェルを指定する',
  '',
  '登録済みのプロジェクトは `pike <dir>` でも切り替えられます。',
  '',
  '## ターミナルと AI エージェント',
  '',
  'ターミナルタブは WSL / cmd / PowerShell / PowerShell 7 / Git Bash に対応します。',
  '右上のボタンから `claude` などを 1 クリックで起動でき、出力中の `src/main.rs:42` を',
  'クリックするとその行をエディタで開きます。',
  '',
  '```powershell',
  'pike .                    # このディレクトリをプロジェクトとして開く',
  'pike src/main.rs:42       # 42 行目へジャンプ',
  'pike todo add "実装する"  # TODO パネルに追加',
  '```',
  '',
  '## サイドバーパネル',
  '',
  '- **ファイル**：git ステータスの色付き、ドラッグで移動、Ctrl でコピー',
  '- **検索**：ripgrep 同梱（無ければ grep へ自動フォールバック）',
  '- **Docker**：compose サービスの起動・停止、ログ、ポートフォワード',
  '- **タスク**：package.json / Makefile / deno.json / Cargo.toml から検出',
  '- **TODO**：`.pike/todo.md` を CLI と共有',
  '- **Problems**：cargo check / go vet / tsc の結果を一覧',
  '',
  '## ライセンス',
  '',
  'MIT License',
  '',
].join('\n')

describe('screenshots: hero editor + file tree', () => {
  for (const { lang, theme } of MATRIX) {
    it(`hero-editor ${lang} ${theme}`, async () => {
      await prepare({ lang, theme, ...HERO })
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
      await prepare({ lang, theme, ...HERO })
      await mockInvoke('git_status', GIT_STATUS)
      await mockInvoke('git_log', HERO_GIT_LOG)
      await mockInvoke('git_branch_list', { local: ['main', 'develop'], remote: ['origin/main'] })
      await setFakeProject()
      await openAgentChat(heroClaudeFixture())
      await openPanel('git')
      await $('[data-testid="git-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('.msg-agent').waitForDisplayed({ timeout: 10_000 })
      await shoot('hero-git', lang, theme)
    })
  }
})
