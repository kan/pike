// Vue SFC のプレビュー（#397）の純粋な部分。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { affectsVuePreview, fixtureOf, vuePreviewMessagePage } from '../src/lib/vuePreview.ts'

test('fixture は SFC の隣の <name>.preview.json', () => {
  assert.equal(fixtureOf('src/components/UserTable.vue'), 'src/components/UserTable.preview.json')
})

test('描き直すのは SFC 自身・前回の deps・まだ無い fixture と設定ファイル', () => {
  const entry = 'src/components/UserPage.vue'
  const deps = new Set(['src/components/UserPage.vue', 'src/components/StatusBadge.vue', 'src/styles/main.css'])
  for (const rel of [
    entry,
    'src/components/StatusBadge.vue',
    'src/styles/main.css',
    'src/components/UserPage.preview.json',
    'vue-preview.config.json',
  ]) {
    assert.equal(affectsVuePreview(rel, entry, deps), true, rel)
  }
  for (const rel of ['src/components/Other.vue', 'src/main.ts', 'src/vue-preview.config.json']) {
    assert.equal(affectsVuePreview(rel, entry, deps), false, rel)
  }
})

test('案内のページは本文を HTML として解釈しない', () => {
  const page = vuePreviewMessagePage('失敗', '<script>alert(1)</script> & "x"')
  assert.ok(!page.includes('<script>alert'))
  assert.ok(page.includes('&#60;script&#62;alert(1)&#60;/script&#62; &#38; &#34;x&#34;'))
  assert.ok(!vuePreviewMessagePage('描画中').includes('<pre>'))
})
