<script setup lang="ts">
/**
 * HTML ファイルのプレビュー（#399）。エディタの Preview / Split に、ブラウザのタブ（#368）と
 * 同じ子 webview を重ねる。重ねる・隠す・閉じるは `useChildWebview`、配信は Rust の
 * `html_preview.rs`（`pike-preview` のスキーム）、器は `PreviewFrame`（Vue SFC のプレビューと共有）。
 *
 * **描くのはディスクの中身で、エディタの本文ではない。** 相対パスの CSS・画像・スクリプトを
 * 同じ origin で読ませるには、ファイルをその場所から配信するのがいちばん素直なため。
 * 保存したら描き直す（段取りは `usePreviewRefresh`。Vue SFC のプレビューと共有）。
 *
 * **スクロール位置は戻らない**（`location.reload()` 任せ）。戻すにはページから `scrollY` を
 * 読む口が要り、子 webview は capability の対象外で `invoke` が通らない（#399 で見送った）。
 *
 * 配信の範囲は、ファイルがプロジェクトの下にあればプロジェクトのルート（`/css/a.css` の
 * ようなルート起点の参照がそこで解決する）、外にあればそのファイルのディレクトリ。
 * プレビューの中のリンクをブラウザのタブへ逃がすのは Rust（間引きも向こう）。
 */

import { computed, ref, useTemplateRef, watch } from 'vue'
import { previewWebviewOptions, useChildWebview } from '../../composables/useChildWebview'
import { usePreviewRefresh } from '../../composables/usePreviewRefresh'
import { basename, dirname } from '../../lib/paths'
import type { ProjectPlatform } from '../../lib/projectPaths'
import { relativeToBase } from '../../lib/projectPaths'
import { browserHistory, previewOpen } from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { shellToPlatform } from '../../types/tab'
import PreviewFrame from './PreviewFrame.vue'

const props = defineProps<{
  tabId: string
  path: string
  /**
   * スマートフォンの縦長の画面で見る。枠の大きさを絞るだけで UA は変えない（ブラウザのタブ
   * と同じ判断。CSS のメディアクエリは表示の幅で切り替わる）。枠の大きさが変わるので、
   * 位置合わせは `useChildWebview` の ResizeObserver が拾う。
   */
  mobile?: boolean
}>()
const projectStore = useProjectStore()

const frame = useTemplateRef<{ host: HTMLElement | null }>('frame')
const error = ref<string | null>(null)

/**
 * 配信しているルート。**子 webview を作った時点で固定する**（開いたあとにプロジェクトを
 * 切り替えても、このタブの配信先は変わらない）。まだ作っていなければ null。
 */
const served = ref<{ root: string; platform: ProjectPlatform } | null>(null)

/** 配信のルートとシェル、開く相対パス。 */
function place() {
  const shell = projectStore.shellForIO
  const platform = shellToPlatform(shell)
  const root = projectStore.activeRoot
  const underRoot = root ? relativeToBase(root, props.path, platform) : null
  if (underRoot !== null) return { shell, platform, root, entry: underRoot }
  return { shell, platform, root: dirname(props.path), entry: basename(props.path) }
}

const view = useChildWebview({
  ...previewWebviewOptions(props.tabId),
  el: computed(() => frame.value?.host),
  create: async (label, bounds) => {
    const { shell, platform, root, entry } = place()
    await previewOpen(label, root, shell, entry, bounds)
    served.value = { root, platform }
  },
  onError: (e) => (error.value = e),
})

/**
 * Save As で別のファイルになったら作り直す。配信のルートと開くパスは作った時点で
 * 固定しているので、そのままだと元のファイルを描き続ける。
 */
watch(
  () => props.path,
  () => view.recreate(),
)

/** 描き直す契機にする拡張子（ページが読むもの）。 */
const WEB_ASSET = /\.(html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm)$/i

/**
 * 配信しているルートの下の、ページが読みうるファイルが変わったら再読み込みする。HTML 自身に
 * 限らない（CSS や JS を直したときも結果が変わる）。**エージェントが `.ts` や `.rs` を
 * 書いているあいだに描き直し続けない**よう、拡張子で絞る（`node_modules` などは監視の側が
 * 最初から捨てている）。いつ描き直すかは `usePreviewRefresh`。
 */
const { onSaved } = usePreviewRefresh({
  view,
  served,
  accepts: (path) => WEB_ASSET.test(path),
  refresh: () => {
    browserHistory(view.label(), 'reload')
      .then(() => (error.value = null))
      .catch((e) => (error.value = String(e)))
  },
})

/**
 * 隠しているあいだの案内を先に出す。エラーは子 webview を作れなかったとき（その場に
 * ページが無いとき）にしか目に入らないので、隠している理由のほうが大事。
 */
const message = computed(() => view.hiddenNotice.value || error.value)

defineExpose({ onSaved })
</script>

<template>
  <PreviewFrame ref="frame" :mobile="mobile" :message="message" :error="!!error" />
</template>
