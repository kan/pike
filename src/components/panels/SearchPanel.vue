<script setup lang="ts">
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FileText,
  FolderSearch,
  Parentheses,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
} from 'lucide-vue-next'
import { computed, nextTick, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from '../../i18n'
import { openProjectPath } from '../../lib/openFile'
import { relativeToBase } from '../../lib/projectPaths'
import { useFileTreeStore } from '../../stores/fileTree'
import { useProjectStore } from '../../stores/project'
import { useSearchStore } from '../../stores/search'
import { useSidebarStore } from '../../stores/sidebar'
import type { SearchMatch, SearchOptions } from '../../types/search'
import { shellToPlatform } from '../../types/tab'
import ToolNotice from '../ToolNotice.vue'

const { t } = useI18n()

const searchStore = useSearchStore()
const projectStore = useProjectStore()
const fileTreeStore = useFileTreeStore()
const sidebar = useSidebarStore()

const query = ref('')
/**
 * 検索のトグル。**1 つのオブジェクトにまとめてある**ので、`toggle('caseSensitive')` の
 * ように名前で押せる（ref を 4 つ並べると、テンプレートでは値に展開されるため
 * 共通の切り替え関数へ渡せない）。
 */
const toggles = ref({ caseSensitive: false, wholeWord: false, isRegex: false, usePcre2: false })
const globInclude = ref('')
const globExclude = ref('')
/**
 * 含む / 除外の行を出すか（#396。VSCode の「…」と同じ）。
 *
 * **覚えない。** パネルは `v-if` でマウントされるので、glob の値そのものが他のパネルへ
 * 移った時点で消える（従来どおり）。開閉だけを覚えると、次に開いたときに空の欄が
 * 開きっぱなしになるだけになる。
 */
const showGlobs = ref(false)
/** 畳んでいても指定が効いていることを ⋯ の色で示す。 */
const hasGlob = computed(() => !!globInclude.value.trim() || !!globExclude.value.trim())
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// PCRE2 は正規表現のときだけ意味を持つ（`-F` では使うエンジンが変わるだけ）。
const pcre2Available = computed(() => (searchStore.backendInfo?.pcre2 ?? false) && toggles.value.isRegex)

/**
 * 置換の行（#401。VSCode の左端の ▸ と同じ）。**開いているあいだは、空の置換も置換**
 * （一致を消す）なので、検索に置換後の文字列を渡してプレビューを出す。覚えないのは
 * 含む / 除外の開閉と同じ理由（パネルは `v-if` で作り直される）。
 */
const showReplace = ref(false)
const replacement = ref('')
/** rg 15 以降だけ。grep と古い rg は `-r` を `--json` で返せない（Rust の `json_replacement`）。 */
const replaceAvailable = computed(() => searchStore.backendInfo?.replace ?? false)
const replaceMode = computed(() => showReplace.value && replaceAvailable.value)
const replaceInput = useTemplateRef<HTMLInputElement>('replaceInput')

function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => doSearch(), 300)
}

function currentOptions(): SearchOptions {
  return {
    query: query.value,
    isRegex: toggles.value.isRegex,
    caseSensitive: toggles.value.caseSensitive,
    wholeWord: toggles.value.wholeWord,
    // 正規表現かつ対応ビルドか、は Rust 側が最終的に見る（`is_regex && use_pcre2 && caps.pcre2`）。
    usePcre2: toggles.value.usePcre2,
    globInclude: globInclude.value || null,
    globExclude: globExclude.value || null,
    replacement: replaceMode.value ? replacement.value : null,
  }
}

function doSearch(): Promise<void> {
  // 待っている打鍵ぶんを捨てる。消さないと、トグルや Enter で即時検索した直後に
  // 同じ検索がもう 1 回走る（`searchSeq` は結果を捨てるだけで、rg は止まらない）。
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (!query.value.trim()) {
    searchStore.clear()
    return Promise.resolve()
  }
  return searchStore.search(currentOptions())
}

function toggleReplace() {
  showReplace.value = !showReplace.value
  // 開けばプレビューが、閉じればただの検索結果が要る。
  if (query.value.trim()) doSearch()
  if (showReplace.value) nextTick(() => replaceInput.value?.focus())
}

/**
 * 「すべて置換」。**条件は今の入力から渡す**（ストアは渡された条件で検索し直す）。
 * 待っている打鍵ぶんの検索は、置換のあとの検索し直しで足りるので捨てる。
 */
function onReplaceAll() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  void searchStore.replaceAll(currentOptions())
}

/** 結果の行を、残す部分・消える部分・入る部分に分ける（プレビュー）。 */
type Piece = { text: string; kind: 'keep' | 'old' | 'new' }
/** 一致より前をこれ以上残さない。行が長いと、一致が省略記号の向こうに隠れる。 */
const PREVIEW_LEAD = 24

function previewPieces(match: SearchMatch): Piece[] {
  const r = match.replace
  if (!r) return [{ text: match.content, kind: 'keep' }]
  const pieces: Piece[] = []
  let pos = 0
  const first = r.spans[0]?.start ?? 0
  if (first > PREVIEW_LEAD) {
    pos = first - PREVIEW_LEAD
    pieces.push({ text: '…', kind: 'keep' })
  }
  for (const s of r.spans) {
    if (s.start > pos) pieces.push({ text: match.content.slice(pos, s.start), kind: 'keep' })
    if (s.end > s.start) pieces.push({ text: match.content.slice(s.start, s.end), kind: 'old' })
    if (s.text) pieces.push({ text: s.text, kind: 'new' })
    pos = Math.max(pos, s.end)
  }
  if (pos < match.content.length) pieces.push({ text: match.content.slice(pos), kind: 'keep' })
  return pieces
}

/** 結果ごとの分け方。一覧の描き直し（`replacing` の切り替えなど）のたびに組み直さない。 */
const piecesOf = computed(() => new Map(searchStore.results.map((m) => [m, previewPieces(m)])))

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

/**
 * 範囲が変わったら検索し直す（#376。ファイルツリーの「このフォルダ内を検索」と、✕ で
 * 全体に戻したとき）。語が入っていなければ、入力欄にフォーカスが来る（`pendingOpen`）
 * ので打ち始めればよい。
 */
watch(
  () => searchStore.scopeRel,
  () => {
    if (query.value.trim()) doSearch()
  },
)

function openResult(match: { path: string; line: number }) {
  void openProjectPath(match.path, match.line).catch(() => {})
}

/**
 * 「対象」を押したとき（#407）。ファイルツリーのパネルへ切り替え、いまの範囲のフォルダを
 * 選んだ状態にする（親が畳まれていれば開く）。**絞り込みと解除の操作はあちらの右クリックに
 * しか無い**ので、ツールチップで教えるだけでなくそこまで連れて行く。
 */
function revealScope() {
  // **依頼を置いてから開く。** `revealFile` を直に呼ぶと、そのあと mount される
  // `FileTreePanel` の `onMounted` が展開と選択を捨てる（`fileTree.ts` の `pendingReveal`）。
  fileTreeStore.requestReveal(searchStore.searchRoot())
  sidebar.openPanel('files')
}

/** 表示用の相対パス。書き出し（`extractToTab`）と同じ `relativeToBase` で揃える。 */
function relativePath(fullPath: string): string {
  const project = projectStore.currentProject
  if (!project) return fullPath
  return relativeToBase(projectStore.activeRoot, fullPath, shellToPlatform(project.shell)) ?? fullPath
}

onUnmounted(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <div class="search-panel" data-testid="search-panel">
    <div class="search-input-area">
      <!--
        VSCode に寄せた配置（#396）。**オプションは入力欄の中（右端）**に置き、枠は
        `.search-field` が持つ。`padding-right` を空けて絶対配置する形にしないこと:
        PCRE2 のボタンは正規表現のときだけ出るので、空ける量が固定にならない。
      -->
      <!--
        置換の開閉（#401）は VSCode と同じく左端で、検索と置換の 2 行にまたがる。置換を
        作れない環境（grep）ではボタンごと出さない（押せないボタンを置かない）。
      -->
      <div class="search-main">
        <button
          v-if="replaceAvailable"
          class="option-btn side-btn replace-toggle"
          :title="t('search.toggleReplace')"
          data-testid="search-replace-toggle"
          @click="toggleReplace"
        >
          <ChevronDown v-if="showReplace" :size="14" :stroke-width="2" />
          <ChevronRight v-else :size="14" :stroke-width="2" />
        </button>
        <div class="search-fields">
          <div class="search-row">
            <!-- 枠と focus の見た目は共有の `.filter-row`（`theme.css`）。 -->
            <div class="filter-row search-field">
              <input
                ref="searchInput"
                v-model="query"
                class="filter-input search-input"
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
              </div>
            </div>
            <!--
              含む / 除外の開閉（VSCode の「…」）。**指定が入っていても畳める**。畳んだあいだも
              指定は効いたままなので、そのことは ⋯ の色で示す（`has-glob`）。
            -->
            <button
              class="option-btn side-btn glob-toggle"
              :class="{ active: showGlobs, 'has-glob': hasGlob }"
              :title="t('search.toggleGlobs')"
              data-testid="search-glob-toggle"
              @click="showGlobs = !showGlobs"
            ><Ellipsis :size="14" :stroke-width="2" /></button>
          </div>

          <!-- 置換の行（#401）。「すべて置換」は ⋯ の真下に置く。 -->
          <div v-if="replaceMode" class="search-row" data-testid="search-replace-row">
            <div class="filter-row search-field">
              <input
                ref="replaceInput"
                v-model="replacement"
                class="filter-input search-input"
                data-testid="search-replace-input"
                :placeholder="t('search.replacePlaceholder')"
                @input="onInput"
                @keydown.enter="doSearch"
              />
            </div>
            <button
              class="option-btn side-btn"
              :title="t('search.replaceAllTooltip')"
              :disabled="!query.trim() || searchStore.replacing"
              data-testid="search-replace-all"
              @click="onReplaceAll"
            ><ReplaceAll :size="14" :stroke-width="2" /></button>
          </div>

          <!-- 含む / 除外は 1 行ずつ（#396）。名前を左に置くので、例は placeholder へ回す。 -->
          <div v-if="showGlobs" class="glob-rows" data-testid="search-globs">
            <label class="glob-row">
              <span class="glob-label">{{ t('search.include') }}</span>
              <input
                v-model="globInclude"
                class="glob-input"
                :placeholder="t('search.includePlaceholder')"
                @input="onInput"
                @keydown.enter="doSearch"
              />
            </label>
            <label class="glob-row">
              <span class="glob-label">{{ t('search.exclude') }}</span>
              <input
                v-model="globExclude"
                class="glob-input"
                :placeholder="t('search.excludePlaceholder')"
                @input="onInput"
                @keydown.enter="doSearch"
              />
            </label>
          </div>
        </div>
      </div>
    </div>

    <!--
      検索の対象（#376）。**横断検索であることを入力欄の近くで言う**。フォルダに絞って
      いればそのパスと、プロジェクト全体に戻す ✕ を出す。rg / grep の表示はパネルの
      見出しにあるので、ここには置かない（以前は両方に出ていた）。
    -->
    <!-- 絞り込み方はファイルツリーの右クリックにしか無いので、ここで入口を教える（#400）。
         **押すとファイルツリーを開いて今の範囲を選ぶ**（#407）: 絞り込むのも解除するのも
         あちらの右クリックなので、教えるだけでなくそこまで連れて行く。
         ✕ は別のボタンにする（`<button>` の中に `<button>` は置けない）。 -->
    <div class="search-scope" data-testid="search-scope">
      <button
        class="scope-open"
        :title="searchStore.scopeRel ? `${searchStore.scopeRel}\n\n${t('search.scopeHint')}` : t('search.scopeHint')"
        @click="revealScope"
      >
        <FolderSearch :size="12" :stroke-width="2" />
        <span class="scope-label">{{ t('search.scopeLabel') }}</span>
        <span class="scope-path">{{ searchStore.scopeRel ?? t('search.scopeProject') }}</span>
      </button>
      <button
        v-if="searchStore.scopeRel"
        class="scope-clear"
        :title="t('search.scopeClear')"
        @click="searchStore.setScope(null)"
      ><X :size="12" :stroke-width="2" /></button>
    </div>

    <!-- WSL の ripgrep が無い・古い（inotify-tools の帯と同じ役目）。 -->
    <ToolNotice
      v-if="searchStore.ripgrepNoticeText"
      class="search-notice"
      data-testid="search-ripgrep-notice"
      :text="searchStore.ripgrepNoticeText"
      :action-label="searchStore.ripgrepActionLabel"
      @action="searchStore.installRipgrep()"
    />

    <div v-if="searchStore.searching" class="status">{{ t('search.searching') }}</div>
    <div v-else-if="searchStore.error" class="status error">{{ searchStore.error }}</div>
    <div v-else-if="!searchStore.results.length && query" class="status">{{ t('search.noResults') }}</div>
    <!-- 件数とその隣に書き出しのボタン（#396。右端へ寄せると、どの数字に対する操作か遠い）。 -->
    <div v-else-if="searchStore.results.length" class="result-summary">
      <span class="result-count">{{ t('search.resultCount', { count: String(searchStore.results.length) }) }}{{ searchStore.truncated ? '+' : '' }}</span>
      <button
        class="extract-btn"
        :title="t('search.extractTooltip')"
        :disabled="searchStore.extracting"
        data-testid="search-extract"
        @click="searchStore.extractToTab()"
      >
        <FileText :size="12" :stroke-width="2" />{{ t('search.extract') }}
      </button>
    </div>

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
        <!-- 置換のプレビュー（#401）。消える部分を打ち消し線、入る部分を緑で並べる。 -->
        <div class="result-content">
          <span v-for="(p, j) in piecesOf.get(match)" :key="j" :class="`piece-${p.kind}`">{{ p.text }}</span>
        </div>
        <button
          v-if="match.replace"
          class="row-action replace-line"
          :title="t('search.replaceLine')"
          :disabled="searchStore.replacing"
          data-testid="search-replace-line"
          @click.stop="searchStore.replaceMatch(match)"
        ><Replace :size="14" :stroke-width="2" /></button>
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

.search-main {
  display: flex;
  align-items: stretch;
  gap: 2px;
}

.search-fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.search-row {
  display: flex;
  align-items: stretch;
  gap: 4px;
}

/* 共有の `.filter-row` / `.filter-input` に、この欄だけの違いを足す（行の中で伸びること、
   絞り込みの欄より大きい文字）。枠と focus の見た目はあちらが持つ。 */
.search-field {
  flex: 1;
  min-width: 0;
}

.search-input {
  padding: 6px 0;
  font-size: 13px;
}

.search-options {
  display: flex;
  gap: 2px;
  align-items: center;
}

/* 入力欄の中に並ぶので枠は持たない（押せることは hover と active の塗りで示す）。 */
.option-btn {
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.option-btn:hover:not(:disabled) {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.option-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.option-btn.active {
  background: var(--accent);
  color: var(--on-accent);
}

/* 入力欄の外に並ぶボタン（⋯・「すべて置換」・置換の開閉）。見た目は `.option-btn` に乗せ、縦に伸ばす。 */
.side-btn {
  padding: 0 5px;
}

/* 置換の開閉（#401）。検索と置換の 2 行ぶんの高さを取る。 */
.replace-toggle {
  width: 16px;
  padding: 0;
}

/* 押している状態は「絞り込みが効いている」ではないので塗りを変える。 */
.glob-toggle.active {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

/* 畳んでいても指定が効いていることを色で示す。 */
.glob-toggle.has-glob {
  color: var(--accent);
}

.glob-toggle.active.has-glob {
  color: var(--accent);
}

.glob-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
}

.glob-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.glob-label {
  flex-shrink: 0;
  width: 3.5em;
  font-size: 11px;
  color: var(--text-secondary);
}

.glob-input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
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
  position: relative;
  padding: 4px 4px;
  cursor: pointer;
  border-radius: 3px;
}

.result-item:hover {
  background: var(--tab-hover-bg);
}

/* 行ごとの置換（#401）。本体は共有の `.row-action`、ここは出す契機と位置だけ。 */
.result-item:hover .row-action {
  opacity: 1;
}

.replace-line {
  position: absolute;
  top: 2px;
  right: 2px;
}

/* 置換のプレビュー。色は diff タブの文字単位の強調と揃える。 */
.piece-old {
  background: rgba(244, 71, 71, 0.3);
  text-decoration: line-through;
}

.piece-new {
  background: rgba(78, 201, 176, 0.3);
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

.search-scope {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 0;
}

/* 帯の中の 2 つのボタン（ファイルツリーを開く #407・プロジェクト全体へ戻す）。**見た目は
   帯のままにしたい**ので、どちらも枠も地も持たず、ホバーでだけ押せることを言う。 */
.scope-open,
.scope-clear {
  display: flex;
  align-items: center;
  padding: 1px 3px;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  border-radius: 3px;
}

.scope-open:hover,
.scope-clear:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.scope-open {
  gap: 4px;
  flex: 1;
  min-width: 0;
  /* 帯の他の要素と行がずれないよう、押せる範囲として足した padding を打ち消す。 */
  margin: -1px -3px;
  text-align: left;
}

.scope-path {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.scope-clear {
  flex-shrink: 0;
}

/* パネルは `gap` で間を取るので、帯自身の下の余白は要らない。 */
.search-notice {
  margin-bottom: 0;
}

.result-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-secondary);
}

.result-count {
  flex-shrink: 0;
}

.extract-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
}

.extract-btn:hover:not(:disabled) {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.extract-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
