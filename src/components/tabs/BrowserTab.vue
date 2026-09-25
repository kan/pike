<script setup lang="ts">
/**
 * 外部のページを開くタブ（#368）。**ページそのものは DOM の中に無い**: Rust が作る子
 * webview（`src-tauri/src/browser.rs`）を、`.browser-frame` の矩形に合わせて重ねる。
 * 矩形を測って送ること・見えていないときに隠すこと・手前に浮くものがあるあいだ隠すことは
 * `composables/useChildWebview.ts`（HTML のプレビュー #399 と共有）が持ち、ここに残るのは
 * ページの中身（アドレス欄・履歴・ルール・別のタブへの譲り渡し）だけ。
 */

import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, Settings, Smartphone, Star } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import type { BrowserHandlers } from '../../composables/useBrowserRouter'
import { useChildWebview } from '../../composables/useChildWebview'
import { useFocusPolling } from '../../composables/useFocusPolling'
import { useI18n } from '../../i18n'
import { registerBrowserDonor, takeBrowserView, unregisterBrowserDonor } from '../../lib/browserHandoff'
import { requestBrowserIcon } from '../../lib/browserIcons'
import { isSamePage, isWebUrl } from '../../lib/format'
import { normalizeWebUrl, openUrlWithConfirm } from '../../lib/openUrl'
import {
  type BrowserHistoryAction,
  browserApplyCss,
  browserClose,
  browserHistory,
  browserNavigate,
  browserOpen,
  browserUrl,
  type SiteRulePayload,
} from '../../lib/tauri'
import { useBrowserStore } from '../../stores/browser'
import { activeSiteRules, useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import type { BrowserTab, TabOwner } from '../../types/tab'
import HelpButton from '../HelpButton.vue'

const { t } = useI18n()
const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const settingsStore = useSettingsStore()
const browserStore = useBrowserStore()

const tab = computed(() =>
  tabStore.tabs.find((t): t is BrowserTab & TabOwner => t.id === props.tabId && t.kind === 'browser'),
)

/**
 * 子 webview のラベル。Rust は `browser-` で始まるものしか受け付けない。
 *
 * **タブの id から作らない。** webview のラベルはアプリ全体で一意でなければならないが、
 * タブの id（`genId`）はウィンドウごとの連番と時刻でしか作っていないので、同じミリ秒に
 * 復元した 2 つのウィンドウでぶつかりうる。
 */
const newLabel = () => `browser-${crypto.randomUUID()}`
const viewRef = useTemplateRef<HTMLElement>('viewRef')
const addressRef = useTemplateRef<HTMLInputElement>('addressRef')
const address = ref(tab.value?.url ?? '')
/**
 * アドレス欄を打ちかけか（#368）。**打ちかけのあいだは移動してきた URL で上書きしない。**
 * 重いページを開いたまま次の URL を打ち始めると、最初のページの読み込みが終わった時点で
 * 打った文字列が消えていた。既定で有効な Jira の自動リロード（`jira/machinery.js`）でも
 * 同じことが起きる。
 *
 * 戻すのは `Escape`（今いるページの URL に戻す）と、移動を始めた `go()` の 2 つだけ。
 * フォーカスの有無では見ない: 候補の一覧（`<datalist>`）を選ぶあいだにフォーカスが
 * 外れることがある。
 */
const addressEdited = ref(false)
const error = ref<string | null>(null)

/** ページからの知らせ（`useBrowserRouter` がラベルで振り分ける）。 */
const routerHandlers: BrowserHandlers = {
  onState: ({ url, title, titleUrl }) => {
    if (!tab.value) return
    if (title) {
      tabStore.setTabTitle(props.tabId, title)
      // SPA は URL を変えずにタイトルだけ変えることがある。履歴の行も追従させる。
      // **`tab.value.url` を使わない**: 読み込みの途中ではまだ前のページを指している。
      if (titleUrl) browserStore.setTitle(titleUrl, title)
    }
    if (url) {
      applyUrl(url)
      // 読み込みが終わったページのサイトのアイコン（#400）。オリジンごとに 1 回だけ取る。
      requestBrowserIcon(url)
    }
  },
  // ページが新しいウィンドウを開こうとした（`target=_blank` など）。ポップアップは Rust が
  // WebView2 に任せ、ここへ来るのは普通のリンクだけ。同じ URL のタブがあっても新しく開く
  // （ブラウザと同じ）。置き場はこのタブと同じペイン。
  onNewTab: (url) => {
    if (tab.value) tabStore.addBrowserTab(url, { forceNew: true, pane: tabStore.paneOf(tab.value) })
  },
}

/**
 * 子 webview の面倒（位置合わせ・隠す・閉じる・作り直し）。ここへ渡すのは、作る中身と
 * 作る前に別のタブから譲り受けられるかの問い合わせだけ。
 */
const view = useChildWebview({
  el: viewRef,
  visible: () => tabStore.isTabVisible(props.tabId),
  newLabel,
  // 空のタブ（ブラウザパネルの「新しいタブ」）は、アドレス欄に URL が入るまで作らない。
  canCreate: () => !!tab.value?.url,
  beforeCreate: () => {
    if (!tab.value) return Promise.resolve(false)
    return tryAdopt(tab.value.url, rulesKeyOf(siteRules.value, settingsStore.browserJiraFeatures))
  },
  create: async (label, bounds) => {
    if (!tab.value) throw new Error('tab closed')
    // 渡した時点のルールを覚える（JS はここで固定されるので、変わったら作り直しを促す）。
    const rules = siteRules.value
    const jira = settingsStore.browserJiraFeatures
    await browserOpen(label, tab.value.url, bounds, rules, jira)
    openedRulesKey.value = rulesKeyOf(rules, jira)
  },
  handlers: routerHandlers,
  onError: (e) => (error.value = e),
  // ルールの鍵はその子 webview のもの。差し替えたら捨てる（譲り受けたときは `tryAdopt` が入れ直す）。
  onReset: () => (openedRulesKey.value = null),
})
const { shown, hiddenNotice, scheduleSync } = view

/**
 * 反対のペインへ移ったとき（#308）。分割比が 50/50 だと大きさが変わらないので
 * ResizeObserver は発火せず、見えているかどうかも変わらない。位置だけが動くのはこの経路。
 */
watch(() => (tab.value ? tabStore.paneOf(tab.value) : null), scheduleSync)

// --- ドメインごとの差し込み（#368 の段階 3） ---
const siteRules = computed(() => activeSiteRules(settingsStore.browserSiteRules))
/**
 * ルールの鍵。**CSS も含める**: CSS はその場で当て直すが、それが効くのは今のページだけで、
 * 次に移動したページには子 webview を作った時点の CSS が差し込まれる（差し込みのスクリプトは
 * 作った時点で固定され、ページをまたいで値を持ち越す置き場も無い）。Jira の拡張機能（#380）の
 * オン・オフも同じ理由で含める。
 */
const rulesKeyOf = (rules: SiteRulePayload[], jira: boolean) =>
  JSON.stringify([jira, rules.map((r) => [r.domains, r.js, r.css])])
/** 子 webview を作ったときのルールの鍵。まだ作っていなければ null。 */
const openedRulesKey = ref<string | null>(null)
/** ルールが作ったあとに変わった（作り直さないと、次のページ以降に効かない）。 */
const rulesStale = computed(
  () =>
    openedRulesKey.value !== null &&
    openedRulesKey.value !== rulesKeyOf(siteRules.value, settingsStore.browserJiraFeatures),
)

// CSS はその場で当て直す。設定画面の入力欄の打鍵ごとに来るので、少し待ってまとめる。
let cssTimer: ReturnType<typeof setTimeout> | undefined
watch(siteRules, (rules) => {
  if (cssTimer !== undefined) clearTimeout(cssTimer)
  cssTimer = setTimeout(() => {
    cssTimer = undefined
    if (!view.ready()) return
    const target = view.label()
    browserApplyCss(target, rules).catch((e) => {
      if (target === view.label()) error.value = String(e)
    })
  }, 300)
})

/**
 * 別のプロジェクトのタブが同じページを読み込み済みなら、それを譲り受ける（#402）。
 * 受け取れたら true。
 */
async function tryAdopt(url: string, rulesKey: string): Promise<boolean> {
  const donated = await takeBrowserView(props.tabId, tab.value?.projectId, url, rulesKey)
  if (!donated) return false
  // 聞いているあいだに閉じられたら、受け取ったページは行き場が無いので閉じる。
  if (view.disposed() || !tab.value) {
    void browserClose(donated.label)
    return true
  }
  view.adopt(donated.label)
  openedRulesKey.value = rulesKey
  if (donated.title) tabStore.setTabTitle(props.tabId, donated.title)
  // 聞いているあいだに別の URL を打たれていたら、そちらへ移る。
  if (tab.value.url !== url) void browserNavigate(view.label(), tab.value.url).catch(() => {})
  return true
}

/** 譲れる状態か（条件は `lib/browserHandoff.ts` の doc）。描かれているあいだは譲らない。 */
function holdable(): boolean {
  return view.ready() && !tabStore.isTabVisible(props.tabId)
}

registerBrowserDonor(props.tabId, {
  hold: (projectId, url, rulesKey) =>
    holdable() && tab.value?.projectId !== projectId && tab.value?.url === url && openedRulesKey.value === rulesKey
      ? view.label()
      : null,
  release: (target) => {
    if (!holdable() || view.label() !== target) return null
    const title = tab.value?.title ?? ''
    view.release()
    return title
  },
})

/**
 * 移動してきた URL を反映する（タブ・アドレス欄・閲覧履歴）。
 *
 * **入口は 2 つ**: 読み込みの完了（`onState` の `url`）と、ページの中の移動を拾う
 * ポーリング（`pollUrl`、`sameDocument`）。同じ URL を 2 度履歴へ回さないのは `queuedUrl`。
 *
 * **http(s) か確かめてから採る**。`webview.url()` はその瞬間のもので、ページが
 * `blob:` や `about:blank` にいることがある。ここで入れた値は `snapshotSession` で
 * `project.json` に残り、復元のときに `browser_open` へ返るので、そのまま採ると
 * 開けないタブになる。
 *
 * **ページの中の移動は、パスが変わったときだけ履歴に載せる**（#412、`isSamePage`）。
 * Jira はチケットを開くとクエリだけを書き換えるので、全部載せると開いたチケットの数だけ
 * 行が増える（Chrome / Edge の履歴では増えない）。GitHub のようにパスごと移る SPA の移動は載せる。
 */
function applyUrl(url: string, sameDocument = false) {
  // ポーリングは URL が変わらない回がほとんどなので、URL を解析する前に抜ける。
  if (!tab.value || (sameDocument && url === tab.value.url) || !isWebUrl(url)) return
  const prev = tab.value.url
  tab.value.url = url
  if (!addressEdited.value) address.value = url
  // **タブの URL と履歴は別々に比べる。** WebView2 の `Source` は読み込みを終える前に次の
  // URL へ変わるので、クエリだけ違うページを開くとポーリングが先にそれを拾い、ページの中の
  // 移動として見送る。そのあと届く読み込みの完了は、タブの URL とは同じでも履歴にはまだ
  // 載っていないので、ここで載せる。
  if (url === queuedUrl) return
  if (sameDocument && isSamePage(prev, url)) return
  queueVisit(url)
}

/**
 * 履歴に載せるのを待つ時間（#412）。この間に同じタブが次のページへ移ったら、そのページは
 * リダイレクトとみなして載せない。
 *
 * **「リダイレクト中…」のページを落とすため。** サーバーのリダイレクト（3xx）は途中の
 * ページが読み込まれないので元から載らないが、ログインの経路などにある JS やメタ refresh の
 * リダイレクトは、途中のページが読み込みを終えてから次へ移る。Chromium はこれをクライアント
 * リダイレクトとして記録し、履歴の画面には連鎖の終点だけを出す（`visit_database.cc` の
 * `TransitionIsVisible` が `PAGE_TRANSITION_CHAIN_END` を見る）。Tauri の API はユーザーの
 * 操作による移動かを出していないので、時間で近似する。代償は、読み込んでから 3 秒以内に
 * リンクを押して移ったページも載らないこと。WebView2 の `NavigationStarting` の
 * `IsUserInitiated` を Rust で受ければ近似が要らなくなる（#416）。
 */
const VISIT_COMMIT_DELAY_MS = 3000
/**
 * 最後に履歴へ回した URL（待っているもの・載せたもの）。同じ URL を 2 度回さない。
 * **始まりはタブを作った時点の URL**: 以前はタブの URL と同じなら載せなかったので、
 * 復元したタブが起動のたびに履歴の先頭へ上がることは無かった。それを変えない。
 */
let queuedUrl = tab.value?.url ?? ''
let pendingTimer: ReturnType<typeof setTimeout> | undefined

/** 前に待っていたページは捨て（リダイレクトとみなす）、このページを待たせる。 */
function queueVisit(url: string) {
  if (pendingTimer !== undefined) clearTimeout(pendingTimer)
  queuedUrl = url
  pendingTimer = setTimeout(commitVisit, VISIT_COMMIT_DELAY_MS)
}

function commitVisit() {
  pendingTimer = undefined
  // タイトルは待っているあいだに届いていることが多いので、この時点のタブの名前を使う。
  // まだなら、あとから `setTitle` が入れる。
  const current = tab.value
  browserStore.recordVisit(queuedUrl, current && isSamePage(current.url, queuedUrl) ? current.title : undefined)
}

/**
 * ページの中の移動（`history.pushState`）を拾う（#368）。
 *
 * **イベントでは届かない**。`on_page_load` も `on_navigation` も文書の読み込みを伴う
 * 遷移でしか発火せず、ページ側から知らせる手も無い（子 webview は capability の
 * 対象外なので `invoke` が通らない）。理由の詳細は `browser_url` の doc が正本。
 *
 * ウィンドウがアクティブで、このタブが描かれているあいだだけ引く（`useFocusPolling`）。
 */
const urlPoll = useFocusPolling([
  {
    every: 1000,
    tick: () => {
      if (!view.ready()) return
      void browserUrl(view.label())
        .then((url) => applyUrl(url, true))
        .catch(() => {})
    },
  },
])

onMounted(() => {
  // 空のタブは URL を打つために開いたものなので、アドレス欄から始める。
  if (!tab.value?.url) addressRef.value?.focus()
})

// 描かれているあいだだけ引く。`shown` はダイアログや QuickOpen で隠したときも false に
// なるが、そのときもページは動いていないので止めてよい。
watch(shown, (visible) => (visible ? urlPoll.start() : urlPoll.stop()), { immediate: true })

// 子 webview を閉じるのは `useChildWebview` の後始末。
onUnmounted(() => {
  unregisterBrowserDonor(props.tabId)
  urlPoll.stop()
  if (cssTimer !== undefined) clearTimeout(cssTimer)
  // **待っている訪問は捨てずに載せる**（#412）。次のページへ移っていない以上リダイレクト
  // ではなく、開いてすぐ閉じたページも履歴から辿れるほうがよい。
  if (pendingTimer !== undefined) {
    clearTimeout(pendingTimer)
    commitVisit()
  }
})

async function go() {
  if (!address.value.trim() || !tab.value) return
  // 打ちかけはここで確定する。以後は移動してきた URL で上書きしてよい。
  addressEdited.value = false
  const url = normalizeWebUrl(address.value)
  if (!view.ready()) {
    // まだ作れていない（最初の URL が読めずに失敗した、など）。打ち直した URL で作り直す。
    // 作っている途中なら、その結果を待つ（打ち直した URL は次の失敗のあとに効く）。
    tab.value.url = url
    error.value = null
    scheduleSync()
    return
  }
  try {
    await browserNavigate(view.label(), url)
    error.value = null
  } catch (e) {
    error.value = String(e)
  }
}

function history(action: BrowserHistoryAction) {
  if (view.ready()) void browserHistory(view.label(), action).catch((e) => (error.value = String(e)))
}

const bookmarked = computed(() => !!tab.value && settingsStore.isBookmarked(tab.value.url))

/** ☆ で今のページをブックマークに足す・外す。名前はタブの名前（ページのタイトル）。 */
function toggleBookmark() {
  if (!tab.value) return
  if (bookmarked.value) settingsStore.removeBookmark(tab.value.url)
  else settingsStore.addBookmark(tab.value.url, tab.value.title)
}

/** スマートフォンの画面の大きさに絞る・戻す。枠の大きさが変わるので ResizeObserver が位置を合わせ直す。 */
function toggleMobile() {
  if (tab.value) tab.value.mobile = !tab.value.mobile
}

/**
 * アドレス欄の補完候補。ブックマークを先に、閲覧履歴を新しい順に並べる（同じ URL は 1 つ）。
 * 件数は絞る（履歴は最大 500 件あり、`<option>` を全部描くと打鍵のたびに重くなる）。
 */
const SUGGEST_MAX = 200
const suggestId = `browser-suggest-${props.tabId}`
const suggestions = computed(() => {
  const seen = new Set<string>()
  const out: { url: string; label: string }[] = []
  const push = (url: string, label: string) => {
    if (seen.has(url) || out.length >= SUGGEST_MAX) return
    seen.add(url)
    out.push({ url, label })
  }
  for (const b of settingsStore.browserBookmarks) push(b.url, b.name)
  for (const v of browserStore.history) push(v.url, v.title)
  return out
})

/**
 * 補完候補を選んだら、そのまま移動する。**候補の選択は打鍵と同じ `input` イベントで届く**ので、
 * `inputType` で見分ける（Chromium は候補の選択を `insertReplacementText` で知らせる。打鍵は
 * `insertText`）。入った値が候補の URL と一致するときだけにする。
 */
function onAddressInput(e: Event) {
  addressEdited.value = true
  if ((e as InputEvent).inputType !== 'insertReplacementText') return
  if (suggestions.value.some((s) => s.url === address.value)) void go()
}

/** 打ちかけを捨てて、今いるページの URL に戻す。 */
function revertAddress() {
  addressEdited.value = false
  address.value = tab.value?.url ?? ''
  addressRef.value?.blur()
}

/**
 * 歯車：このページのドメインの JS と CSS のルールを設定タブで開く。合うルールが無ければ、
 * ドメインにホスト名を入れたルールを作ってから開く（`settingsStore.siteRuleForHost`）。
 */
function openSiteRuleSettings() {
  if (!tab.value?.url) return
  let host: string
  try {
    host = new URL(tab.value.url).hostname
  } catch {
    return
  }
  if (!host) return
  tabStore.addSettingsTab({ focusSiteRule: settingsStore.siteRuleForHost(host) })
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
      <!--
        補完候補は `<datalist>`（#368 の段階 4）。**HTML で一覧を描かないこと**: ページ（子 webview）が
        Pike の画面より手前に描かれるので、アドレス欄の下に出した一覧はページの下に隠れる。
        `<datalist>` の候補は Chromium がネイティブの小さなウィンドウとして出す。
      -->
      <input
        ref="addressRef"
        v-model="address"
        class="address"
        spellcheck="false"
        :list="suggestId"
        :placeholder="t('browser.addressPlaceholder')"
        @keydown.enter="go"
        @keydown.esc.stop="revertAddress"
        @input="onAddressInput"
      />
      <datalist :id="suggestId">
        <option v-for="s in suggestions" :key="s.url" :value="s.url" :label="s.label" />
      </datalist>
      <button
        class="tool-btn"
        :class="{ active: tab?.mobile }"
        :title="t(tab?.mobile ? 'browser.mobileOff' : 'browser.mobileOn')"
        @click="toggleMobile"
      >
        <Smartphone :size="14" />
      </button>
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
      <button class="tool-btn" :disabled="!tab?.url" :title="t('browser.siteRuleSettings')" @click="openSiteRuleSettings">
        <Settings :size="14" />
      </button>
      <button class="tool-btn" :disabled="!tab?.url" :title="t('browser.openExternal')" @click="openExternal">
        <ExternalLink :size="14" />
      </button>
      <HelpButton page="browser.md" :size="15" />
    </div>
    <div v-if="error" class="browser-error">{{ error }}</div>
    <!-- ルールは子 webview を作った時点で固定される。変わったら作り直しを促す。 -->
    <div v-if="rulesStale" class="browser-notice">
      <span>{{ t('browser.siteRulesChanged') }}</span>
      <!-- 作り直すと JS のルールも入れ直される。 -->
      <button class="notice-btn" @click="view.recreate()">{{ t('browser.applySiteRules') }}</button>
    </div>
    <!-- 子 webview を重ねるのは `.browser-frame`。スマートフォンの画面のときは枠を絞って中央に置く。 -->
    <div class="browser-view" :class="{ mobile: tab?.mobile }">
      <div ref="viewRef" class="browser-frame">
        <!--
          隠しているあいだの案内（#396）。ページが消えるのは Pike の都合なので、そう書いて
          おかないと「読み込みに失敗した」ように見える。**出すのはこのタブを見ている
          あいだだけ**（他のタブへ切り替えて隠れているときは、そもそも誰も見ていない）。
        -->
        <div v-if="hiddenNotice" class="browser-hidden">{{ hiddenNotice }}</div>
      </div>
    </div>
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

/* エディタの外部変更の帯（`EditorTab.vue` の `.notice-bar`）と同じ見た目にそろえる。 */
.browser-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--accent);
  flex-shrink: 0;
}

.notice-btn {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11px;
  cursor: pointer;
}

.notice-btn:hover {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
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
  display: flex;
}

.browser-frame {
  flex: 1;
  /* 子 webview は DOM の外なので、中に置けるのは隠しているあいだの案内だけ。 */
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}

.browser-hidden {
  max-width: 28em;
  padding: 0 16px;
  text-align: center;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}

/*
 * スマートフォンの画面（#368 の段階 4）。**幅と高さを絞るだけで UA は変えない**（見送った）。
 * CSS のメディアクエリは表示の幅で切り替わるので、多くのサイトはこれでスマートフォン向けになる。
 * 大きさは iPhone の標準的な画面（390×844）。タブがそれより小さければ、はみ出さないよう縮める。
 */
.browser-view.mobile {
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
}

.browser-view.mobile .browser-frame {
  flex: 0 0 auto;
  width: min(390px, 100%);
  height: min(844px, 100%);
  outline: 1px solid var(--border);
}

.tool-btn.active {
  color: var(--accent);
}
</style>
