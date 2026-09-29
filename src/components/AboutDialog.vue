<script setup lang="ts">
/**
 * About（#420）。Pike のバージョンと更新の確認、配布物に入っている依存のライセンス
 * （クレジット）を出す。
 *
 * **クレジットは開いたときに読み、閉じたら手放す。** 一覧は `scripts/gen-credits.mjs` が作る
 * `assets/credits.json`（600 件ほどで約 1MB、うち 9 割が本文）で、`?url` で資産として出して
 * おき `fetch` する。`import` すると起動時のバンドルに入るうえ、型検査が巨大な JSON の型を
 * 推論することになる。このコンポーネントは常にマウントされているので、持ったままにすると
 * 一度開いただけで本文がアプリを閉じるまで残る。読み直しはローカルの資産なので数 ms で済む。
 */
import { ExternalLink, Search } from 'lucide-vue-next'
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue'
import creditsUrl from '../assets/credits.json?url'
import { useAboutModal } from '../composables/useAboutModal'
import { useUpdater } from '../composables/useUpdater'
import { useI18n } from '../i18n'
import { isWebUrl } from '../lib/format'
import { PIKE_REPO_URL } from '../lib/manual'
import { useOverlay } from '../lib/overlay'
import { useTabStore } from '../stores/tabs'
import UpdateControls from './panels/UpdateControls.vue'

/** `scripts/gen-credits.mjs` の出力の 1 件。 */
interface CreditPackage {
  name: string
  version: string
  /** SPDX の式（`MIT OR Apache-2.0`）。古い書き方（`MIT/Apache-2.0`）もそのまま載る。 */
  license: string
  source: 'rust' | 'npm' | 'binary'
  url: string
  /** `texts` の添字。同じ本文は 1 つにまとめてある。 */
  texts: number[]
  /** 本文を同梱していないので、SPDX の標準文で補ったもの。 */
  standard?: boolean
  authors?: string
}

/** 画面で使う形。行のキーと絞り込みの対象は読み込んだときに 1 回だけ作る。 */
interface CreditRow extends CreditPackage {
  key: string
  haystack: string
}

const { t } = useI18n()
const { visible } = useAboutModal()
// 手前に浮くものは数える（#396。ブラウザのタブの子 webview を隠すため）。
useOverlay(() => visible.value)
const updater = useUpdater()
const tabStore = useTabStore()
const panelRef = ref<HTMLDivElement>()

/** 読み込んだクレジット。中身は書き換えないので、深いリアクティブにしない。 */
const credits = shallowRef<{ rows: CreditRow[]; texts: string[] } | null>(null)
const loadError = ref('')
const filter = ref('')
/** 本文を開いている行のキー。 */
const expanded = reactive(new Set<string>())

async function loadCredits() {
  loadError.value = ''
  try {
    const res = await fetch(creditsUrl)
    if (!res.ok) throw new Error(`${res.status}`)
    const data = (await res.json()) as { packages: CreditPackage[]; texts: string[] }
    // 読んでいるあいだに閉じられたら捨てる。
    if (!visible.value) return
    credits.value = {
      rows: data.packages.map((p) => ({
        ...p,
        key: `${p.source}:${p.name}@${p.version}`,
        haystack: `${p.name}\n${p.license}`.toLowerCase(),
      })),
      texts: data.texts,
    }
  } catch (e) {
    loadError.value = String(e)
  }
}

watch(visible, (show) => {
  if (!show) {
    credits.value = null
    expanded.clear()
    filter.value = ''
    return
  }
  void loadCredits()
  nextTick(() => panelRef.value?.focus())
})

const shown = computed(() => {
  const rows = credits.value?.rows ?? []
  const q = filter.value.trim().toLowerCase()
  return q ? rows.filter((r) => r.haystack.includes(q)) : rows
})

function toggle(key: string) {
  if (!expanded.delete(key)) expanded.add(key)
}

const SOURCE_LABEL: Record<CreditPackage['source'], string> = {
  rust: 'Rust',
  npm: 'npm',
  binary: 'bin',
}

/** ブラウザのタブで開き、About は閉じる（開いたままだとタブが隠れる）。 */
function openInTab(url: string) {
  visible.value = false
  tabStore.addBrowserTab(url)
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    visible.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay ui-zoom" @mousedown.self="visible = false" @keydown="onKeyDown">
      <div ref="panelRef" class="modal-panel about-panel popup-surface" tabindex="-1">
        <div class="modal-header">
          <span class="modal-title">{{ t('about.title') }}</span>
          <button class="modal-close" @click="visible = false">&times;</button>
        </div>
        <div class="about-body">
          <div class="about-app">
            <div class="app-name">Pike</div>
            <div class="app-version">{{ updater.versionLabel.value }}</div>
            <!-- 更新の確認（設定画面の「バージョン情報」と同じもの）。 -->
            <UpdateControls class="app-update" />
            <div class="muted">© 2025-2026 Kan Fushihara · {{ t('about.license', { license: 'MIT' }) }}</div>
            <button class="link-btn about-link" @click="openInTab(PIKE_REPO_URL)">
              <ExternalLink :size="12" />
              GitHub
            </button>
          </div>

          <div class="credits-head">
            <h4 class="section-title">{{ t('about.credits') }}</h4>
            <span v-if="credits" class="muted">{{ t('about.creditsCount', { count: credits.rows.length }) }}</span>
          </div>
          <p class="muted">{{ t('about.creditsHint') }}</p>
          <div class="filter-row">
            <Search :size="12" :stroke-width="2" class="filter-icon" />
            <input v-model="filter" class="filter-input" spellcheck="false" :placeholder="t('about.filterPlaceholder')" />
          </div>

          <div v-if="loadError" class="credits-error">{{ t('about.loadError') }}: {{ loadError }}</div>
          <div v-else-if="!credits" class="muted">{{ t('about.loading') }}</div>
          <div v-else-if="shown.length === 0" class="muted">{{ t('about.noMatch') }}</div>
          <ul v-else class="credits-list">
            <li v-for="r in shown" :key="r.key">
              <button class="credit-row" :aria-expanded="expanded.has(r.key)" @click="toggle(r.key)">
                <span class="credit-name">{{ r.name }}</span>
                <span class="credit-version">{{ r.version }}</span>
                <span class="credit-source">{{ SOURCE_LABEL[r.source] }}</span>
                <span class="credit-license">{{ r.license }}</span>
              </button>
              <!-- 本文は開いた行だけ描く（全部描くと 600 件ぶんの本文が DOM に載る）。 -->
              <div v-if="expanded.has(r.key)" class="credit-detail">
                <button v-if="isWebUrl(r.url)" class="link-btn about-link" @click="openInTab(r.url)">
                  <ExternalLink :size="12" />
                  {{ r.url }}
                </button>
                <p v-if="r.standard" class="credit-note">
                  {{ t('about.standardText') }}
                  <template v-if="r.authors">{{ t('about.authors', { authors: r.authors }) }}</template>
                </p>
                <pre v-for="i in r.texts" :key="i" class="credit-text">{{ credits.texts[i] }}</pre>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 枠（`.modal-*`）・`.link-btn`・`.filter-row` は `theme.css`。 */
/* 高さはウィンドウの半分まで。スクロールするのは依存の一覧だけで、上のバージョンと絞り込みは
   動かさない。 */
.about-panel {
  width: 640px;
  max-width: calc(100vw - 40px);
  max-height: 50vh;
}

/* 一覧が `min-height` を割るほど狭いウィンドウでだけ、全体をスクロールさせる。 */
.about-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.about-app {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}

.app-name {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-active);
}

.app-version {
  font-size: 13px;
  color: var(--text-primary);
}

.app-update {
  margin: 4px 0;
  flex-wrap: wrap;
}

.muted {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

/* アイコンと並べ、長い URL は折り返す。 */
.about-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  word-break: break-all;
  text-align: left;
}

.credits-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 4px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0;
  letter-spacing: 0.5px;
}

.credits-error {
  font-size: 12px;
  color: var(--danger);
}

.credits-list {
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--border);
}

.credit-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 3px 4px;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.credit-row:hover {
  background: var(--bg-tertiary);
}

.credit-name,
.credit-version,
.credit-source {
  flex-shrink: 0;
}

.credit-version,
.credit-source,
.credit-license {
  color: var(--text-secondary);
}

.credit-source {
  font-size: 10px;
  padding: 0 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
}

.credit-license {
  margin-left: auto;
  text-align: right;
}

.credit-detail {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 4px 10px 12px;
}

.credit-note {
  margin: 0;
  font-size: 11px;
  color: var(--text-secondary);
}

.credit-text {
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 8px;
  max-height: 240px;
  overflow: auto;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  color: var(--text-primary);
}
</style>
