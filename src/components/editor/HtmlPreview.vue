<script setup lang="ts">
/**
 * HTML ファイルのプレビュー（#399）。エディタの Preview / Split に、ブラウザのタブ（#368）と
 * 同じ子 webview を重ねる。重ねる・隠す・閉じるは `useChildWebview`、配信は Rust の
 * `html_preview.rs`（`pike-preview` のスキーム）。
 *
 * **描くのはディスクの中身で、エディタの本文ではない。** 相対パスの CSS・画像・スクリプトを
 * 同じ origin で読ませるには、ファイルをその場所から配信するのがいちばん素直なため。
 * 保存したら描き直す。
 *
 * **スクロール位置は戻らない**（`location.reload()` 任せ）。戻すにはページから `scrollY` を
 * 読む口が要り、子 webview は capability の対象外で `invoke` が通らない（#399 で見送った）。
 *
 * 配信の範囲は、ファイルがプロジェクトの下にあればプロジェクトのルート（`/css/a.css` の
 * ようなルート起点の参照がそこで解決する）、外にあればそのファイルのディレクトリ。
 * プレビューの中のリンクをブラウザのタブへ逃がすのは Rust（間引きも向こう）。
 */

import { computed, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useChildWebview } from '../../composables/useChildWebview'
import { fsWatcher } from '../../composables/useFsWatcher'
import { basename, dirname } from '../../lib/paths'
import type { ProjectPlatform } from '../../lib/projectPaths'
import { isSameOrUnder, relativeToBase } from '../../lib/projectPaths'
import { browserHistory, previewOpen } from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import { shellToPlatform } from '../../types/tab'

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
const tabStore = useTabStore()
const projectStore = useProjectStore()

const hostRef = useTemplateRef<HTMLElement>('hostRef')
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
  el: hostRef,
  visible: () => tabStore.isTabVisible(props.tabId),
  // `browser-` の下に置く: 位置合わせ・再読み込み・閉じるはブラウザのタブのコマンドを使う。
  newLabel: () => `browser-preview-${crypto.randomUUID()}`,
  create: async (label, bounds) => {
    const { shell, platform, root, entry } = place()
    await previewOpen(label, root, shell, entry, bounds)
    served.value = { root, platform }
  },
  handlers: {
    // プレビューの中のリンク（Rust がブラウザのタブへ振り替えたもの）。
    onNewTab: (url) => {
      const tab = tabStore.tabs.find((t) => t.id === props.tabId)
      tabStore.addBrowserTab(url, { forceNew: true, pane: tab ? tabStore.paneOf(tab) : undefined })
    },
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

/**
 * 配信しているルートが、ファイル監視の見ている範囲（今の `activeRoot`）に入っているか。
 * **監視は今の `activeRoot` しか見ない**ので、入っていない（プロジェクトの外の HTML、
 * 別プロジェクトへ切り替えて保持しているあいだ、worktree の切り替え）ときは変更が届かない。
 */
const covered = computed(() => {
  const s = served.value
  const active = projectStore.activeRoot
  if (!s || !active) return false
  return isSameOrUnder(active, s.root, s.platform)
})

/**
 * 描き直す。見えていないあいだは印だけ付け、見えたときに 1 回描き直す。続けて来たら畳む。
 */
let reloadTimer: ReturnType<typeof setTimeout> | undefined
let stale = false
function reload() {
  if (!view.ready()) return
  if (!view.shown.value) {
    stale = true
    return
  }
  if (reloadTimer !== undefined) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = undefined
    stale = false
    if (!view.ready()) return
    browserHistory(view.label(), 'reload')
      .then(() => (error.value = null))
      .catch((e) => (error.value = String(e)))
  }, 200)
}

watch(view.shown, (v) => {
  if (v && stale) reload()
})

// 監視の外へ出たら、そのあいだの変更は届かない。戻ってきたときに 1 回描き直す。
watch(covered, (c) => {
  if (!c) stale = true
})

/**
 * 保存した直後（`EditorTab` が呼ぶ）。**監視の範囲に入っているなら何もしない**: 監視からも
 * 同じ保存が来るが、Rust の監視は最長 1 秒まとめてから送るので、畳めずに 2 回描き直す
 * ことになる（WSL ではそのたびに資源の数だけ `wsl.exe` が起きる）。
 */
function onSaved() {
  if (!covered.value) reload()
}

/** 描き直す契機にする拡張子（ページが読むもの）。 */
const WEB_ASSET = /\.(html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|wasm)$/i

/**
 * 配信しているルートの下の、ページが読みうるファイルが変わったら描き直す。HTML 自身に
 * 限らない（CSS や JS を直したときも結果が変わる）。**エージェントが `.ts` や `.rs` を
 * 書いているあいだに描き直し続けない**よう、拡張子で絞る（`node_modules` などは監視の側が
 * 最初から捨てている）。**自分の保存も拾う**: `isRecentlySaved` の印は App.vue が消費する
 * もので、ここでは読まない（`useFsWatcher` の doc）。
 */
const stopWatching = fsWatcher.onFileChange((files) => {
  const s = served.value
  if (!s) return
  if (files.some((f) => WEB_ASSET.test(f.path) && relativeToBase(s.root, f.path, s.platform) !== null)) reload()
})

onUnmounted(() => {
  stopWatching()
  if (reloadTimer !== undefined) clearTimeout(reloadTimer)
})

/**
 * 隠しているあいだの案内を先に出す。エラーは子 webview を作れなかったとき（その場に
 * ページが無いとき）にしか目に入らないので、隠している理由のほうが大事。
 */
const message = computed(() => view.hiddenNotice.value || error.value)

defineExpose({ onSaved })
</script>

<template>
  <!--
    子 webview を重ねるのは `.html-preview-frame`。中身は空で、矩形だけを貸す（案内とエラーだけを
    置く）。スマートフォンの画面のときは枠を絞って中央に置く。
  -->
  <div class="html-preview" :class="{ mobile }">
    <div ref="hostRef" class="html-preview-frame">
      <div v-if="message" class="html-preview-message" :class="{ error: !!error }">{{ message }}</div>
    </div>
  </div>
</template>

<style scoped>
.html-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.html-preview-frame {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 大きさはブラウザのタブのスマートフォンの画面（`BrowserTab.vue`）と同じ。 */
.html-preview.mobile {
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
}

.html-preview.mobile .html-preview-frame {
  flex: 0 0 auto;
  width: min(390px, 100%);
  height: min(844px, 100%);
  outline: 1px solid var(--border);
}

.html-preview-message {
  max-width: 28em;
  padding: 0 16px;
  text-align: center;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.html-preview-message.error {
  color: var(--danger);
}
</style>
