<script setup lang="ts">
/**
 * Vue SFC のプレビュー（#397）。外部コマンド `vue-preview` が描いた 1 枚の HTML を、HTML の
 * プレビュー（#399）と同じ子 webview の仮想ファイル（`VUE_PREVIEW_ENTRY`）として出す。
 * 置くのは Rust（`vue_preview_render`。HTML は IPC を通らない）。重ねる・隠す・閉じるは
 * `useChildWebview`、いつ描き直すかは `usePreviewRefresh`、器は `PreviewFrame`（どれも
 * `HtmlPreview.vue` と共有）。
 *
 * **描くのは保存したファイル**（vue-preview がディスクから読む）。描き直す契機は、前回の結果の
 * `deps`（子コンポーネント・CSS・fixture・設定）の変化。
 *
 * **描画のルートは SFC からいちばん近い `package.json` のディレクトリ**（vue-preview の
 * `--root` = cwd。node_modules、または依存キャッシュの元になるロックファイルがある場所）。
 * プロジェクトのルートとは限らない（`app/` の下に Vue を置くリポジトリがある）。
 *
 * 描いているあいだも前の結果を出したままにし、上の帯に「描画中」を出す（初回は依存の
 * install で数十秒かかることがある）。警告はその帯に件数を出し、押すと一覧を開く。
 */

import { AlertTriangle, LoaderCircle } from 'lucide-vue-next'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { previewWebviewOptions, useChildWebview } from '../../composables/useChildWebview'
import { usePreviewRefresh } from '../../composables/usePreviewRefresh'
import { useI18n } from '../../i18n'
import { findNearestUpward } from '../../lib/jumpTo/resolveImport'
import { basename, dirname, pathSep } from '../../lib/paths'
import type { ProjectPlatform } from '../../lib/projectPaths'
import { relativeToBase } from '../../lib/projectPaths'
import { browserHistory, previewOpen, previewSetFiles, type VueRender, vuePreviewRender } from '../../lib/tauri'
import { affectsVuePreview, VUE_PREVIEW_ENTRY, vuePreviewMessagePage } from '../../lib/vuePreview'
import { useProjectStore } from '../../stores/project'
import { type ShellType, shellToPlatform } from '../../types/tab'
import PreviewFrame from './PreviewFrame.vue'

const props = defineProps<{
  tabId: string
  path: string
  /** スマートフォンの縦長の画面で見る（`HtmlPreview` と同じ）。 */
  mobile?: boolean
}>()
const { t } = useI18n()
const projectStore = useProjectStore()

const frame = useTemplateRef<{ host: HTMLElement | null }>('frame')
const error = ref<string | null>(null)

/** 描いている SFC。**子 webview を作った時点で固定する**（`HtmlPreview` の `served` と同じ）。 */
const served = ref<{ root: string; platform: ProjectPlatform; shell: ShellType; rel: string } | null>(null)

/** 前回の結果に効いたファイル（ルートからの相対パス）。 */
let deps: ReadonlySet<string> = new Set()
const warnings = ref<string[]>([])
const showWarnings = ref(false)
const rendering = ref(false)

const view = useChildWebview({
  ...previewWebviewOptions(props.tabId),
  el: computed(() => frame.value?.host),
  create: async (label, bounds) => {
    const shell = projectStore.shellForIO
    const platform = shellToPlatform(shell)
    // 描画のルートは SFC からいちばん近い package.json のディレクトリ（`app/` の下に Vue を
    // 置くリポジトリがある）。探すのは今のプロジェクトのルートまでで、外のファイルは自分の木を
    // 辿る。見つからなければ SFC の隣を渡し、無いことは vue-preview に言わせる。
    const manifest = await findNearestUpward(props.path, projectStore.activeRoot ?? '', pathSep(shell), shell, [
      'package.json',
    ])
    const root = dirname(manifest ?? props.path)
    const rel = relativeToBase(root, props.path, platform) ?? basename(props.path)
    const page = { path: VUE_PREVIEW_ENTRY, content: vuePreviewMessagePage(t('vuePreview.rendering')) }
    await previewOpen(label, root, shell, VUE_PREVIEW_ENTRY, bounds, [page])
    served.value = { root, platform, shell, rel }
    void render()
  },
  onError: (e) => (error.value = e),
  onReset: () => {
    served.value = null
    deps = new Set()
    warnings.value = []
  },
})

/** Save As で別のファイルになったら作り直す（`HtmlPreview` と同じ理由）。 */
watch(
  () => props.path,
  () => view.recreate(),
)

/**
 * 描いて置き直す。**走っているあいだの要求は 1 回に畳んで、終わってから描き直す**
 * （描画は外部プロセスで 1 秒弱かかる。重ねて起こすと、古い結果が後から届いて勝つ）。
 */
let again = false
async function render() {
  if (rendering.value) {
    again = true
    return
  }
  const s = served.value
  if (!s) return
  rendering.value = true
  try {
    await renderOnce(s)
  } finally {
    rendering.value = false
  }
  // **結果を捨てた回でも見る**: 描いているあいだに作り直すと、新しい子 webview の最初の
  // 要求はここに畳まれている。
  if (again) {
    again = false
    void render()
  }
}

async function renderOnce(s: NonNullable<typeof served.value>) {
  const label = view.label()
  let result: VueRender | null = null
  let failure: string | null = null
  try {
    result = await vuePreviewRender(s.shell, s.root, s.rel, label, VUE_PREVIEW_ENTRY)
  } catch (e) {
    failure = String(e)
  }
  // 描いているあいだに作り直した・閉じた: この結果は別の子 webview のもの。
  if (view.disposed() || served.value !== s) return
  // 失敗しても前回の deps は残す（直して保存したときに描き直せるように）。
  if (result) deps = new Set(result.deps)
  warnings.value = result?.warnings ?? []
  try {
    if (failure !== null) {
      const page = vuePreviewMessagePage(t('vuePreview.failed'), failure)
      await previewSetFiles(label, [{ path: VUE_PREVIEW_ENTRY, content: page }])
    }
    await browserHistory(label, 'reload')
    error.value = null
  } catch (e) {
    error.value = String(e)
  }
}

const { onSaved } = usePreviewRefresh({
  view,
  served,
  affects: (rel, s) => affectsVuePreview(rel, s.rel, deps),
  refresh: () => void render(),
})

const message = computed(() => view.hiddenNotice.value || error.value)

defineExpose({ onSaved })
</script>

<template>
  <PreviewFrame ref="frame" :mobile="mobile" :message="message" :error="!!error">
    <template #bar>
      <div v-if="rendering || warnings.length" class="vue-preview-bar">
        <span v-if="rendering" class="vue-preview-status">
          <LoaderCircle :size="12" class="spin" />{{ t('vuePreview.renderingShort') }}
        </span>
        <button v-if="warnings.length" class="vue-preview-warnings" @click="showWarnings = !showWarnings">
          <AlertTriangle :size="12" />{{ t('vuePreview.warnings', { count: warnings.length }) }}
        </button>
      </div>
      <ul v-if="showWarnings && warnings.length" class="vue-preview-warning-list">
        <li v-for="(w, i) in warnings" :key="i">{{ w }}</li>
      </ul>
    </template>
  </PreviewFrame>
</template>

<style scoped>
.vue-preview-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

.vue-preview-status,
.vue-preview-warnings {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.vue-preview-warnings {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.vue-preview-warning-list {
  margin: 0;
  padding: 4px 8px 4px 24px;
  max-height: 30%;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
  user-select: text;
}
</style>
