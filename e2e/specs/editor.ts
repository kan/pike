import { MATRIX, mockInvoke, openEditor, openPanel, prepare, setFakeProject, shoot } from '../support/prepare'

// エディタ / Markdown プレビュー / アウトラインを決定的な内容で撮影する。
// EditorTab は initialContent を渡すと fs_read_file を読まずその内容で描画するため、
// invoke モックなしにシンタックスハイライト・プレビュー・アウトラインを再現できる。

const TS_SAMPLE = [
  "import { defineStore } from 'pinia'",
  "import { computed, ref } from 'vue'",
  '',
  'export interface Task {',
  '  name: string',
  '  command: string',
  '  done: boolean',
  '}',
  '',
  "export const useTaskStore = defineStore('tasks', () => {",
  '  const tasks = ref<Task[]>([])',
  '  const pending = computed(() => tasks.value.filter((t) => !t.done))',
  '',
  '  function add(name: string, command: string) {',
  '    tasks.value.push({ name, command, done: false })',
  '  }',
  '',
  '  function complete(name: string) {',
  '    const task = tasks.value.find((t) => t.name === name)',
  '    if (task) task.done = true',
  '  }',
  '',
  '  return { tasks, pending, add, complete }',
  '})',
  '',
].join('\n')

// Markdown はコードフェンスを含むため配列 join で組み立てる（テンプレートリテラルの
// バッククォート衝突を避ける）。
const MD_SAMPLE = [
  '# demo-app',
  '',
  'AI エージェントとターミナルに特化した軽量開発環境のデモ。',
  '',
  '## 主な機能',
  '',
  '- エディタ・ターミナル・ログを同一タブで扱う',
  '- Git 統合（差分・履歴・ブランチ切替）',
  '- Docker パネルとポートフォワード',
  '',
  '## セットアップ',
  '',
  '```bash',
  'npm install',
  'npm run dev',
  '```',
  '',
  // コードブロックの色付け（#344 / #359）が編集側とプレビュー側の両方で分かるよう、
  // キーワード・型・文字列・数値が混ざる短い TypeScript を置く。
  '```ts',
  'export function greet(name: string, times = 2): string {',
  '  return `hello, ${name}`.repeat(times)',
  '}',
  '```',
  '',
  '## 設定',
  '',
  '| 項目 | 既定 | 説明 |',
  '| --- | --- | --- |',
  '| `theme` | `dark` | カラースキーム |',
  '| `fontSize` | `14` | ターミナルのフォントサイズ |',
  '',
].join('\n')

// エディタ単体のクローズアップは撮らない。マニュアルの「コード編集」は外枠付きの
// ヒーロー画像（`hero-editor` → `docs/manual/img/screenshot-editor.png`）を使っていて、そちらに
// ファイルツリーごと写っているため、同じ内容の 2 枚目に置き場所が無い。
// `TS_SAMPLE` はアウトラインの spec が使う。

describe('screenshots: markdown preview', () => {
  for (const { lang, theme } of MATRIX) {
    it(`markdown-preview ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      // マニュアルの alt「Markdown プレビュー（Split）」に合わせ、Edit と Preview を
      // 並べた Split 表示で撮る。
      await openEditor({ path: 'README.md', content: MD_SAMPLE, viewMode: 'split' })
      await $('.preview-pane').waitForDisplayed({ timeout: 10_000 })
      await shoot('markdown-preview', lang, theme)
    })
  }
})

describe('screenshots: outline panel', () => {
  for (const { lang, theme } of MATRIX) {
    it(`outline-panel ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      // アウトラインは EditorTab が登録する CodeMirror View から抽出するため、
      // edit モード（View が生きている）で開いてからパネルを開く。
      await openEditor({ path: 'src/stores/tasks.ts', content: TS_SAMPLE })
      await $('.cm-editor').waitForDisplayed({ timeout: 10_000 })
      await openPanel('outline')
      await $('[data-testid="outline-panel"]').waitForDisplayed({ timeout: 10_000 })
      await $('[data-testid="outline-panel"] .tree-item').waitForDisplayed({ timeout: 10_000 })
      await shoot('outline-panel', lang, theme)
    })
  }
})

// --- エディタ上のコンフリクト解消（#223） -----------------------------------
// マーカー行を含むファイルを開くだけで、各領域の上にボタン列（ours / theirs /
// 両方）とファイル全体の一括適用バーが出る。invoke のモックは要らない。
const CONFLICT_SAMPLE = [
  "import { defineStore } from 'pinia'",
  '',
  'export const useTaskStore = defineStore("tasks", () => {',
  '  const tasks = ref<Task[]>([])',
  '',
  '<<<<<<< HEAD',
  '  // 実行中のタスクを 1 つだけ許す',
  '  const running = ref<string | null>(null)',
  '=======',
  '  // 複数のタスクを同時に走らせる',
  '  const running = ref<string[]>([])',
  '>>>>>>> feature/parallel-tasks',
  '',
  '  function reset() {',
  '    tasks.value = []',
  '  }',
  '',
  '  return { tasks, running, reset }',
  '})',
  '',
].join('\n')

describe('screenshots: conflict resolution', () => {
  for (const { lang, theme } of MATRIX) {
    it(`editor-conflict ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openEditor({ path: 'src/stores/tasks.ts', content: CONFLICT_SAMPLE })
      await $('.cm-editor').waitForDisplayed({ timeout: 10_000 })
      // 領域ごとのボタンが出るまで待つ（decoration の構築は 1 フレーム遅れる）。
      await $('.cm-conflict-btn').waitForDisplayed({ timeout: 10_000 })
      await shoot('editor-conflict', lang, theme)
    })
  }
})

// --- blame（#510）-----------------------------------------------------------
// blame は実ファイルのタブにしか出ない（`initialContent` で開いたタブは対象外）ので、
// `fs_read_file` をモックしてディスクから開く形にする。`TS_SAMPLE` の 24 行に、最初の版・
// 2 つの追加・未コミットの 1 行を割り当てる。日時は相対で出るので、撮った時刻から逆算する。
const BLAME_PATH = 'C:/Users/dev/demo-app/src/stores/tasks.ts'
const DAY = 24 * 60 * 60

function blameFixture() {
  const now = Math.floor(Date.now() / 1000)
  const commits = [
    { hash: 'a1'.repeat(20), author: 'Aoi Sato', time: now - 21 * DAY, summary: 'feat: タスクのストアを足す', uncommitted: false },
    { hash: 'b2'.repeat(20), author: 'Ren Ito', time: now - 5 * DAY, summary: 'feat: 終わっていないタスクを数える', uncommitted: false },
    { hash: 'c3'.repeat(20), author: 'Aoi Sato', time: now - 2 * DAY, summary: 'feat: タスクの完了を記録する', uncommitted: false },
    { hash: '0'.repeat(40), author: 'Not Committed Yet', time: now, summary: '', uncommitted: true },
  ]
  // 1〜11 行が最初の版、12 行（pending）が 2 つ目、15 行が未コミット、18〜23 行（complete と return）が 3 つ目
  const lines = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 3, 0, 0, 2, 2, 2, 2, 2, 2, 0]
  return { commits, lines }
}

describe('screenshots: blame', () => {
  for (const { lang, theme } of MATRIX) {
    it(`editor-blame ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await mockInvoke('fs_read_file', { content: TS_SAMPLE, encoding: 'UTF-8', isNew: false })
      await mockInvoke('git_blame', blameFixture())
      await browser.execute((p) => {
        ;(
          window as unknown as { __pikeE2E?: { openEditorFromDisk?: (p: string) => void } }
        ).__pikeE2E?.openEditorFromDisk?.(p)
      }, BLAME_PATH)
      await $('.cm-editor').waitForDisplayed({ timeout: 10_000 })
      // 行頭（ファイル全体）と行末（カーソルのある 1 行目）の両方を出す
      for (const kind of ['gutter', 'inline'] as const) {
        await browser.execute(async (k) => {
          await (
            window as unknown as { __pikeE2E?: { toggleBlame?: (k: string) => Promise<void> } }
          ).__pikeE2E?.toggleBlame?.(k)
        }, kind)
      }
      await $('.cm-blame-gutter-text').waitForDisplayed({ timeout: 10_000 })
      await $('.cm-blame-inline').waitForDisplayed({ timeout: 10_000 })
      await shoot('editor-blame', lang, theme)
    })
  }
})
