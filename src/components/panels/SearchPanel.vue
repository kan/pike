<script setup lang="ts">
import { CaseSensitive, Parentheses, Regex, WholeWord } from 'lucide-vue-next'
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from '../../i18n'
import { pathSep } from '../../lib/paths'
import { useProjectStore } from '../../stores/project'
import { useSearchStore } from '../../stores/search'
import { useTabStore } from '../../stores/tabs'

const { t } = useI18n()

const searchStore = useSearchStore()
const projectStore = useProjectStore()
const tabStore = useTabStore()

const query = ref('')
/**
 * 検索のトグル。**1 つのオブジェクトにまとめてある**ので、`toggle('caseSensitive')` の
 * ように名前で押せる（ref を 4 つ並べると、テンプレートでは値に展開されるため
 * 共通の切り替え関数へ渡せない）。
 */
const toggles = ref({ caseSensitive: false, wholeWord: false, isRegex: false, usePcre2: false })
const globInclude = ref('')
const globExclude = ref('')
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// PCRE2 は正規表現のときだけ意味を持つ（`-F` では使うエンジンが変わるだけ）。
const pcre2Available = computed(() => (searchStore.backendInfo?.pcre2 ?? false) && toggles.value.isRegex)

function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => doSearch(), 300)
}

function doSearch() {
  // 待っている打鍵ぶんを捨てる。消さないと、トグルや Enter で即時検索した直後に
  // 同じ検索がもう 1 回走る（`searchSeq` は結果を捨てるだけで、rg は止まらない）。
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (!query.value.trim()) {
    searchStore.clear()
    return
  }
  searchStore.search({
    query: query.value,
    isRegex: toggles.value.isRegex,
    caseSensitive: toggles.value.caseSensitive,
    wholeWord: toggles.value.wholeWord,
    // 正規表現かつ対応ビルドか、は Rust 側が最終的に見る（`is_regex && use_pcre2 && caps.pcre2`）。
    usePcre2: toggles.value.usePcre2,
    globInclude: globInclude.value || null,
    globExclude: globExclude.value || null,
  })
}

/** トグルは押した時点で検索し直す（次の打鍵を待たせない）。 */
function toggle(key: keyof typeof toggles.value) {
  toggles.value[key] = !toggles.value[key]
  if (query.value.trim()) doSearch()
}

const searchInput = useTemplateRef<HTMLInputElement>('searchInput')

/**
 * キーで開かれたときの受け取り（#307）。入力欄にフォーカスを移し、選択していた文字列が
 * あれば入れて検索する。
 *
 * **`immediate` の 1 本で、マウント直後と押し直しの両方を受ける。** パネルは遅延マウント
 * なので初回はアクションのほうが先に走り、2 回目以降は既にマウント済み。合図は押すたびに
 * オブジェクトごと差し替わるので、同じ内容でも再発火する。
 */
watch(
  () => searchStore.pendingOpen,
  (req) => {
    if (!req) return
    // 受け取ったら消す。残すと、閉じて開き直したときにここが古い合図を拾う。
    searchStore.pendingOpen = null
    // **結果が既にその語のものなら検索しない。** `searchSeq` は遅れて届いた結果を捨てる
    // だけで子プロセスは止めないので、押し直すたびに全ツリーの rg が積み上がる。
    if (req.seed !== null) {
      query.value = req.seed
      if (searchStore.resultsFor !== req.seed) doSearch()
    }
    // 選択した状態にしておくと、押し直してから打ったときにそのまま置き換わる。
    // `select()` だけでもたいてい focus は移るが、仕様上は選択するだけなので当てにしない。
    nextTick(() => {
      searchInput.value?.focus()
      searchInput.value?.select()
    })
  },
  { immediate: true },
)

// バックエンドはシェルごとに違いうるので、開いたときとプロジェクトが変わったときに聞く。
// **`detectBackend` はべき等**（検出済みのシェルなら何もしない）なので、ここでガードは要らない。
// パネルはサイドバーの `v-else-if` なので、他のパネルへ移るとアンマウントされる。
watch(
  () => projectStore.currentProject?.id,
  () => searchStore.detectBackend(),
  { immediate: true },
)

function openResult(match: { path: string; line: number }) {
  const project = projectStore.currentProject
  if (!project) return
  const s = pathSep(project.shell)
  const fullPath =
    match.path.startsWith('/') || match.path.includes(':') ? match.path : projectStore.activeRoot + s + match.path
  tabStore.addEditorTab({ path: fullPath, initialLine: match.line })
}

function relativePath(fullPath: string): string {
  const root = projectStore.activeRoot
  if (!root) return fullPath
  const s = pathSep(projectStore.currentProject?.shell)
  if (fullPath.startsWith(root + s)) return fullPath.slice(root.length + s.length)
  return fullPath
}

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <div class="search-panel" data-testid="search-panel">
    <div class="search-input-area">
      <input
        ref="searchInput"
        v-model="query"
        class="search-input"
        data-testid="search-input"
        :placeholder="t('search.placeholder')"
        @input="onInput"
        @keydown.enter="doSearch"
      />
      <div class="search-options">
        <button
          class="option-btn"
          :class="{ active: toggles.caseSensitive }"
          :title="t('search.matchCase')"
          data-testid="search-case"
          @click="toggle('caseSensitive')"
        ><CaseSensitive :size="14" :stroke-width="2" /></button>
        <button
          class="option-btn"
          :class="{ active: toggles.wholeWord }"
          :title="t('search.wholeWord')"
          data-testid="search-whole-word"
          @click="toggle('wholeWord')"
        ><WholeWord :size="14" :stroke-width="2" /></button>
        <button
          class="option-btn"
          :class="{ active: toggles.isRegex }"
          :title="t('search.useRegex')"
          @click="toggle('isRegex')"
        ><Regex :size="14" :stroke-width="2" /></button>
        <button
          v-if="pcre2Available"
          class="option-btn"
          :class="{ active: toggles.usePcre2 }"
          :title="t('search.usePcre2')"
          data-testid="search-pcre2"
          @click="toggle('usePcre2')"
        ><Parentheses :size="14" :stroke-width="2" /></button>
        <input
          v-model="globInclude"
          class="glob-input"
          :placeholder="t('search.include')"
          @input="onInput"
          @keydown.enter="doSearch"
        />
        <input
          v-model="globExclude"
          class="glob-input"
          :placeholder="t('search.exclude')"
          @input="onInput"
          @keydown.enter="doSearch"
        />
      </div>
    </div>

    <div
      v-if="searchStore.backend"
      class="backend-badge"
      :title="searchStore.backendInfo?.version ?? ''"
    >{{ searchStore.backend }}<span v-if="searchStore.backendInfo?.version" class="backend-version">{{ searchStore.backendInfo.version }}</span></div>

    <div v-if="searchStore.searching" class="status">{{ t('search.searching') }}</div>
    <div v-else-if="searchStore.error" class="status error">{{ searchStore.error }}</div>
    <div v-else-if="!searchStore.results.length && query" class="status">{{ t('search.noResults') }}</div>

    <div class="results-list">
      <div
        v-for="(match, i) in searchStore.results"
        :key="i"
        class="result-item"
        @click="openResult(match)"
      >
        <div class="result-location">
          <span class="result-path">{{ relativePath(match.path) }}</span>
          <span class="result-line">:{{ match.line }}</span>
        </div>
        <div class="result-content">{{ match.content }}</div>
      </div>
    </div>

    <div v-if="searchStore.truncated" class="status truncated">
      {{ t('search.truncated') }}
    </div>
  </div>
</template>

<style scoped>
.search-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.search-input-area {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.search-input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  border-radius: 3px;
  outline: none;
}

.search-input:focus {
  border-color: var(--accent);
}

.search-options {
  display: flex;
  gap: 4px;
  align-items: center;
}

.option-btn {
  padding: 2px 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.option-btn.active {
  background: var(--accent);
  color: var(--text-active);
  border-color: var(--accent);
}

.glob-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 11px;
  border-radius: 3px;
  outline: none;
}

.glob-input:focus {
  border-color: var(--accent);
}

.results-list {
  display: flex;
  flex-direction: column;
}

.result-item {
  padding: 4px 4px;
  cursor: pointer;
  border-radius: 3px;
}

.result-item:hover {
  background: var(--tab-hover-bg);
}

.result-location {
  font-size: 11px;
}

.result-path {
  color: var(--accent);
}

.result-line {
  color: var(--text-secondary);
}

.result-content {
  font-size: 12px;
  font-family: "PlemolJP Console NF", "Cascadia Code", monospace;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 8px 0;
}

.status.error {
  color: var(--danger);
}

.status.truncated {
  font-size: 11px;
  padding: 4px 0;
}

/* 版はバッジの中に薄く添える。どの ripgrep が使われているかで出せる機能が変わるので
   （WSL は distro のもの、#304）、パネルから読めるようにしてある。 */
.backend-version {
  opacity: 0.7;
}

.backend-version::before {
  content: ' ';
}

.backend-badge {
  font-size: 10px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 3px;
  padding: 1px 6px;
  align-self: flex-start;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}
</style>
