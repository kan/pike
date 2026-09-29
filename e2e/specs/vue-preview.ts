import { MATRIX, mockInvoke, openEditor, prepare, setFakeProject, shoot } from '../support/prepare'

// Vue の SFC のプレビュー（#397）を撮る（#418）。
//
// **子 webview はスクリーンショットに写らない。** 撮影は WebDriver が Pike 本体の webview の
// DOM を撮るもので、プレビューを描く子 webview（`Window::add_child` のネイティブの webview）は
// 別物なので入らない。そこで子 webview を作る側のコマンドはモックで空振りさせ、プレビューの枠
// （`.preview-frame-host`）に、vue-preview の出力に見立てた HTML を iframe で置いて撮る。
// 撮影機には vue-preview も無いので、描いた結果はどのみち用意したものになる。帯・フォーム・
// エディタは本物。
//
// vue-preview の有無の答えは 60 秒覚える（`stores/vuePreview.ts` の `ASK_TTL`）ので、モックを
// 差し替えたら `redetectVuePreview` で聞き直す。**エディタを開く前に聞く**: 開いた時点で
// 答えが無いと、Split の右がプレビューにならない。

const SFC_PATH = 'C:/Users/dev/demo-app/src/components/UserCard.vue'

const SFC_SOURCE = [
  '<script setup lang="ts">',
  "import type { User } from '../types'",
  "import { useUserStats } from '../composables/useUserStats'",
  '',
  'const props = defineProps<{ user: User; compact?: boolean }>()',
  'const { followers } = useUserStats(props.user.id)',
  '</script>',
  '',
  '<template>',
  '  <article class="card" :class="{ compact }">',
  '    <img class="avatar" :src="user.avatarUrl" alt="" />',
  '    <div class="body">',
  '      <h2>{{ user.name }}</h2>',
  '      <p class="role">{{ user.role }}</p>',
  '      <p v-if="!compact" class="bio">{{ user.bio }}</p>',
  "      <p class=\"meta\">{{ followers }} {{ $t('user.followers') }}</p>",
  '    </div>',
  '    <button class="follow">{{ $t(\'user.follow\') }}</button>',
  '  </article>',
  '</template>',
  '',
  '<style scoped>',
  '.card {',
  '  display: flex;',
  '  gap: 16px;',
  '  padding: 20px;',
  '  border: 1px solid #e2e8f0;',
  '  border-radius: 12px;',
  '}',
  '.avatar {',
  '  width: 56px;',
  '  height: 56px;',
  '  border-radius: 50%;',
  '  background: #c7d2fe;',
  '}',
  '</style>',
  '',
].join('\n')

/**
 * vue-preview の出力に見立てたページ。値を与えていない参照はプレースホルダ（参照式の末尾を
 * `{{ }}` で囲んだもの）で描かれる。文言（`$t`）は i18n のファイルから引かれる。
 */
const PREVIEW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 32px; font-family: system-ui, sans-serif; background: #fff; color: #0f172a; }
  .card { display: flex; gap: 16px; align-items: flex-start; max-width: 460px; padding: 20px;
    border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06); }
  .avatar { flex-shrink: 0; width: 56px; height: 56px; border-radius: 50%; background: #c7d2fe; }
  .body { flex: 1; min-width: 0; }
  h2 { margin: 0 0 4px; font-size: 18px; }
  p { margin: 0 0 6px; font-size: 14px; }
  .role { color: #64748b; }
  .bio { color: #334155; line-height: 1.6; }
  .meta { color: #64748b; font-size: 13px; }
  .follow { flex-shrink: 0; padding: 6px 14px; border: 1px solid #4f46e5; border-radius: 999px;
    background: #fff; color: #4f46e5; font-size: 13px; }
  .ph { padding: 0 3px; border-radius: 3px; background: #fef3c7; color: #92400e;
    font-family: ui-monospace, monospace; font-size: 0.9em; }
</style></head><body>
  <article class="card">
    <div class="avatar"></div>
    <div class="body">
      <h2><span class="ph">{{ name }}</span></h2>
      <p class="role"><span class="ph">{{ role }}</span></p>
      <p class="bio"><span class="ph">{{ bio }}</span></p>
      <p class="meta"><span class="ph">{{ followers }}</span> フォロワー</p>
    </div>
    <button class="follow">フォロー</button>
  </article>
</body></html>`

/** vue-preview が返す「fixture で与えられるもの」。フォームの欄になる。 */
const INPUTS = {
  props: [
    { name: 'user', types: ['User'] },
    { name: 'compact', types: ['Boolean'], default: false },
  ],
  values: [{ name: 'followers' }],
  fixture: null,
}

/** 子 webview を作る・置く・描き直すコマンドを空振りさせ、描画の結果だけを返す。 */
async function mockVuePreview(available: 'found' | 'missing'): Promise<void> {
  await mockInvoke('vue_preview_available', available)
  await mockInvoke('vue_preview_render', { deps: [], warnings: [], inputs: INPUTS })
  // 描画のルート（いちばん近い package.json）。実物を探しに行かせない。
  await mockInvoke('fs_resolve_first_existing', 'C:/Users/dev/demo-app/package.json')
  for (const cmd of ['preview_open', 'preview_set_files', 'browser_place', 'browser_history', 'browser_close']) {
    await mockInvoke(cmd, null)
  }
  await browser.execute(async () => {
    await (
      window as unknown as { __pikeE2E?: { redetectVuePreview?: () => Promise<void> } }
    ).__pikeE2E?.redetectVuePreview?.()
  })
}

/** 子 webview の代わりに、プレビューの枠へ iframe を置く（上のコメント）。 */
async function placePreviewPage(): Promise<void> {
  await browser.execute((html) => {
    const host = document.querySelector('.preview-frame-host')
    if (!host) return
    host.querySelector('iframe[data-e2e-preview]')?.remove()
    const frame = document.createElement('iframe')
    frame.dataset.e2ePreview = ''
    frame.srcdoc = html
    frame.style.cssText = 'flex: 1; align-self: stretch; border: 0; background: #fff;'
    host.appendChild(frame)
  }, PREVIEW_HTML)
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () =>
          (document.querySelector('iframe[data-e2e-preview]') as HTMLIFrameElement | null)?.contentDocument
            ?.readyState === 'complete',
      )) === true,
    { timeout: 10_000, timeoutMsg: 'preview iframe did not load' },
  )
}

async function openVuePreview(lang: 'ja' | 'en', theme: 'light' | 'dark'): Promise<void> {
  await prepare({ lang, theme })
  await setFakeProject()
  await mockVuePreview('found')
  await openEditor({ path: SFC_PATH, content: SFC_SOURCE, viewMode: 'split' })
  // 描画のモックが返ると、上の帯に「値を入れる」が出る。ビルド直後の初回は 10 秒で
  // 足りなかったことがあるので長めに待つ。
  await $('.vue-preview-bar').waitForDisplayed({ timeout: 30_000 })
  await placePreviewPage()
}

describe('screenshots: vue preview', () => {
  for (const { lang, theme } of MATRIX) {
    it(`vue-preview ${lang} ${theme}`, async () => {
      await openVuePreview(lang, theme)
      await shoot('vue-preview', lang, theme)
    })
  }
})

describe('screenshots: vue preview form', () => {
  for (const { lang, theme } of MATRIX) {
    it(`vue-preview-form ${lang} ${theme}`, async () => {
      await openVuePreview(lang, theme)
      // 帯の「値を入れる」。警告が無いので、帯のボタンはこれ 1 つだけ。
      await browser.execute(() => {
        ;(document.querySelector('.vue-preview-bar .vue-preview-link') as HTMLElement | null)?.click()
      })
      await $('.vue-preview-form').waitForDisplayed({ timeout: 10_000 })
      await shoot('vue-preview-form', lang, theme)
    })
  }
})

describe('screenshots: vue preview install', () => {
  for (const { lang, theme } of MATRIX) {
    it(`vue-preview-install ${lang} ${theme}`, async () => {
      await prepare({ lang, theme })
      await setFakeProject()
      await mockVuePreview('missing')
      await openEditor({ path: SFC_PATH, content: SFC_SOURCE, viewMode: 'split' })
      await $('.vue-preview-install').waitForDisplayed({ timeout: 10_000 })
      await shoot('vue-preview-install', lang, theme)
    })
  }
})
