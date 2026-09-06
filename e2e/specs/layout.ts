import {
  enterGlobalMode,
  feedActiveTerminal,
  MATRIX,
  mockInvoke,
  mockPtySpawnUniqueIds,
  moveActiveTabRight,
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
// 持たないグローバルモードのウィンドウ、hero-git は README 用の Git パネル + ターミナルの
// エージェント。

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
      await enterGlobalMode()
      await openTerminal()
      await $('.xterm').waitForDisplayed({ timeout: 10_000 })
      await feedActiveTerminal(PS_SESSION)
      await browser.pause(500)
      await shoot('global-terminal', lang, theme)
    })
  }
})

// --- hero-git（README 用: Git パネル + ターミナルのエージェント）--------------
// README の「Git パネルとエージェント」ヒーローを外枠合成の素に使う。Git サイドバーの
// 横に、ターミナルで動かしている claude を内容として置く（#275 でチャットタブを畳んだので、
// エージェントはターミナルで動かす形が実運用そのもの）。
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

// --- hero-editor（README 用: ファイルツリー + Markdown の Split プレビュー）------
// README の「エディタとファイルツリー」ヒーロー。overview（コードエディタ）と別絵にする
// ため、ファイルツリー + README の Split（編集 + プレビュー）で撮る。
// HERO サイズ（FULL の 2 倍）だと 20 行程度では画面の下半分が空くので、編集ペインと
// プレビューの両方が埋まる長さにしてある。表・引用・コードブロックを混ぜて、
// プレビューが何を描けるかが 1 枚で伝わるようにする。
const HERO_README = [
  '# Pike',
  '',
  '**AI エージェント × ターミナル**に特化した、軽量な開発環境。',
  '',
  '## 主な機能',
  '',
  '- エディタ・ターミナル・Docker ログを同一タブで扱う',
  '- CodeMirror 6（30 言語）、ミニマップ、検索・置換、git diff ガター',
  '- Markdown / Mermaid / CSV / JSON / SVG / PDF プレビュー',
  '- Git 統合（差分・履歴・コミットグラフ・worktree 切替）',
  '- Claude Code / Codex をターミナルタブで動かす',
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
  '```',
  '',
  '## サイドバーパネル',
  '',
  '- **ファイル**：git ステータスの色付き、ドラッグで移動、Ctrl でコピー',
  '- **検索**：ripgrep 同梱（無ければ grep へ自動フォールバック）',
  '- **Docker**：compose サービスの起動・停止、ログ、ポートフォワード',
  '- **タスク**：package.json（npm / pnpm）/ justfile / Makefile / Cargo.toml から検出',
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

// HERO は論理サイズが FULL の 2 倍あるので、右のペインは画面が埋まる量を流す
// （build.md の「HERO の spec のダミーデータは画面が埋まる量にしてある」）。
const HERO_CLAUDE = [
  '\x1b[1;32muser@demo\x1b[0m:\x1b[1;34m~/demo-app\x1b[0m$ claude\r\n',
  '\r\n',
  '\x1b[2m╭──────────────────────────────────────────────╮\x1b[0m\r\n',
  '\x1b[2m│\x1b[0m \x1b[1;35m✻\x1b[0m Claude Code \x1b[2mv2.0.14\x1b[0m                       \x1b[2m│\x1b[0m\r\n',
  '\x1b[2m│\x1b[0m   \x1b[2m~/demo-app  ·  main\x1b[0m                       \x1b[2m│\x1b[0m\r\n',
  '\x1b[2m╰──────────────────────────────────────────────╯\x1b[0m\r\n',
  '\r\n',
  '\x1b[2m>\x1b[0m スクリーンショットの撮り直しが落ちる原因を調べて\r\n',
  '\r\n',
  '\x1b[1;35m✻\x1b[0m \x1b[2mThinking…\x1b[0m\r\n',
  '\r\n',
  '  \x1b[32m⏺\x1b[0m \x1b[1mRead\x1b[0m \x1b[2mscripts/sync-manual-images.sh\x1b[0m \x1b[2m(84 lines)\x1b[0m\r\n',
  '  \x1b[32m⏺\x1b[0m \x1b[1mBash\x1b[0m \x1b[2mjust e2e-sync-check\x1b[0m\r\n',
  '    \x1b[2m│\x1b[0m 72 files would be copied, 6 skipped\r\n',
  '    \x1b[2m│\x1b[0m \x1b[31mmagick: コマンドが見つかりません\x1b[0m\r\n',
  '  \x1b[32m⏺\x1b[0m \x1b[1mGrep\x1b[0m \x1b[2mmagick\x1b[0m \x1b[2m(2 files)\x1b[0m\r\n',
  '\r\n',
  '  ヒーロー画像の合成だけが落ちています。`sync-hero-images.sh` が\r\n',
  '  ImageMagick を呼びますが、WSL の PATH には無く Windows 側\r\n',
  '  （\x1b[36mC:\\Program Files\\ImageMagick-7.0.10-Q16-HDRI\x1b[0m）にあります。\r\n',
  '  先に走る \x1b[36msync-manual-images.sh\x1b[0m は成功するので、\r\n',
  '  \x1b[1mマニュアル 72 枚だけ更新されてヒーロー 6 枚が古いまま残ります。\x1b[0m\r\n',
  '\r\n',
  '  \x1b[32m⏺\x1b[0m \x1b[1mEdit\x1b[0m \x1b[2mjustfile\x1b[0m\r\n',
  '    \x1b[2m│\x1b[0m \x1b[31m- e2e-sync: e2e-sync-manual\x1b[0m\r\n',
  '    \x1b[2m│\x1b[0m \x1b[32m+ e2e-sync: e2e-sync-manual e2e-sync-hero\x1b[0m\r\n',
  '\r\n',
  '  Git Bash 経由なら \x1b[36mmagick\x1b[0m が PATH で解決するので、レシピを\r\n',
  '  2 本続けて走らせる形に直しました。\r\n',
  '\r\n',
  '\x1b[2m>\x1b[0m 撮り直したら下半分が空いてしまった。原因は？\r\n',
  '\r\n',
  '\x1b[1;35m✻\x1b[0m \x1b[2mThinking…\x1b[0m\r\n',
  '\r\n',
  '  \x1b[32m⏺\x1b[0m \x1b[1mRead\x1b[0m \x1b[2m.claude/rules/build.md\x1b[0m \x1b[2m(112 lines)\x1b[0m\r\n',
  '  \x1b[32m⏺\x1b[0m \x1b[1mGrep\x1b[0m \x1b[2mHERO\x1b[0m \x1b[2m(3 files)\x1b[0m\r\n',
  '    \x1b[2m│\x1b[0m e2e/support/layout.ts:14  \x1b[2mHERO = FULL の 2 倍\x1b[0m\r\n',
  '    \x1b[2m│\x1b[0m e2e/specs/layout.ts:256   \x1b[2mhero-git\x1b[0m\r\n',
  '\r\n',
  '  \x1b[1m論理サイズが 2 倍なので、表示できる行数も 2 倍あります。\x1b[0m\r\n',
  '  `build.md` にそのものの注意がありました。\r\n',
  '\r\n',
  '  \x1b[2m> HERO を使う spec のダミーデータは、この寸法で画面が埋まる\x1b[0m\r\n',
  '  \x1b[2m> 量にしてある（README は 60 行超、コミット履歴は 8 件）\x1b[0m\r\n',
  '\r\n',
  '  他の HERO はどちらも 60 行超を流しているのに、この spec だけ\r\n',
  '  30 行ほどしかありません。\r\n',
  '\r\n',
  '  \x1b[32m⏺\x1b[0m \x1b[1mEdit\x1b[0m \x1b[2me2e/specs/layout.ts\x1b[0m\r\n',
  '    \x1b[2m│\x1b[0m \x1b[32m+ 2 往復目を足して 78 行にする\x1b[0m\r\n',
  '  \x1b[32m⏺\x1b[0m \x1b[1mBash\x1b[0m \x1b[2mjust e2e\x1b[0m\r\n',
  '    \x1b[2m│\x1b[0m Spec Files: 12 passed, 12 total\r\n',
  '\r\n',
  '  埋まりました。ついでに \x1b[36mbuild.md\x1b[0m の一覧へ hero-git も\r\n',
  '  足しておきます（これまで overview と hero-editor だけでした）。\r\n',
  '\r\n',
  '\x1b[2m>\x1b[0m \x1b[7m \x1b[0m\r\n',
].join('')

describe('screenshots: hero git', () => {
  for (const { lang, theme } of MATRIX) {
    it(`hero-git ${lang} ${theme}`, async () => {
      await prepare({ lang, theme, ...HERO })
      await mockInvoke('git_status', GIT_STATUS)
      await mockInvoke('git_log', HERO_GIT_LOG)
      await mockInvoke('git_branch_list', { local: ['main', 'develop'], remote: ['origin/main'] })
      await mockPtySpawnUniqueIds()
      await setFakeProject()
      await openTerminal()
      // terminal.ts と同じ順で待つ: xterm の描画とハンドラ登録（spawn 解決後）を待って
      // から流す。feed の後に待っても、ハンドラ登録前に落ちた出力は戻ってこない。
      await $('[data-testid="terminal"]').waitForDisplayed({ timeout: 10_000 })
      await $('.xterm-screen').waitForExist({ timeout: 10_000 })
      await openPanel('git')
      await $('[data-testid="git-panel"]').waitForDisplayed({ timeout: 10_000 })
      await browser.pause(300)
      await feedActiveTerminal(HERO_CLAUDE)
      await shoot('hero-git', lang, theme)
    })
  }
})

// --- split-panes（作業領域を左右 2 ペインに分ける、#308）----------------------
// **横長で撮る**（FULL より広い）。既定の 1600px だと 2 つに割った各ペインが実際の
// 使い方より窮屈に見え、「エディタとターミナルを並べる」という絵にならない。
const SPLIT = { width: 2000, height: 1000 }

const SPLIT_TS = [
  "import { defineStore } from 'pinia'",
  "import { computed, ref } from 'vue'",
  '',
  "export const useTabStore = defineStore('tabs', () => {",
  '  const tabs = ref<Tab[]>([])',
  '  /** 分割しているか（#308）。解除しても tab.pane は消さない。 */',
  '  const split = ref(false)',
  "  const focusedPane = ref<PaneId>('left')",
  '',
  '  /** そのタブが実際に描かれるペイン。tab.pane を直に読まないこと。 */',
  '  function paneOf(tab: Tab | null): PaneId {',
  "    return split.value && tab?.pane === 'right' ? 'right' : 'left'",
  '  }',
  '',
  '  function moveTabToPane(id: string, pane: PaneId) {',
  '    const tab = tabs.value.find((t) => t.id === id)',
  '    if (!tab) return',
  "    if (pane === 'right') split.value = true",
  '    tab.pane = pane',
  '    focusedPane.value = pane',
  '  }',
  '',
  '  return { tabs, split, focusedPane, paneOf, moveTabToPane }',
  '})',
  '',
].join('\n')

const SPLIT_SESSION = [
  '\x1b[1;32muser@demo\x1b[0m:\x1b[1;34m~/demo-app\x1b[0m$ npm test -- --watch\r\n',
  '\r\n',
  '\x1b[2m> demo-app@0.1.0 test\x1b[0m\r\n',
  '\r\n',
  ' \x1b[32m✓\x1b[0m stores/tabs.spec.ts \x1b[2m(12 tests)\x1b[0m \x1b[2m18ms\x1b[0m\r\n',
  ' \x1b[32m✓\x1b[0m stores/project.spec.ts \x1b[2m(9 tests)\x1b[0m \x1b[2m11ms\x1b[0m\r\n',
  ' \x1b[32m✓\x1b[0m lib/diffParser.spec.ts \x1b[2m(21 tests)\x1b[0m \x1b[2m24ms\x1b[0m\r\n',
  '\r\n',
  ' \x1b[7;32m PASS \x1b[0m \x1b[2mWaiting for file changes...\x1b[0m\r\n',
  '\r\n',
  '\x1b[1;32muser@demo\x1b[0m:\x1b[1;34m~/demo-app\x1b[0m$ \x1b[7m \x1b[0m',
].join('')

describe('screenshots: split panes', () => {
  for (const { lang, theme } of MATRIX) {
    it(`split-panes ${lang} ${theme}`, async () => {
      await prepare({ lang, theme, ...SPLIT })
      await mockInvoke('git_status', GIT_STATUS)
      await mockPtySpawnUniqueIds()
      await setFakeProject()
      await openEditor({ path: 'src/stores/tabs.ts', content: SPLIT_TS })
      await $('.cm-editor').waitForDisplayed({ timeout: 10_000 })
      // ターミナルを開いてから右へ送る（送った側が右ペインの中身になる）。
      await openTerminal()
      await $('[data-testid="terminal"]').waitForDisplayed({ timeout: 10_000 })
      await $('.xterm-screen').waitForExist({ timeout: 10_000 })
      await moveActiveTabRight()
      await browser.pause(300)
      await feedActiveTerminal(SPLIT_SESSION)
      await shoot('split-panes', lang, theme)
    })
  }
})
