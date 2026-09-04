<script setup lang="ts">
import DOMPurify from 'dompurify'
import { ExternalLink, RefreshCw } from 'lucide-vue-next'
import { Marked } from 'marked'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from '../../i18n'
import { issueRefs } from '../../lib/issueRefs'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { relativeDate } from '../../lib/paths'
import { projectColorValue, readableTextOn } from '../../lib/projectColors'
import { ALLOWED_URI_REGEXP } from '../../lib/sanitizeHtml'
import { issuesView } from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import type { IssueDetail } from '../../types/issues'
import type { IssueTab as IssueTabDef } from '../../types/tab'

// 相対時刻は `relativeDate` が `t()` を通るので、`comments` / テンプレートの computed が
// そのまま locale に追従する（言語切替のための watcher は要らない）。
const { t } = useI18n()
const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()

/**
 * 本文を組む marked。**`#123` を別タブへのリンクにする拡張だけ入れる**（`lib/issueRefs.ts`）。
 * エディタのプレビューが持つフロントマター・mermaid・CSV の分岐は通さない: issue の本文は
 * ファイルではないので、そのどれも起こりえない。
 */
const md2html = new Marked(issueRefs())

const detail = ref<IssueDetail | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)

const tab = computed(() => tabStore.tabs.find((t): t is IssueTabDef => t.id === props.tabId && t.kind === 'issue'))

/**
 * 取得は開いたときと更新ボタンのときだけ（パネルと同じ判断で、外部プロセスの起動を
 * 定期実行に混ぜない）。**タブは番号ごとに 1 枚**なので、番号が変わることは無い。
 */
async function load() {
  const number = tab.value?.number
  const project = projectStore.currentProject
  if (number === undefined || !project || loading.value) return
  loading.value = true
  try {
    detail.value = await issuesView(project.shell, projectStore.activeRoot, number)
    error.value = null
    // 題名は取ってきてから入れる（開いた時点では番号しか分からない）。**`setTabTitle` を
    // 通す**（エディタとターミナルも同じ）: あちらが「変わったときだけ書く」ガードを持って
    // いて、更新のたびにセッションの書き出しを起こさずに済む。
    tabStore.setTabTitle(props.tabId, `#${number} ${detail.value.title}`)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)

/**
 * 本文とコメントの HTML。**`marked` の素のインスタンス**（マニュアルタブと同じ）で、
 * エディタのプレビューが持つフロントマター・mermaid・CSV の分岐は通さない: issue の本文は
 * ファイルではないので、そのどれも起こりえない。
 *
 * 外部画像は CSP が止める（`img-src` は `'self' data: blob:` ＋マニュアル用のホストだけ）。
 * エディタのプレビューが持つドメイン単位の承認（#239）はここには無いので、issue に貼られた
 * 画像は壊れたまま出る。**読めない画像より、承認していないホストへ通信しないほうを採る**
 * （見たいときは右上からブラウザで開く）。
 */
function render(md: string): string {
  return DOMPurify.sanitize(md2html.parse(md) as string, { ALLOWED_URI_REGEXP })
}

const bodyHtml = computed(() => render(detail.value?.body ?? ''))

/**
 * **相対時刻をここに入れない。** `relativeDate` は `t()` を通るので locale に依存し、
 * 混ぜると**UI 言語を切り替えるだけで全コメントの markdown を組み直す**ことになる
 * （#264 でパーク中のタブも生きているので、別プロジェクトのぶんまで走る）。時刻は
 * テンプレートで直に呼ぶ。
 */
const comments = computed(() => (detail.value?.comments ?? []).map((c) => ({ ...c, html: render(c.body) })))

/** ラベルはタブでは名前ごと出す（幅があるので隠れない）。**色の検証を `projectColorValue` に
 *  委ねる理由は `IssuesPanel.vue` の `dotStyle` の doc が正本**（任意の CSS 値を style バインドへ
 *  通さない規則はあそこが持っている）。 */
function labelStyle(color: string): Record<string, string> {
  const bg = projectColorValue(`#${color}`)
  if (!bg) return { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }
  return { background: bg, color: readableTextOn(bg) }
}

function openInBrowser() {
  if (detail.value) void openUrlWithConfirm(detail.value.url)
}

/**
 * **本文の中のリンクは必ずここで止める（#278）。** `v-html` で流し込んだ `<a>` を素のままに
 * すると、クリックで WebView がそのページへ**アプリごと**移動する: ウィンドウの全タブ・
 * PTY・エージェント・未保存のバッファが確認なしに消える（`App.vue` の window ガードは
 * ドロップ用で、リンクは見ていない）。マニュアルタブとエディタのプレビューが同じ形で
 * 塞いでいる。
 *
 * **issue の本文は他人が書いた文字列**でもあるので、Pike が描くマークダウンの中でここだけ
 * 素性が違う。扱えないもの（相対リンク・`#anchor`）は `openUrlWithConfirm` が
 * 弾くので、`preventDefault` だけして何もしない。
 */
function onContentClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  e.preventDefault()

  // `#123`（`lib/issueRefs.ts` が付ける印）。同じリポジトリなので番号だけで開ける。
  const ref = a.dataset.issue
  if (ref) {
    tabStore.addIssueTab(Number(ref))
    return
  }
  const href = a.getAttribute('href')
  if (!href) return
  // 同じリポジトリの issue / PR の URL は、`#123` と同じくタブで開く（`marked` が
  // 裸の URL を自動リンクするので、本文には両方の書き方が混ざる）。
  const number = sameRepoIssueNumber(href)
  if (number !== null) {
    tabStore.addIssueTab(number)
    return
  }
  void openUrlWithConfirm(href)
}

/**
 * `href` がこの issue と同じリポジトリの issue / PR を指していれば、その番号。
 *
 * **基準は `detail.url` から導く**（`https://…/kan/pike/issues/278` の末尾を落とす）。
 * ストアに聞くと、タブがパネルの状態に依存することになる ―― こちらは自分が表示している
 * issue の URL だけで足りる。
 */
function sameRepoIssueNumber(href: string): number | null {
  const own = detail.value?.url
  if (!own) return null
  const base = own.replace(/\/(issues|pull)\/\d+$/, '')
  if (base === own) return null
  // 正規表現を組み立てず前方一致で見る（URL をパターンに埋めるとエスケープが要る）。
  for (const kind of ['issues', 'pull']) {
    const prefix = `${base}/${kind}/`
    if (!href.startsWith(prefix)) continue
    const rest = href.slice(prefix.length)
    if (/^\d+$/.test(rest)) return Number(rest)
  }
  return null
}
</script>

<template>
  <div class="issue-tab">
    <div class="md-toolbar">
      <span class="issue-num">#{{ tab?.number }}</span>
      <span v-if="detail" class="issue-state" :class="detail.state.toLowerCase()">{{ detail.state }}</span>
      <span class="issue-spacer" />
      <button class="tool-btn" :disabled="loading" :title="t('common.refresh')" @click="load()">
        <RefreshCw :size="14" :stroke-width="2" :class="{ spin: loading }" />
      </button>
      <!-- 書き込み（コメント・クローズ）は持たないので、ブラウザへ逃がす（#278）。 -->
      <button class="tool-btn" :disabled="!detail" :title="t('issues.openInBrowser')" @click="openInBrowser">
        <ExternalLink :size="14" :stroke-width="2" />
      </button>
    </div>

    <div class="issue-body">
      <div class="md-page md-body" @click="onContentClick">
        <!-- **読めていた中身は消さない**（パネルのエラー帯と同じ扱い）。更新が失敗しただけで
             読んでいた issue が消えると、開き直しても同じタブが返るので戻す手が無くなる。 -->
        <div v-if="error" class="issue-status error">{{ error }}</div>
        <div v-else-if="!detail" class="issue-status">{{ t('common.loading') }}</div>
        <template v-if="detail">
          <h1 class="issue-title">{{ detail.title }}</h1>
          <div class="issue-meta">
            <span>{{ detail.author }}</span>
            <span>{{ relativeDate(detail.createdAt) }}</span>
            <span
              v-for="label in detail.labels"
              :key="label.name"
              class="issue-label"
              :style="labelStyle(label.color)"
              >{{ label.name }}</span
            >
          </div>
          <!-- eslint-disable-next-line vue/no-v-html — DOMPurify を通してある -->
          <div v-html="bodyHtml" />

          <section v-for="(c, i) in comments" :key="c.url || i" class="issue-comment">
            <div class="issue-meta">
              <span>{{ c.author }}</span>
              <span>{{ relativeDate(c.createdAt) }}</span>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html — DOMPurify を通してある -->
            <div v-html="c.html" />
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.issue-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-primary);
}

/* ツールバー（`.md-toolbar`）とそのボタン（`.tool-btn`）、読み幅（`.md-page`）、
   本文の見た目（`.md-body`）、回転（`.spin`）はすべて共有（`theme.css`）。マニュアルタブと
   同じものを使う。 */
.issue-num {
  font-weight: 600;
}

.issue-state {
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
  background: var(--bg-tertiary);
}

.issue-state.open {
  background: var(--accent);
  color: #fff;
}

.issue-spacer {
  flex: 1;
}

.issue-body {
  flex: 1;
  overflow-y: auto;
}

.issue-status {
  color: var(--text-secondary);
  padding: 12px 0;
}

.issue-status.error {
  color: var(--danger);
  white-space: pre-wrap;
}

.issue-title {
  margin-top: 0;
}

.issue-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.issue-label {
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  line-height: 16px;
}

/* コメントは本文と同じ幅で、区切り線だけで分ける（GitHub の枠は情報を足さない）。 */
.issue-comment {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
</style>
