import { MATRIX, mockInvoke, openDiff, openHistory, openImage, prepare, setFakeProject, shoot } from '../support/prepare'

// 画像ビューワ / 差分 / ファイル履歴を撮影する。
// 画像は dataUrl 直指定、diff は unified diff 文字列直指定で invoke 不要。
// history のみ git_log_file をモックする。

// --- 画像ビューワ -----------------------------------------------------------
// SVG を data URL にして <img> で表示する（raster 画像の代替。width/height を持つので
// naturalWidth も定まる）。
const IMAGE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="280" viewBox="0 0 420 280">',
  '  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
  '    <stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#06b6d4"/>',
  '  </linearGradient></defs>',
  '  <rect width="420" height="280" fill="url(#g)"/>',
  '  <circle cx="130" cy="140" r="70" fill="#ffffff" opacity="0.85"/>',
  '  <rect x="230" y="80" width="120" height="120" rx="18" fill="#ffffff" opacity="0.85"/>',
  '  <text x="210" y="255" font-size="20" font-family="sans-serif" text-anchor="middle" fill="#ffffff">Pike image viewer</text>',
  '</svg>',
].join('')
const IMAGE_DATA_URL = `data:image/svg+xml,${encodeURIComponent(IMAGE_SVG)}`

describe('screenshots: image viewer', () => {
  for (const { lang, theme } of MATRIX) {
    it(`image-viewer ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openImage({ path: 'assets/banner.png', dataUrl: IMAGE_DATA_URL })
      await $('.preview-tab img').waitForDisplayed({ timeout: 10_000 })
      await shoot('image-viewer', lang, theme)
    })
  }
})

// --- 差分タブ ---------------------------------------------------------------
const DIFF_SAMPLE = [
  'diff --git a/src/lib/format.ts b/src/lib/format.ts',
  'index 1234567..89abcde 100644',
  '--- a/src/lib/format.ts',
  '+++ b/src/lib/format.ts',
  '@@ -1,9 +1,10 @@',
  ' export function formatTokens(n: number): string {',
  '   if (n < 1000) return String(n)',
  '   if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`',
  '-  return `${(n / 1_000_000).toFixed(1)}M`',
  '+  return `${(n / 1_000_000).toFixed(2)}M`',
  ' }',
  ' ',
  ' export function formatCost(usd: number): string {',
  '-  return `$${usd.toFixed(2)}`',
  '+  if (usd < 0.01) return `<$0.01`',
  '+  return `$${usd.toFixed(2)}`',
  ' }',
  '',
].join('\n')

describe('screenshots: diff tab', () => {
  for (const { lang, theme } of MATRIX) {
    it(`diff-tab ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await openDiff({ filePath: 'src/lib/format.ts', diff: DIFF_SAMPLE })
      await $('.diff-row').waitForDisplayed({ timeout: 10_000 })
      await shoot('diff-tab', lang, theme)
    })
  }
})

// --- ファイル履歴タブ -------------------------------------------------------
const FILE_LOG = [
  {
    hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    parents: ['b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1'],
    refs: 'HEAD -> main',
    author: 'Kan Fushihara',
    date: '2026-01-06 14:32',
    message: 'feat: トークン数のフォーマットを M 単位まで対応',
  },
  {
    hash: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
    parents: ['c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2'],
    refs: '',
    author: 'Kan Fushihara',
    date: '2026-01-04 10:05',
    message: 'refactor: format ヘルパーを lib へ切り出し',
  },
  {
    hash: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
    parents: [],
    refs: 'v0.23.0',
    author: 'Kan Fushihara',
    date: '2026-01-02 21:40',
    message: 'chore: 初期化',
  },
]

describe('screenshots: history tab', () => {
  for (const { lang, theme } of MATRIX) {
    it(`history-tab ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await mockInvoke('git_log_file', FILE_LOG)
      await setFakeProject()
      await openHistory({ filePath: 'src/lib/format.ts' })
      await $('.commit-row').waitForDisplayed({ timeout: 10_000 })
      await shoot('history-tab', lang, theme)
    })
  }
})
