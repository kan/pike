<script setup lang="ts">
import { CaseSensitive, ChevronDown, ChevronsDownUp, ChevronUp, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from '../../i18n'
import { type Expanded, expandDiff, type Gap, matchesDiff } from '../../lib/diffExpand'
import { parseDiff } from '../../lib/diffParser'
import { collectMatches, renderTokens } from '../../lib/diffSearch'
import { displayWidth } from '../../lib/displayWidth'
import { hasMod, normalizedKey } from '../../lib/keys'
import { openPathInTab } from '../../lib/openFile'
import { joinPath, pathSep } from '../../lib/paths'
import { fsReadFile, gitShowFile } from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { DiffTab } from '../../types/tab'
import WrapToggle from '../editor/WrapToggle.vue'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const settingsStore = useSettingsStore()

const tab = computed(() => tabStore.tabs.find((t): t is DiffTab => t.id === props.tabId && t.kind === 'diff'))

const rawLines = computed(() => (tab.value ? parseDiff(tab.value.diff, { charLevel: true }) : []))

const isBinaryDiff = computed(() => tab.value?.diff.includes('Binary files') ?? false)

// --- 省略された行の展開（#285）---------------------------------------------
// 計算そのものは `lib/diffExpand.ts`（純粋）。ここが持つのは取得（IPC）と操作だけ。

/** 1 回の操作で広げる行数。GitHub と同じ。 */
const EXPAND_STEP = 20

/** 新しい側の全行。押されるまで取りに行かない（開いただけの diff で IPC を増やさない）。 */
const newSideLines = ref<string[] | null>(null)
/** 自分から取りに行ったか。失敗しても自動では繰り返さない。 */
let autoLoadTried = false

/** 省略領域（キーは `Gap.key`）ごとに、上端／下端から何行めくったか。 */
const expanded = ref<Map<number, Expanded>>(new Map())

// 差分そのものが入れ替わったら、この差分に紐づく状態を捨てる。**足すときはここに足すこと**
// （散らすと、次に状態を増やす人がどれかを落とす）。
watch(
  () => tab.value?.diff,
  () => {
    newSideLines.value = null
    autoLoadTried = false
    expanded.value = new Map()
    autoWrapped.value = false
  },
)

const expansion = computed(() => expandDiff(rawLines.value, newSideLines.value, expanded.value))
const parsedLines = computed(() => expansion.value.lines)

/**
 * 新しい側の全文を取り寄せる。**diff の出どころで取得先が変わる**:
 * コミットならそのコミット、ステージ済みなら index（`git show :<path>`）、それ以外は作業ツリー。
 * 未追跡ファイルは全行が追加なので省略が無く、ここへは来ない。
 *
 * `silent` は自分から取りに行った場合（下の watcher）。頼まれていない失敗を知らせない。
 */
async function loadNewSide(silent = false): Promise<void> {
  const t0 = tab.value
  const projectStore = useProjectStore()
  const root = projectStore.activeRoot
  const shell = projectStore.shellForIO
  if (!t0 || !root) return
  const fail = (key: string) => {
    // 失敗しても帯はそのまま残す（押し直せば取り直す）。理由は StatusBar に 1 回出す。
    if (!silent) useStatusMessageStore().show({ text: t(key), variant: 'error' })
  }
  let text: string
  try {
    if (t0.commitHash) {
      text = await gitShowFile(root, shell, t0.commitHash, t0.filePath)
    } else if (t0.staged) {
      // 空のリビジョンは `git show :<path>`＝index の内容。ステージした側が「新しい側」。
      text = await gitShowFile(root, shell, '', t0.filePath)
    } else {
      text = (await fsReadFile(shell, joinPath(root, t0.filePath, pathSep(shell)))).content
    }
  } catch {
    fail('diff.expandFailed')
    return
  }
  const lines = text.split('\n')
  if (!matchesDiff(rawLines.value, lines)) {
    fail('diff.expandStale')
    return
  }
  newSideLines.value = lines
}

/**
 * **帯が 1 つも出ない差分でも、隠れた行があるかは確かめる。** 末尾の省略は行数が分からないと
 * 帯を出せず、その行数はファイルを取り寄せて初めて分かる。hunk が 1 つで 1 行目から始まる差分
 * （＝先頭の省略も無い）は、これが無いと押す場所が生まれず、残り全部を一生広げられない。
 *
 * 帯が 1 つでも出ていれば取りに行かない（押した人にだけ払わせる）。
 */
watch(
  [() => expansion.value.gaps.length, newSideLines],
  ([gapCount, file]) => {
    if (gapCount > 0 || file || autoLoadTried) return
    if (!rawLines.value.some((l) => l.hunk)) return
    autoLoadTried = true
    void loadNewSide(true)
  },
  { immediate: true },
)

/**
 * 帯のボタン。`down` は領域の上端から下へ（直前の hunk の続きが出る）、`up` は下端から上へ
 * （直後の hunk の手前が出る）広げる。`all` は残り全部で、上端に寄せれば片方の値だけで足りる。
 */
async function expandGap(gap: Gap, dir: 'up' | 'down' | 'all') {
  if (!newSideLines.value) {
    await loadNewSide()
    if (!newSideLines.value) return
  }
  const step = dir === 'all' ? gap.count : Math.min(EXPAND_STEP, gap.count)
  const cur = expanded.value.get(gap.key) ?? { top: 0, bottom: 0 }
  const next = new Map(expanded.value)
  next.set(gap.key, dir === 'up' ? { ...cur, bottom: cur.bottom + step } : { ...cur, top: cur.top + step })
  expanded.value = next
}

/** 広げた行をまとめて畳み直す。帯は広げ切ったあとも残るので、いつでもここへ戻れる。 */
function collapseGap(gap: Gap) {
  const next = new Map(expanded.value)
  next.delete(gap.key)
  expanded.value = next
}

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

// 行が増減したら測り直す（省略を展開すると長い行が出てくることがある）。**「自動」の判断
// そのものはやり直さない**（差分が入れ替わったときだけ。上の watcher が `autoWrapped` を
// 落とす）: 折り返しがいったん外れてから測り直して戻るので、広げるたびに画面が揺れる。
// **手動の上書きは差分が変わっても残す**（そのタブに対する明示的な選択なので覆さない）。
watch(parsedLines, () => void nextTick(measureOverflow))

// 折り返しを切り替えたときも測り直す。**`.diff-scroll` は `inset: 0` で自分の箱が
// 変わらないので ResizeObserver は鳴らない。** これが無いと、自動で折り返して開いた
// diff を手で折り返し OFF にしたときに `canScrollX` が false のままになり、横スクロール
// できるのにボタンが薄いまま（`prominent` が防ごうとしている状態そのもの）になる。
watch(wordWrapOn, () => void nextTick(measureOverflow))

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

/**
 * 表に流すもの。省略の帯（#285）は行と行のあいだに挟まり、ファイル末尾のぶんは最後に来る。
 * 帯と行を 1 本の列にしておくと、末尾のぶんだけ同じマークアップを書き写さずに済む。
 */
type DiffBlock = { gap: Gap; cells?: undefined } | { gap?: undefined; cells: (typeof rows.value)[number] }

const blocks = computed<DiffBlock[]>(() => {
  // `gaps` は `at` の昇順で出てくるので、前から 1 本のポインタで合流できる（Map を作らない）。
  const gaps = expansion.value.gaps
  const out: DiffBlock[] = []
  let g = 0
  rows.value.forEach((cells, i) => {
    if (g < gaps.length && gaps[g].at === i) out.push({ gap: gaps[g++] })
    out.push({ cells })
  })
  if (g < gaps.length) out.push({ gap: gaps[g] })
  return out
})

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
          <!-- **列幅はここで決める。** `table-layout: fixed` は既定で最初の行から幅を取るので、
               省略の帯（#285）が先頭に来ると colspan の 1 セルしか無く、4 列が等分されて
               行番号の欄が本文と同じ幅になる（差分が 3 分割されたように見える）。 -->
          <colgroup>
            <col class="col-num" />
            <col />
            <col class="col-num" />
            <col />
          </colgroup>
          <tbody>
            <template v-for="(block, i) in blocks" :key="i">
              <!-- 省略された行の帯（#285）。押した箇所だけ上下に広がる。 -->
              <template v-if="block.gap">
                <tr class="diff-gap">
                  <td class="gap-cell" colspan="4">
                    <div class="gap-bar">
                      <template v-if="block.gap.count">
                        <button
                          v-if="!block.gap.head"
                          class="gap-btn"
                          :title="t('diff.expandDown', { count: EXPAND_STEP })"
                          @click="expandGap(block.gap, 'down')"
                        ><ChevronDown :size="13" :stroke-width="2" /></button>
                        <button
                          v-if="!block.gap.tail"
                          class="gap-btn"
                          :title="t('diff.expandUp', { count: EXPAND_STEP })"
                          @click="expandGap(block.gap, 'up')"
                        ><ChevronUp :size="13" :stroke-width="2" /></button>
                        <button class="gap-all" @click="expandGap(block.gap, 'all')">{{
                          t('diff.expandAll', { count: block.gap.count })
                        }}</button>
                      </template>
                      <button
                        v-if="block.gap.shown"
                        class="gap-btn"
                        :title="t('diff.collapse', { count: block.gap.shown })"
                        @click="collapseGap(block.gap)"
                      ><ChevronsDownUp :size="13" :stroke-width="2" /></button>
                    </div>
                  </td>
                </tr>
              </template>
              <tr v-else class="diff-row">
                <template v-for="(cell, s) in block.cells" :key="s">
                  <td class="line-num" :class="cell.type">{{ cell.num ?? "" }}</td>
                  <td class="line-content" :class="cell.type"><template
                    v-for="(tok, j) in cell.tokens" :key="j"
                  ><span :class="{ 'hl': tok.diffHl, 'search-hl': tok.matchIndex >= 0, 'search-current': tok.matchIndex === currentIndex }" :data-match="tok.matchIndex >= 0 ? tok.matchIndex : undefined">{{ tok.text }}</span></template></td>
                </template>
              </tr>
            </template>
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
  /* hunk ヘッダと省略の帯（#285）の下地。どちらも「差分の切れ目」なので同じ値を共有する。 */
  --hunk-tint: rgba(0, 122, 204, 0.08);
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

/* `<col>` の幅は border-box なので、セル側の `width` と `padding` を足した値にする。 */
.col-num {
  width: calc(var(--num-w) + var(--num-pad) * 2);
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

/* 省略された行の帯（#285）。行番号の列を跨ぐので `.diff-row` の高さには乗らない。
   下地は hunk ヘッダと同じ色（どちらも「差分の切れ目」なので、値は `--hunk-tint` 1 つ）。 */
.diff-gap .gap-cell {
  padding: 0;
  background: var(--hunk-tint);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}

/* 横スクロールしても帯は左端に貼り付けたままにする（表の幅は最長行に合わせて広い）。 */
.gap-bar {
  position: sticky;
  left: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  width: fit-content;
  height: 22px;
  padding: 0 4px;
}

.gap-btn,
.gap-all {
  height: 18px;
  padding: 0 4px;
  color: var(--accent);
  font-family: inherit;
  font-size: 11px;
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
  background: var(--hunk-tint);
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

/* 枠なしのフラットなボタン（検索パネルと省略の帯が共有する）。寸法と文字色だけが違う。 */
.search-icon-btn,
.search-toggle-btn,
.gap-btn,
.gap-all {
  display: flex;
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.search-icon-btn:hover,
.search-toggle-btn:hover,
.gap-btn:hover,
.gap-all:hover {
  background: var(--tab-hover-bg);
}

.search-icon-btn,
.search-toggle-btn {
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-secondary);
}

.search-icon-btn:hover,
.search-toggle-btn:hover {
  color: var(--text-primary);
}

.search-toggle-btn.active {
  background: var(--accent);
  color: #fff;
}
</style>
