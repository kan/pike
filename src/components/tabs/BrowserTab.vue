<script setup lang="ts">
/**
 * 外部のページを開くタブ（#368）。**ページそのものは DOM の中に無い**: Rust が作る子
 * webview（`src-tauri/src/browser.rs`）を、`.browser-view` の矩形に合わせて重ねる。
 * このコンポーネントの仕事は、その矩形を測って送ることと、見えていないときに隠すこと。
 *
 * **子 webview は Pike の DOM より手前に描かれる**ので、ダイアログや QuickOpen が開いて
 * いるあいだは隠す（隠さないとその下に埋もれて操作できない）。右クリックメニューなど
 * それ以外の浮くものは隠れたままになる（#368 で制約として受け入れた）。
 */

import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, Star } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { browserRouter } from '../../composables/useBrowserRouter'
import { dialogOpen } from '../../composables/useConfirmDialog'
import { useShortcutsModal } from '../../composables/useShortcutsModal'
import { useI18n } from '../../i18n'
import { normalizeWebUrl, openUrlWithConfirm } from '../../lib/openUrl'
import {
  type BrowserBounds,
  type BrowserHistoryAction,
  browserClose,
  browserHistory,
  browserNavigate,
  browserOpen,
  browserPlace,
} from '../../lib/tauri'
import { useBrowserStore } from '../../stores/browser'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import type { BrowserTab } from '../../types/tab'
import HelpButton from '../HelpButton.vue'

const { t } = useI18n()
const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()
const browserStore = useBrowserStore()
const shortcutsModal = useShortcutsModal()

const tab = computed(() => tabStore.tabs.find((t): t is BrowserTab => t.id === props.tabId && t.kind === 'browser'))

/**
 * 子 webview のラベル。Rust は `browser-` で始まるものしか受け付けない。
 *
 * **タブの id から作らない。** webview のラベルはアプリ全体で一意でなければならないが、
 * タブの id（`genId`）はウィンドウごとの連番と時刻でしか作っていないので、同じミリ秒に
 * 復元した 2 つのウィンドウでぶつかりうる。
 */
const label = `browser-${crypto.randomUUID()}`
const viewRef = useTemplateRef<HTMLElement>('viewRef')
const addressRef = useTemplateRef<HTMLInputElement>('addressRef')
const address = ref(tab.value?.url ?? '')
const error = ref<string | null>(null)
/**
 * 子 webview の状態。**作っている途中（`creating`）を別に持つ**: 作り終える前に位置や表示を
 * 送ると相手がいないので失敗し、隠す指示もそこで失われる。作り終えたら測り直す。
 */
let state: 'none' | 'creating' | 'ready' = 'none'
let disposed = false

/**
 * 重ねてよいか。タブが描かれていて、かつ手前に出る Pike のモーダル（確認ダイアログ・
 * QuickOpen・プロジェクトスイッチャー・ショートカット一覧）が無いとき。
 * `dialogOpen()` はモジュールの ref を読むので、computed の中で呼べば追従する。
 */
const shown = computed(
  () =>
    tabStore.isTabVisible(props.tabId) &&
    !dialogOpen() &&
    !projectStore.showQuickOpen &&
    !projectStore.showSwitcher &&
    !shortcutsModal.visible.value,
)

function measure(): BrowserBounds | null {
  const el = viewRef.value
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/** 位置合わせは 1 フレームに 1 回へ畳む（リサイズ中は ResizeObserver が連続で来る）。 */
let frame = 0
function scheduleSync() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    void sync()
  })
}

/**
 * **位置合わせは 1 本ずつ順に送る。** Rust のコマンドは別々のタスクで走るので、重ねて送ると
 * 「見せる」と「隠す」の順が入れ替わり、隠したはずのページが最後に見えたまま残りうる。
 * 走っている最中に頼まれたら印だけ付け、終わってから最新の状態でもう一度合わせる。
 */
let syncing = false
let syncAgain = false

async function sync() {
  if (syncing) {
    syncAgain = true
    return
  }
  syncing = true
  try {
    await syncOnce()
  } finally {
    syncing = false
    if (syncAgain) {
      syncAgain = false
      void sync()
    }
  }
}

async function syncOnce() {
  if (disposed || !tab.value) return
  const bounds = measure()
  if (state === 'none') {
    // 最初に見えたときに作る。隠れたタブを復元で作っても、測れないので待つ。
    // 空のタブ（ブラウザパネルの「新しいタブ」）は、アドレス欄に URL が入るまで作らない。
    if (!shown.value || !bounds || !tab.value.url) return
    state = 'creating'
    try {
      await browserOpen(label, tab.value.url, bounds)
      error.value = null
    } catch (e) {
      state = 'none'
      error.value = String(e)
      return
    }
    state = 'ready'
    // 作っているあいだに閉じられたら片付ける。
    if (disposed) {
      void browserClose(label)
      return
    }
    // 作っているあいだに隠れた・動いたぶんを反映する（`sync` が 1 本ずつなので、作っている
    // 最中に来た頼みは `syncAgain` に溜まっている。溜まっていなくても 1 回は合わせ直す）。
    syncAgain = true
    return
  }
  // **変わっていなければ送らない。** リサイズ中は毎フレーム来るうえ、隠れているタブにも
  // ResizeObserver が届く（大きさが 0 になる通知）。
  const visible = shown.value && !!bounds
  const key = visible && bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : ''
  if (visible === lastVisible && key === lastBoundsKey) return
  try {
    await browserPlace(label, visible, visible ? (bounds ?? undefined) : undefined)
    // **送れたときだけ覚える。** 失敗したのに覚えると、次に同じ状態を頼まれても
    // 「変わっていない」と見なして送らず、見えたまま（隠れたまま）になる。
    lastVisible = visible
    lastBoundsKey = key
  } catch (e) {
    error.value = String(e)
  }
}

/** 最後に送った表示と位置（`browser_open` は見えている状態で作る）。 */
let lastVisible = true
let lastBoundsKey = ''

// **隠すときはフレームを待たない。** 次のフレームまで待つと、そのあいだ別のタブの上に
// ページが残る。フレームの更新が止まっている（webview が描画を止めている）場合でも隠れる。
watch(shown, (v) => (v ? scheduleSync() : void sync()))

let observer: ResizeObserver | null = null

/**
 * 反対のペインへ移ったとき（#308）。分割比が 50/50 だと大きさが変わらないので
 * ResizeObserver は発火せず、見えているかどうかも変わらない。位置だけが動くのはこの経路。
 */
watch(() => (tab.value ? tabStore.paneOf(tab.value) : null), scheduleSync)

onMounted(async () => {
  // 大きさの変化（ウィンドウのリサイズ、サイドバーや分割線のドラッグ、エラーの帯の出し入れ）。
  observer = new ResizeObserver(scheduleSync)
  if (viewRef.value) observer.observe(viewRef.value)
  scheduleSync()
  // 空のタブは URL を打つために開いたものなので、アドレス欄から始める。
  if (!tab.value?.url) addressRef.value?.focus()
  browserRouter.register(label, {
    onState: ({ url, title, titleUrl }) => {
      if (!tab.value) return
      if (title) {
        tabStore.setTabTitle(props.tabId, title)
        // SPA は URL を変えずにタイトルだけ変えることがある。履歴の行も追従させる。
        // **`tab.value.url` を使わない**: 読み込みの途中ではまだ前のページを指している。
        if (titleUrl) browserStore.setTitle(titleUrl, title)
      }
      if (url) {
        tab.value.url = url
        address.value = url
        // タイトルは読み込みの途中で先に届くことが多いので、その時点のタブの名前を使う。
        browserStore.recordVisit(url, tab.value.title)
      }
    },
    // ページが新しいウィンドウを開こうとした（`target=_blank` など）。ポップアップは Rust が
    // WebView2 に任せ、ここへ来るのは普通のリンクだけ。同じ URL のタブがあっても新しく開く
    // （ブラウザと同じ）。置き場はこのタブと同じペイン。
    onNewTab: (url) => {
      if (tab.value) tabStore.addBrowserTab(url, { forceNew: true, pane: tabStore.paneOf(tab.value) })
    },
  })
})

onUnmounted(() => {
  disposed = true
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
  browserRouter.unregister(label)
  // 作っている途中なら、作り終えたところで `sync` が片付ける。
  if (state === 'ready') void browserClose(label)
})

async function go() {
  if (!address.value.trim() || !tab.value) return
  const url = normalizeWebUrl(address.value)
  if (state !== 'ready') {
    // まだ作れていない（最初の URL が読めずに失敗した、など）。打ち直した URL で作り直す。
    // 作っている途中なら、その結果を待つ（打ち直した URL は次の失敗のあとに効く）。
    tab.value.url = url
    error.value = null
    scheduleSync()
    return
  }
  try {
    await browserNavigate(label, url)
    error.value = null
  } catch (e) {
    error.value = String(e)
  }
}

function history(action: BrowserHistoryAction) {
  if (state === 'ready') void browserHistory(label, action).catch((e) => (error.value = String(e)))
}

const bookmarked = computed(() => !!tab.value && settingsStore.isBookmarked(tab.value.url))

/** ☆ で今のページをブックマークに足す・外す。名前はタブの名前（ページのタイトル）。 */
function toggleBookmark() {
  if (!tab.value) return
  if (bookmarked.value) settingsStore.removeBookmark(tab.value.url)
  else settingsStore.addBookmark(tab.value.url, tab.value.title)
}

function openExternal() {
  if (tab.value) void openUrlWithConfirm(tab.value.url)
}
</script>

<template>
  <div class="browser-tab">
    <div class="md-toolbar">
      <button class="tool-btn" :title="t('browser.back')" @click="history('back')"><ArrowLeft :size="14" /></button>
      <button class="tool-btn" :title="t('browser.forward')" @click="history('forward')">
        <ArrowRight :size="14" />
      </button>
      <button class="tool-btn" :title="t('browser.reload')" @click="history('reload')"><RotateCw :size="14" /></button>
      <input
        ref="addressRef"
        v-model="address"
        class="address"
        spellcheck="false"
        :placeholder="t('browser.addressPlaceholder')"
        @keydown.enter="go"
      />
      <!-- 空のタブでは、登録する・外で開くページがまだ無い。 -->
      <button
        class="tool-btn"
        :class="{ bookmarked }"
        :disabled="!tab?.url"
        :title="t(bookmarked ? 'browser.removeBookmark' : 'browser.addBookmark')"
        @click="toggleBookmark"
      >
        <Star :size="14" :fill="bookmarked ? 'currentColor' : 'none'" />
      </button>
      <button class="tool-btn" :disabled="!tab?.url" :title="t('browser.openExternal')" @click="openExternal">
        <ExternalLink :size="14" />
      </button>
      <HelpButton page="browser.md" :size="15" />
    </div>
    <div v-if="error" class="browser-error">{{ error }}</div>
    <div ref="viewRef" class="browser-view" />
  </div>
</template>

<style scoped>
.browser-tab {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.address {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
}

/* ブックマーク済みの ☆ は塗りつぶしに加えて色でも見分ける。 */
.tool-btn.bookmarked {
  color: var(--accent);
}

.browser-error {
  padding: 4px 8px;
  color: var(--danger);
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

/* 子 webview を重ねる場所。中身は空で、矩形だけを貸す。 */
.browser-view {
  flex: 1;
  min-height: 0;
}
</style>
