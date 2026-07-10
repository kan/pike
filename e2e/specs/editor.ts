import { MATRIX, openEditor, openPanel, prepare, setFakeProject, shoot } from '../support/prepare'

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
  '## 設定',
  '',
  '| 項目 | 既定 | 説明 |',
  '| --- | --- | --- |',
  '| `theme` | `dark` | カラースキーム |',
  '| `fontSize` | `14` | ターミナルのフォントサイズ |',
  '',
].join('\n')

describe('screenshots: editor', () => {
  for (const { lang, theme } of MATRIX) {
    it(`editor ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openEditor({ path: 'src/stores/tasks.ts', content: TS_SAMPLE })
      await $('.cm-editor').waitForDisplayed({ timeout: 10_000 })
      await shoot('editor', lang, theme)
    })
  }
})

describe('screenshots: markdown preview', () => {
  for (const { lang, theme } of MATRIX) {
    it(`markdown-preview ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openEditor({ path: 'README.md', content: MD_SAMPLE, viewMode: 'preview' })
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
