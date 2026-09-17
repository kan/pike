import { MATRIX, mockInvoke, openEditor, prepare, setFakeProject, shoot } from '../support/prepare'

// EditorTab のプレビュー派生（CSV / JSON / Mermaid / SVG）を撮影する。
// いずれも openEditor（initialContent 経路）＋ viewMode:'preview' で描画できるため
// invoke モックもフロント変更も不要（EditorTab が拡張子で描画を分岐する）。

// ページの帯（とコピーの注意書き）が出るよう、既定の表示件数（1,000 行）を超える行数にする。
// 値は行番号から決まるので、撮るたびに同じ表になる。
const CSV_NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi']
const CSV_ROLES = ['Maintainer', 'Contributor', 'Reviewer']
const CSV_SAMPLE = [
  'name,role,commits,active',
  ...Array.from({ length: 1234 }, (_, i) => {
    const name = `${CSV_NAMES[i % CSV_NAMES.length]} ${String.fromCharCode(65 + ((i * 7) % 26))}.`
    return `${name},${CSV_ROLES[(i * 5) % CSV_ROLES.length]},${(i * 37) % 1500},${i % 3 !== 0}`
  }),
  '',
].join('\n')

/** プレビューの中の要素を DOM から押す（表の操作はプレビューのクリックの委譲で受ける）。 */
async function clickInPreview(selector: string): Promise<void> {
  await browser.execute((sel) => {
    ;(document.querySelector(sel) as HTMLElement | null)?.click()
  }, selector)
  await browser.pause(150)
}

const JSON_SAMPLE = [
  '{',
  '  "name": "demo-app",',
  '  "version": "0.23.2",',
  '  "private": true,',
  '  "scripts": {',
  '    "dev": "vite",',
  '    "build": "vue-tsc --noEmit && vite build",',
  '    "lint": "biome check src/"',
  '  },',
  '  "dependencies": {',
  '    "vue": "^3.5.0",',
  '    "pinia": "^2.2.0"',
  '  }',
  '}',
  '',
].join('\n')

const MERMAID_SAMPLE = [
  'flowchart TD',
  '  A[起動] --> B{プロジェクトあり?}',
  '  B -->|Yes| C[セッション復元]',
  '  B -->|No| D[プロジェクト選択]',
  '  C --> E[タブ表示]',
  '  D --> E',
  '',
].join('\n')

const SVG_SAMPLE = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 120" width="260" height="120">',
  '  <rect x="12" y="12" width="96" height="96" rx="14" fill="#4f46e5" />',
  '  <circle cx="180" cy="60" r="46" fill="#06b6d4" />',
  '  <text x="130" y="112" font-size="13" text-anchor="middle" fill="#64748b">Pike SVG preview</text>',
  '</svg>',
  '',
].join('\n')

describe('screenshots: csv preview', () => {
  for (const { lang, theme } of MATRIX) {
    it(`csv-preview ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openEditor({ path: 'contributors.csv', content: CSV_SAMPLE, viewMode: 'preview' })
      await $('.csv-preview table').waitForDisplayed({ timeout: 10_000 })
      // commits 列（`#` を数えない 2 列目）を降順に並べ、role 列を選んだ状態で撮る。
      // 並べ替えのボタンは 1 回目が昇順、2 回目が降順。
      await clickInPreview('.csv-preview [data-csv-sort="2"]')
      await clickInPreview('.csv-preview [data-csv-sort="2"]')
      await $('.csv-preview [data-csv-sort="2"][data-dir="desc"]').waitForExist({ timeout: 10_000 })
      // 見出しのセルは `#` 列が 0 なので、role 列は 2 番目。
      await clickInPreview('.csv-preview thead th:nth-child(3) .csv-th-label')
      await shoot('csv-preview', lang, theme)
    })
  }
})

// エディタで開ける上限を超えたファイル（#362）。読み込みを `fs_read_file` のモックに任せ、
// `tooLarge` を返して開き方を選ぶ画面を出す。
describe('screenshots: editor too large', () => {
  for (const { lang, theme } of MATRIX) {
    it(`editor-too-large ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await mockInvoke('fs_read_file', { content: '', encoding: 'UTF-8', isNew: false, tooLarge: 48_300_000 })
      await browser.execute((p) => {
        ;(
          window as unknown as { __pikeE2E?: { openEditorFromDisk?: (p: string) => void } }
        ).__pikeE2E?.openEditorFromDisk?.(p)
      }, '/home/demo/demo-app/logs/access.log')
      await $('.editor-status.choices').waitForDisplayed({ timeout: 10_000 })
      await shoot('editor-too-large', lang, theme)
    })
  }
})

describe('screenshots: json preview', () => {
  for (const { lang, theme } of MATRIX) {
    it(`json-preview ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openEditor({ path: 'package.json', content: JSON_SAMPLE, viewMode: 'preview' })
      await $('.json-preview').waitForDisplayed({ timeout: 10_000 })
      await shoot('json-preview', lang, theme)
    })
  }
})

describe('screenshots: mermaid preview', () => {
  for (const { lang, theme } of MATRIX) {
    it(`mermaid-preview ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openEditor({ path: 'flow.mermaid', content: MERMAID_SAMPLE, viewMode: 'preview' })
      // mermaid はライブラリ遅延 import + 非同期 render。SVG 生成まで待つ。
      await $('.mermaid-preview svg').waitForDisplayed({ timeout: 15_000 })
      await shoot('mermaid-preview', lang, theme)
    })
  }
})

describe('screenshots: svg preview', () => {
  for (const { lang, theme } of MATRIX) {
    it(`svg-preview ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openEditor({ path: 'logo.svg', content: SVG_SAMPLE, viewMode: 'preview' })
      await $('.svg-preview svg').waitForDisplayed({ timeout: 10_000 })
      await shoot('svg-preview', lang, theme)
    })
  }
})
