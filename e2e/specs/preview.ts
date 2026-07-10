import { MATRIX, openEditor, prepare, setFakeProject, shoot } from '../support/prepare'

// EditorTab のプレビュー派生（CSV / JSON / Mermaid / SVG）を撮影する。
// いずれも openEditor（initialContent 経路）＋ viewMode:'preview' で描画できるため
// invoke モックもフロント変更も不要（EditorTab が拡張子で描画を分岐する）。

const CSV_SAMPLE = [
  'name,role,commits,active',
  'Kan Fushihara,Maintainer,1240,true',
  'Alice,Contributor,87,true',
  'Bob,Contributor,42,false',
  'Carol,Reviewer,15,true',
  '',
].join('\n')

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
      await shoot('csv-preview', lang, theme)
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
