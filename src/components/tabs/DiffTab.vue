<script setup lang="ts">
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from '../../i18n'
import { parseDiff } from '../../lib/diffParser'
import { collectMatches, renderTokens } from '../../lib/diffSearch'
import { hasMod, normalizedKey } from '../../lib/keys'
import { openPathInTab } from '../../lib/openFile'
import { joinPath, pathSep } from '../../lib/paths'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import type { DiffTab } from '../../types/tab'
import WrapToggle from '../editor/WrapToggle.vue'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const settingsStore = useSettingsStore()

const tab = computed(() => tabStore.tabs.find((t): t is DiffTab => t.id === props.tabId && t.kind === 'diff'))

const parsedLines = computed(() => (tab.value ? parseDiff(tab.value.diff, { charLevel: true }) : []))

const isBinaryDiff = computed(() => tab.value?.diff.includes('Binary files') ?? false)

// --- 折り返しと横幅（#272）-------------------------------------------------
// 折り返さないときは、いちばん長い行が収まる幅を table に持たせる。`table-layout: fixed`
// のまま `width: 100%` だと長い行はセル内で切られ、スクロールすべき領域そのものが
// 生まれない（＝横スクロールが効かない）。`auto` に替えれば幅は自動で決まるが、数千行の
// diff で全セルの測定が走るので、幅を計算して渡す側を採る。
const wordWrapOverride = ref<boolean | null>(null)

/**
 * 「自動」が折り返すと決めた（この diff のあいだ保持する）。**live な computed に
 * しないこと**: 折り返すと横のはみ出しが消えるので、はみ出し量から直に導くと ON と OFF を
 * 往復する。
 */
const autoWrapped = ref(false)
/** 折り返さない状態で横にスクロールできるか。折り返しボタンを目立たせる条件。 */
const canScrollX = ref(false)

/** これを超えてはみ出すなら「自動」は折り返して開く（画面幅の何倍か）。 */
const AUTO_WRAP_RATIO = 2

const wordWrapOn = computed(() => {
  if (wordWrapOverride.value !== null) return wordWrapOverride.value
  const mode = settingsStore.diffWordWrap
  return mode === 'on' || (mode === 'auto' && autoWrapped.value)
})

/**
 * はみ出し量は**ブラウザに測らせる**（`scrollWidth / clientWidth`）。こちらで計算した
 * `--content-ch` はセル数の見積もりで、フォントの実寸もペインの幅も知らない。
 *
 * 折り返している間は測らない: そのときの `scrollWidth` は「折り返した結果」で、元の
 * 長さを表さない。
 */
function measureOverflow() {
  const el = scrollEl.value
  if (!el) return
  if (wordWrapOn.value) {
    canScrollX.value = false
    return
  }
  const ratio = el.clientWidth > 0 ? el.scrollWidth / el.clientWidth : 1
  canScrollX.value = ratio > 1.01
  if (settingsStore.diffWordWrap === 'auto' && ratio > AUTO_WRAP_RATIO) autoWrapped.value = true
}

// 中身が変われば測り直す。**手動の上書きは残す**（そのタブに対する明示的な選択なので、
// 差分が更新されるたびに覆さない）。
watch(parsedLines, () => {
  autoWrapped.value = false
  void nextTick(measureOverflow)
})

// 折り返しを切り替えたときも測り直す。**`.diff-scroll` は `inset: 0` で自分の箱が
// 変わらないので ResizeObserver は鳴らない。** これが無いと、自動で折り返して開いた
// diff を手で折り返し OFF にしたときに `canScrollX` が false のままになり、横スクロール
// できるのにボタンが薄いまま（`prominent` が防ごうとしている状態そのもの）になる。
watch(wordWrapOn, () => void nextTick(measureOverflow))

/**
 * 等幅フォントのセル数で測った表示幅。`ch` は「0 の送り幅」＝ 1 セルなので、この値を
 * そのまま `ch` として使える。全角は 2 セル、タブは 8 セル（`tab-size` を指定していない
 * ので CSS の既定値。エディタの `editorTabSize` とは無関係）で数える。どちらも上限側に
 * 倒してある: 多めに見積もっても余分にスクロールできるだけだが、少ないとセルの
 * `overflow: hidden` が黙って切る。
 *
 * ASCII を先に片付けるのは、既定（折り返し OFF）では diff を開くたびに全文を 1 度なめる
 * ため。code point の反復子は 1 文字ごとに文字列を作るので、素の実装の 4 倍かかる。
 */
function displayWidth(text: string): number {
  let w = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x7f) {
      w += c === 9 ? 8 : 1 // 9 = タブ
      continue
    }
    const cp = text.codePointAt(i) ?? c
    if (cp > 0xffff) i++ // サロゲートペアの後半を飛ばす
    w += isWideChar(cp) ? 2 : 1
  }
  return w
}

/** East Asian Wide / Fullwidth と絵文字のおおまかな範囲（2 セルぶんの幅を持つもの）。 */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

const maxDisplayWidth = computed(() => {
  let max = 0
  for (const line of parsedLines.value) {
    for (const side of [line.left, line.right]) {
      let w = 0
      for (const seg of side.segments) w += displayWidth(seg.text)
      if (w > max) max = w
    }
  }
  return max
})

// 幅の計算は CSS 側（`.diff-table`）。ここが渡すのは最長行のセル数だけで、行番号列や
// padding のぶんはそれらを宣言している場所で足す。折り返し中は読まないので、`maxDisplayWidth`
// の走査も走らない。
const tableStyle = computed(() => (wordWrapOn.value ? undefined : { '--content-ch': String(maxDisplayWidth.value) }))

/**
 * Open the working-tree copy of the file this diff is about, in whatever tab
 * kind fits it. A binary diff has nothing to show, but the file itself is often
 * viewable (an image, a PDF). Always the current file, including on a commit's
 * diff — the commit's own revision is reachable from the Git panel.
 */
async function openWorkingCopy() {
  const projectStore = useProjectStore()
  const root = projectStore.activeRoot
  if (!tab.value || !root) return
  const path = joinPath(root, tab.value.filePath, pathSep(projectStore.currentProject?.shell))
  await openPathInTab({ path })
}

// --- Search (#176) -------------------------------------------------------
const showSearch = ref(false)
const query = ref('')
const caseSensitive = ref(false)
const currentIndex = ref(0)
const searchInput = ref<HTMLInputElement>()
const scrollEl = ref<HTMLElement>()

const matches = computed(() => collectMatches(parsedLines.value, query.value, caseSensitive.value))

// Cell-local match ranges keyed by `${row}:${side}`, carrying each match's
// global index so the renderer and navigation agree on which match is current.
const cellRanges = computed(() => {
  const map = new Map<string, { start: number; end: number; index: number }[]>()
  matches.value.forEach((m, index) => {
    const key = `${m.row}:${m.side}`
    const list = map.get(key)
    const range = { start: m.start, end: m.end, index }
    if (list) list.push(range)
    else map.set(key, [range])
  })
  return map
})

// One entry per row, each a [left, right] pair of cells. Tokens don't depend on
// currentIndex — the active match is styled from the token's matchIndex in the
// template, so navigation doesn't re-tokenize.
const rows = computed(() =>
  parsedLines.value.map((line, row) =>
    (['left', 'right'] as const).map((side) => ({
      type: line[side].type,
      num: line[side].num,
      tokens: renderTokens(line[side].segments, cellRanges.value.get(`${row}:${side}`) ?? []),
    })),
  ),
)

const matchInfo = computed(() => {
  if (!query.value) return ''
  if (matches.value.length === 0) return t('search.noResults')
  return `${currentIndex.value + 1} / ${matches.value.length}`
})

function scrollToCurrent() {
  nextTick(() => {
    scrollEl.value?.querySelector(`[data-match="${currentIndex.value}"]`)?.scrollIntoView({ block: 'center' })
  })
}

function step(delta: number) {
  const n = matches.value.length
  if (n === 0) return
  currentIndex.value = (currentIndex.value + delta + n) % n
  scrollToCurrent()
}

function openSearch() {
  showSearch.value = true
  nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
  })
}

function closeSearch() {
  showSearch.value = false
}

// Reset to the first match whenever the query or case mode changes.
watch([query, caseSensitive], () => {
  currentIndex.value = 0
  if (matches.value.length > 0) scrollToCurrent()
})

// A rebuilt diff can shrink the match list under the cursor.
watch(matches, (m) => {
  if (currentIndex.value >= m.length) currentIndex.value = 0
})

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    step(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch()
  }
}

// Tabs stay mounted (v-show), so only react to Ctrl+F when this diff tab is the
// active one — otherwise every mounted DiffTab would grab the shortcut.
function onKeydown(e: KeyboardEvent) {
  // **Shift も見る。** `Ctrl+Shift+F`（検索パネル、#259）は別のショートカットで、
  // どちらも window のリスナーなので、見ないとタブ内検索まで同時に開いて焦点を奪う。
  if (hasMod(e) && !e.altKey && !e.shiftKey && normalizedKey(e) === 'f') {
    if (tabStore.activeTabId !== props.tabId) return
    e.preventDefault()
    openSearch()
  }
}

// ペインが狭くなれば「自動」の条件を満たすことがある（タブは v-show で生き続けるので、
// 表示されていない間のサイズ 0 は `clientWidth > 0` のガードで弾く）。
//
// **要素が入れ替わるたびに張り直す。** `addDiffTab` はタブを使い回すので、最初に空の
// 差分（変更なし / バイナリ）で開いたタブには `scrollEl` がまだ無い。mount のときだけ
// 張ると、そのタブは以後ずっと監視されないままになる。
let resizeObserver: ResizeObserver | null = null

watch(
  scrollEl,
  (el) => {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (!el) return
    resizeObserver = new ResizeObserver(measureOverflow)
    resizeObserver.observe(el)
    void nextTick(measureOverflow)
  },
  { immediate: true },
)

onMounted(() => window.addEventListener('keydown', onKeydown))

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="diff-tab">
    <div v-if="!tab" class="empty">{{ t('diff.notFound') }}</div>
    <div v-else-if="!parsedLines.length && tab.diff" class="empty">
      <template v-if="isBinaryDiff">
        <span>{{ t('diff.binary') }}</span>
        <button class="open-file-btn" @click="openWorkingCopy">{{ t('diff.openCurrentFile') }}</button>
      </template>
      <span v-else>{{ tab.diff.slice(0, 200) }}</span>
    </div>
    <div v-else-if="!parsedLines.length" class="empty">{{ t('diff.noChanges') }}</div>
    <template v-else>
      <div ref="scrollEl" class="diff-scroll">
        <table class="diff-table" :class="{ wrap: wordWrapOn }" :style="tableStyle">
          <tbody>
            <tr v-for="(row, i) in rows" :key="i" class="diff-row">
              <template v-for="(cell, s) in row" :key="s">
                <td class="line-num" :class="cell.type">{{ cell.num ?? "" }}</td>
                <td class="line-content" :class="cell.type"><template
                  v-for="(tok, j) in cell.tokens" :key="j"
                ><span :class="{ 'hl': tok.diffHl, 'search-hl': tok.matchIndex >= 0, 'search-current': tok.matchIndex === currentIndex }" :data-match="tok.matchIndex >= 0 ? tok.matchIndex : undefined">{{ tok.text }}</span></template></td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- 検索パネルと同じ角に出るので、開いているあいだは隠す。 -->
      <div v-if="!showSearch" class="hover-toolbar" :class="{ prominent: canScrollX }">
        <WrapToggle :on="wordWrapOn" @toggle="wordWrapOverride = !wordWrapOn" />
      </div>
      <div v-if="showSearch" class="diff-search popup-surface">
        <input
          ref="searchInput"
          v-model="query"
          class="search-field"
          type="text"
          spellcheck="false"
          :placeholder="t('search.placeholder')"
          @keydown="onSearchKeydown"
        />
        <button
          class="search-toggle-btn"
          :class="{ active: caseSensitive }"
          :title="t('search.matchCase')"
          @click="caseSensitive = !caseSensitive"
        >
          <CaseSensitive :size="14" :stroke-width="2" />
        </button>
        <span class="search-match-info">{{ matchInfo }}</span>
        <button class="search-icon-btn" :title="t('search.prevMatch')" @click="step(-1)"><ChevronUp :size="14" :stroke-width="2" /></button>
        <button class="search-icon-btn" :title="t('search.nextMatch')" @click="step(1)"><ChevronDown :size="14" :stroke-width="2" /></button>
        <button class="search-icon-btn" :title="t('search.close')" @click="closeSearch"><X :size="14" :stroke-width="2" /></button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diff-tab {
  position: absolute;
  inset: 0;
  background: var(--bg-primary);
}

.diff-scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
}

/* 折り返さないときの幅は「最長行のセル数 × 2 列 ＋ 行番号列 ＋ padding」。`--content-ch` は
   DiffTab.vue が渡す（最長行のセル数）。**この計算はここに置くこと**: 足しているのは
   すぐ下の `.line-num` / `.line-content` の値そのもので、JS 側に px の合計を持たせると、
   padding を変えたときに黙って横スクロールの範囲が足りなくなる。 */
.diff-table {
  --num-w: 40px;
  --num-pad: 6px;
  --content-pad: 8px;
  width: max(100%, calc(var(--content-ch, 0) * 1ch * 2 + (var(--num-w) + var(--num-pad) * 2) * 2 + var(--content-pad) * 4));
  border-collapse: collapse;
  font-family: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  line-height: 1.5;
  table-layout: fixed;
}

.diff-row {
  height: 20px;
}

.line-num {
  width: var(--num-w);
  min-width: var(--num-w);
  padding: 0 var(--num-pad);
  text-align: right;
  color: var(--text-secondary);
  opacity: 0.5;
  user-select: none;
  border-right: 1px solid var(--border);
  font-size: 11px;
}

.line-content {
  padding: 0 var(--content-pad);
  white-space: pre;
  overflow: hidden;
}

/* 横にスクロールできるときは折り返しボタンを出したままにする（#272）。既定の 6px の
   スクロールバーは下端にあって気付きにくいので、切り替えられること自体を見せる。 */
.hover-toolbar.prominent {
  opacity: 1;
}

/* 横スクロールが要るときだけ、そのバーを少し太くする（全体の細いスクロールバーは
   `theme.css` のまま）。 */
.diff-scroll::-webkit-scrollbar:horizontal {
  height: 10px;
}

.diff-scroll::-webkit-scrollbar-thumb:horizontal {
  background: var(--scrollbar-thumb-hover);
}

/* 折り返しあり（#272）。行の高さが可変になるので `.diff-row` の固定高も外す。 */
.diff-table.wrap {
  width: 100%;
}

.diff-table.wrap .line-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.diff-table.wrap .diff-row {
  height: auto;
}



.line-content:nth-child(2) {
  border-right: 1px solid var(--border);
}

.del {
  background: rgba(244, 71, 71, 0.1);
}

.del .hl {
  background: rgba(244, 71, 71, 0.3);
  border-radius: 2px;
}

.add {
  background: rgba(78, 201, 176, 0.1);
}

.add .hl {
  background: rgba(78, 201, 176, 0.3);
  border-radius: 2px;
}

.hunk {
  background: rgba(0, 122, 204, 0.08);
  color: var(--accent);
}

.search-hl {
  background: rgba(255, 200, 0, 0.35);
  border-radius: 2px;
}

.search-current {
  background: rgba(255, 160, 0, 0.85);
  color: #1a1a1a;
  border-radius: 2px;
}

.empty {
  background: var(--bg-secondary);
}

.diff-tab > .empty {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 14px;
}

.open-file-btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
}

.open-file-btn:hover {
  background: var(--accent);
  color: var(--text-active);
  border-color: var(--accent);
}

/* Floating search panel (mirrors the editor's search look) */
.diff-search {
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.search-field {
  width: 180px;
  padding: 3px 6px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.search-field:focus {
  border-color: var(--accent);
}

.search-match-info {
  min-width: 56px;
  padding: 0 4px;
  color: var(--text-secondary);
  font-size: 11px;
  text-align: center;
  white-space: nowrap;
}

.search-icon-btn,
.search-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
}

.search-icon-btn:hover,
.search-toggle-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.search-toggle-btn.active {
  background: var(--accent);
  color: #fff;
}
</style>
