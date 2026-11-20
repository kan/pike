<script setup lang="ts">
/**
 * 大きなファイルビューア（#630）。エディタの上限を超えたファイルを、読み取り専用で全体を見せる。
 *
 * **CodeMirror を使わない。** CodeMirror は文書を丸ごと JS の文字列として持つが、V8 の文字列は
 * 約 5.4 億文字が上限で 1GB のファイルは 1 本の文字列にならない（IPC の戻り値も同じ）。100MB でも
 * 文書を作るだけで 0.2 秒、未保存の判定の `toString` が打鍵のたびに 0.1 秒かかる（#630 の計測）。
 * ここでは Rust の行の索引（`fs/large.rs`）から見えている行だけを読み、見えている行だけを描く。
 * スクロールの計算とキャッシュは `lib/largeFile.ts`。
 *
 * 持たないもの（エディタとの違い）：編集・保存・折り返し・ハイライト・Git の差分ガター・
 * アウトライン・ミニマップ。選択とコピーは描いている行（画面に見えている範囲）だけ。
 */
import { ChevronsDown, RefreshCw, Search } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useI18n } from '../../i18n'
import { horizontalReveal } from '../../lib/domFind'
import { buildFontFamily } from '../../lib/fontDetection'
import { formatFileSize } from '../../lib/format'
import { matchChord } from '../../lib/keys'
import {
  BLOCK_LINES,
  blocksFor,
  clampTop,
  type LineBlock,
  LineBlockCache,
  makeBlock,
  maxTop,
  splitAt,
  thumbFor,
  topFromThumb,
} from '../../lib/largeFile'
import {
  type LargeCount,
  type LargeFileInfo,
  type LargeFileStatus,
  type LargeMatch,
  largeFileClose,
  largeFileCount,
  largeFileFind,
  largeFileLines,
  largeFileOpen,
  largeFileRefresh,
  largeFileStatus,
} from '../../lib/tauri'
import { useSettingsStore } from '../../stores/settings'
import type { ShellType } from '../../types/tab'
import HelpButton from '../HelpButton.vue'
import FindBar from './FindBar.vue'

const props = defineProps<{ path: string; shell: ShellType }>()
const emit = defineEmits<{ openDefault: [] }>()

const { t } = useI18n()
const settingsStore = useSettingsStore()

/** 索引を作っているあいだ、進み具合を聞く間隔。 */
const POLL_MS = 150
/** 検索の入力が止まってから探し始めるまで。 */
const FIND_DEBOUNCE_MS = 250
/** つまみのドラッグが止まってから行を読むまで。 */
const DRAG_LOAD_MS = 80

const info = shallowRef<LargeFileInfo | null>(null)
const status = shallowRef<LargeFileStatus | null>(null)
const openError = ref<string | null>(null)
let docId: string | null = null
let disposed = false

const root = useTemplateRef<HTMLDivElement>('root')
const body = useTemplateRef<HTMLDivElement>('body')
const textPane = useTemplateRef<HTMLDivElement>('textPane')
const bodyHeight = ref(0)
/** 先頭に見える行（0 始まり・小数）。`lib/largeFile.ts` の doc にある理由で自前で持つ。 */
const top = ref(0)
/** 末尾を見ているあいだは、追記を拾ったら末尾へ付いていく（`tail -f` と同じ）。 */
const following = ref(false)

const cache = new LineBlockCache()
const cacheVersion = ref(0)
const inflight = new Set<number>()
/** 読み直し（作り直し）のたびに進める。古い読み込みの結果をキャッシュへ入れない。 */
let epoch = 0

const lineHeight = computed(() => Math.ceil(settingsStore.editorFontSize * 1.5))
const fontFamily = computed(() => buildFontFamily(settingsStore.editorFontName))
const rows = computed(() => Math.max(1, Math.floor(bodyHeight.value / lineHeight.value)))
const total = computed(() => status.value?.lines ?? 0)
const indexing = computed(() => !!status.value && !status.value.done)
const progress = computed(() => {
  const s = status.value
  if (!s || s.size === 0) return 100
  return Math.min(100, Math.floor((s.scanned / s.size) * 100))
})
const gutterChars = computed(() => String(Math.max(1, total.value)).length)

interface Row {
  line: number
  /** まだ読んでいなければ `null`。読んだ行は一致の前・一致・後ろに分けて持つ。 */
  parts: [string, string, string] | null
  cut: boolean
}

const visibleRows = computed<Row[]>(() => {
  void cacheVersion.value
  const m = match.value
  const first = Math.floor(top.value)
  const last = Math.min(first + rows.value + 1, total.value)
  const out: Row[] = []
  // ブロックはまたいだときだけ引く（`get` は LRU の並べ替えを伴う）。
  let blockNo = -1
  let block: LineBlock | undefined
  for (let line = first; line < last; line++) {
    if (Math.floor(line / BLOCK_LINES) !== blockNo) {
      blockNo = Math.floor(line / BLOCK_LINES)
      block = cache.get(blockNo)
    }
    const i = line % BLOCK_LINES
    const text = block?.lines[i]
    const parts: Row['parts'] =
      text === undefined ? null : m && m.line === line ? splitAt(text, m.col, m.len) : [text, '', '']
    out.push({ line, parts, cut: block?.cut.has(i) ?? false })
  }
  return out
})

/** 1 行未満のずれ。先頭の行を上へずらして描く。 */
const offsetPx = computed(() => (top.value - Math.floor(top.value)) * lineHeight.value)

// ── 開く・閉じる・進み具合 ──

async function open() {
  try {
    const opened = await largeFileOpen(props.shell, props.path)
    if (disposed) {
      void largeFileClose(opened.id)
      return
    }
    docId = opened.id
    info.value = opened
    await poll()
  } catch (e) {
    openError.value = String(e)
  }
}

let pollTimer: ReturnType<typeof setTimeout> | null = null
/** 索引を作っている途中に届いた外部変更。作り終えてから拾い直す。 */
let refreshPending = false

/** 進み具合を聞けなかった回数。続けて `POLL_RETRIES` 回失敗したら聞くのをやめる。 */
let pollFailures = 0
const POLL_RETRIES = 5

async function poll() {
  pollTimer = null
  if (!docId || disposed) return
  try {
    status.value = await largeFileStatus(docId)
    pollFailures = 0
  } catch {
    // 一時的な失敗で進み具合が止まったままにならないよう、間を空けて聞き直す。
    if (++pollFailures < POLL_RETRIES) pollTimer = setTimeout(poll, POLL_MS * 10)
    return
  }
  if (following.value) top.value = maxTop(total.value, rows.value)
  ensureLoaded()
  if (!status.value.done) {
    pollTimer = setTimeout(poll, POLL_MS)
  } else if (refreshPending) {
    refreshPending = false
    void refresh()
  } else if (find.value.open && find.value.query) {
    // 探すのも数えるのも索引を作り終えた範囲だけなので、作り終えたら件数を数え直す。
    // まだ一致が無ければ探し直す（作っているあいだに打った問い合わせ）。
    if (match.value) void recount()
    else scheduleFind()
  }
}

function restartPoll() {
  if (pollTimer) clearTimeout(pollTimer)
  void poll()
}

/**
 * 外部の変更を拾う（EditorTab が外部変更の知らせと「再読み込み」で呼ぶ）。末尾への追記なら
 * 索引を続きから作り、最後のブロックだけ読み直す。書き換えなら全部読み直す。
 */
async function refresh() {
  if (!docId) return
  if (indexing.value) {
    refreshPending = true
    return
  }
  const before = total.value
  const kind = await largeFileRefresh(docId).catch(() => 'unchanged' as const)
  if (kind === 'unchanged') return
  epoch++
  inflight.clear()
  if (kind === 'appended') {
    cache.dropFrom(Math.max(0, before - 1))
  } else {
    cache.clear()
    match.value = null
  }
  cacheVersion.value++
  restartPoll()
}

onMounted(() => {
  void open()
  if (body.value) {
    resizeObserver.observe(body.value)
    bodyHeight.value = body.value.clientHeight
  }
})

onUnmounted(() => {
  disposed = true
  resizeObserver.disconnect()
  if (pollTimer) clearTimeout(pollTimer)
  if (findTimer) clearTimeout(findTimer)
  if (dragLoadTimer) clearTimeout(dragLoadTimer)
  if (docId) void largeFileClose(docId)
})

const resizeObserver = new ResizeObserver(() => {
  bodyHeight.value = body.value?.clientHeight ?? 0
})

// ── 行の読み込み ──

function ensureLoaded() {
  if (!docId) return
  // 見えている範囲と、前後に半ブロックずつ。スクロールの先を少しだけ先に読んでおく。
  const first = Math.max(0, Math.floor(top.value) - BLOCK_LINES / 2)
  const needed = blocksFor(first, rows.value + BLOCK_LINES, total.value)
  const keep = new Set(needed)
  for (const b of needed) {
    if (cache.has(b) || inflight.has(b)) continue
    inflight.add(b)
    const id = docId
    const at = epoch
    largeFileLines(id, b * BLOCK_LINES, BLOCK_LINES)
      .then((res) => {
        if (disposed || at !== epoch || id !== docId) return
        // 索引を作っている途中でも、Rust は索引の先までファイルから読むので、ブロックが短いのは
        // ファイルの末尾だけ。末尾が伸びたら `refresh` が最後のブロックを捨てる。
        cache.set(b, makeBlock(res.lines, res.cut), keep)
        cacheVersion.value++
        if (revealPending) void nextTick(revealMatchColumn)
      })
      .catch(() => {})
      .finally(() => {
        if (at === epoch) inflight.delete(b)
      })
  }
}

/** つまみを動かしているか。動かしているあいだは行を読まない（下の watch）。 */
let drag: { pointer: number; startY: number; startOffset: number } | null = null
let dragLoadTimer: ReturnType<typeof setTimeout> | null = null

// **つまみのドラッグ中は、止まってから読む。** 通り過ぎたブロックを全部頼むと、描かない行の
// 読み込みが Rust の待ち行列に積まれ、止めた位置の表示がその後ろで待たされる。
watch([() => Math.floor(top.value), rows, total], () => {
  if (!drag) {
    ensureLoaded()
    return
  }
  if (dragLoadTimer) clearTimeout(dragLoadTimer)
  dragLoadTimer = setTimeout(() => {
    dragLoadTimer = null
    ensureLoaded()
  }, DRAG_LOAD_MS)
})

// ── スクロール ──

function scrollTo(next: number) {
  top.value = clampTop(next, total.value, rows.value)
  following.value = total.value > rows.value && top.value >= maxTop(total.value, rows.value)
}

/** 末尾へ移り、以後は追記に付いていく。収まっているファイルでも付いていく（伸びたら末尾を見せる）。 */
function followTail() {
  scrollTo(maxTop(total.value, rows.value))
  following.value = true
}

function onWheel(e: WheelEvent) {
  // 横方向は本文の横スクロール（ブラウザ）に任せる。
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
  e.preventDefault()
  const lines =
    e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? e.deltaY
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? e.deltaY * rows.value
        : e.deltaY / lineHeight.value
  scrollTo(top.value + lines)
}

function onKeydown(e: KeyboardEvent) {
  if (matchChord(e, 'Mod+F')) {
    e.preventDefault()
    e.stopPropagation()
    openFind()
    return
  }
  if (e.target instanceof HTMLInputElement) return
  const page = Math.max(1, rows.value - 1)
  const mod = e.ctrlKey || e.metaKey
  let next: number | null = null
  if (e.key === 'ArrowDown') next = top.value + 1
  else if (e.key === 'ArrowUp') next = top.value - 1
  else if (e.key === 'PageDown') next = top.value + page
  else if (e.key === 'PageUp') next = top.value - page
  else if (e.key === 'Home' && mod) next = 0
  else if (e.key === 'End' && mod) next = maxTop(total.value, rows.value)
  if (next === null) return
  e.preventDefault()
  scrollTo(Math.round(next))
}

const track = useTemplateRef<HTMLDivElement>('track')
const thumb = computed(() => thumbFor(top.value, total.value, rows.value, bodyHeight.value))

function onThumbDown(e: PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  drag = { pointer: e.pointerId, startY: e.clientY, startOffset: thumb.value.offset }
}

function onThumbMove(e: PointerEvent) {
  if (!drag || drag.pointer !== e.pointerId) return
  const offset = drag.startOffset + (e.clientY - drag.startY)
  scrollTo(topFromThumb(offset, total.value, rows.value, bodyHeight.value))
}

function onThumbUp(e: PointerEvent) {
  if (drag?.pointer !== e.pointerId) return
  drag = null
  if (dragLoadTimer) clearTimeout(dragLoadTimer)
  dragLoadTimer = null
  ensureLoaded()
}

/** つまみの外を押したら、そこへつまみの中心を合わせる。 */
function onTrackDown(e: PointerEvent) {
  const rect = track.value?.getBoundingClientRect()
  if (!rect) return
  const offset = e.clientY - rect.top - thumb.value.size / 2
  scrollTo(topFromThumb(offset, total.value, rows.value, bodyHeight.value))
}

// ── 行へ移動 ──

const gotoInput = ref('')
/** 移動した先の行。目印に塗る。 */
const markedLine = ref<number | null>(null)

function gotoLine() {
  const n = Number.parseInt(gotoInput.value, 10)
  if (!Number.isFinite(n) || total.value === 0) return
  const line = Math.min(Math.max(1, n), total.value) - 1
  markedLine.value = line
  revealLine(line)
  root.value?.focus()
}

/** 行が見えていなければ、画面の上から 3 分の 1 の位置に来るよう動かす。 */
function revealLine(line: number) {
  const first = top.value
  if (line >= first && line < first + rows.value - 1) return
  scrollTo(line - Math.floor(rows.value / 3))
}

// ── 検索 ──

const find = ref({ open: false, query: '', caseSensitive: false })
const match = shallowRef<LargeMatch | null>(null)
const count = shallowRef<LargeCount | null>(null)
const counting = ref(false)
const findBar = useTemplateRef<{ focus: () => void }>('findBar')
let findTimer: ReturnType<typeof setTimeout> | null = null
/** 検索の世代。問い合わせを変えたら進め、古い結果を捨てる。 */
let findSeq = 0

function openFind() {
  if (find.value.open) {
    findBar.value?.focus()
    return
  }
  find.value.open = true
}

function closeFind() {
  find.value.open = false
  match.value = null
  count.value = null
  root.value?.focus()
}

function scheduleFind() {
  if (findTimer) clearTimeout(findTimer)
  findTimer = setTimeout(() => {
    findTimer = null
    void runFind()
  }, FIND_DEBOUNCE_MS)
}

watch(
  () => [find.value.query, find.value.caseSensitive],
  () => {
    match.value = null
    count.value = null
    findSeq++
    if (find.value.query) scheduleFind()
  },
)

/**
 * 問い合わせが変わったとき。画面の先頭の行から次の一致を探し、並行して件数を数える。探すのも
 * 数えるのも索引を作り終えた範囲だけなので、作り終えたら `poll` が数え直す。
 */
async function runFind() {
  if (!docId || !find.value.query) return
  void recount()
  await step(1, true)
}

async function recount() {
  const { query, caseSensitive } = find.value
  if (!docId || !query) return
  const seq = findSeq
  counting.value = true
  try {
    const c = await largeFileCount(docId, query, caseSensitive)
    if (seq === findSeq && c) count.value = c
  } catch {
    // 数えられなかった。件数は出さないまま、次の一致へは進める。
  } finally {
    if (seq === findSeq) counting.value = false
  }
}

/** `step` の呼び出しごとの番号。Enter を続けて押したとき、先に始めた検索の結果で上書きしない。 */
let stepSeq = 0

/** 次（`delta < 0` なら前）の一致へ。`fresh` なら前回の一致を起点にせず、画面の先頭の行から探す。 */
async function step(delta: number, fresh = false) {
  const { query, caseSensitive } = find.value
  if (!docId || !query) return
  const seq = ++stepSeq
  const querySeq = findSeq
  const cur = fresh ? null : match.value
  const fromByte = cur ? (delta > 0 ? cur.byteEnd : cur.byte) : null
  try {
    const found = await largeFileFind(docId, query, caseSensitive, Math.floor(top.value), fromByte, delta < 0)
    if (seq !== stepSeq || querySeq !== findSeq) return
    match.value = found
    if (found) {
      revealPending = true
      revealLine(found.line)
      await nextTick()
      revealMatchColumn()
    }
  } catch {
    // 後から始めた検索に止められた（Rust の `CANCELLED`）。結果はそちらが持ってくる。
  }
}

/**
 * 横へ送るのを待っている一致があるか。遠くの一致へ飛んだ直後は、その行のブロックを読み終えるまで
 * 一致の要素が無いので、読み終えたとき（`ensureLoaded`）にもう一度試す。
 */
let revealPending = false

/** 一致が横にはみ出していれば、本文を横へ送る。 */
function revealMatchColumn() {
  const pane = textPane.value
  const mark = pane?.querySelector<HTMLElement>('.lv-match')
  if (!pane || !mark) return
  revealPending = false
  pane.scrollLeft += horizontalReveal(mark.getBoundingClientRect(), pane.getBoundingClientRect())
}

const findTotal = computed(() => count.value?.count ?? (match.value ? 1 : 0))
const findBusy = computed(() => counting.value && !match.value && !count.value)
/** 件数に `+` を付けるか。上限で打ち切ったときと、索引を作っている途中（数えたのは途中まで）。 */
const findTruncated = computed(() => !!count.value?.truncated || indexing.value)

defineExpose({ refresh, focus: () => root.value?.focus() })
</script>

<template>
  <div ref="root" class="large-viewer" tabindex="0" @keydown="onKeydown">
    <div class="lv-header">
      <div class="lv-info">
        <span class="lv-badge">{{ t('largeFile.badge') }}</span>
        <template v-if="info">
          <span>{{ formatFileSize(info.size) }}</span>
          <span v-if="status">{{ t('largeFile.lines', { lines: total.toLocaleString() }) }}</span>
          <span>{{ info.encoding }}</span>
          <span v-if="indexing" class="lv-progress">{{ t('largeFile.indexing', { percent: String(progress) }) }}</span>
          <span v-if="status?.error" class="lv-error">{{ status.error }}</span>
        </template>
      </div>
      <div class="lv-actions">
        <input
          v-model="gotoInput"
          class="lv-goto"
          type="text"
          inputmode="numeric"
          spellcheck="false"
          :placeholder="t('largeFile.gotoLine')"
          @keydown.enter.prevent="gotoLine"
        />
        <button class="editor-toggle" :title="t('largeFile.find')" @click="openFind">
          <Search :size="14" :stroke-width="2" />
        </button>
        <button
          class="editor-toggle"
          :class="{ active: following }"
          :title="t('largeFile.follow')"
          @click="followTail"
        >
          <ChevronsDown :size="14" :stroke-width="2" />
        </button>
        <button class="editor-toggle" :title="t('editor.reloadFromDisk')" @click="refresh">
          <RefreshCw :size="14" :stroke-width="2" />
        </button>
        <button class="lv-text-btn" @click="emit('openDefault')">{{ t('common.openWithDefaultApp') }}</button>
        <HelpButton page="editor-and-preview.md" :size="15" />
      </div>
    </div>
    <div v-if="openError" class="lv-status selectable">{{ openError }}</div>
    <div
      v-else
      ref="body"
      class="lv-body"
      :style="{ fontFamily, fontSize: `${settingsStore.editorFontSize}px`, '--lv-line': `${lineHeight}px` }"
      @wheel="onWheel"
    >
      <div class="lv-gutter" :style="{ width: `${gutterChars + 2}ch` }">
        <div class="lv-rows" :style="{ transform: `translateY(${-offsetPx}px)` }">
          <div v-for="row in visibleRows" :key="row.line" class="lv-num" :class="{ marked: row.line === markedLine }">
            {{ row.line + 1 }}
          </div>
        </div>
      </div>
      <div ref="textPane" class="lv-text selectable">
        <div class="lv-rows" :style="{ transform: `translateY(${-offsetPx}px)` }">
          <div v-for="row in visibleRows" :key="row.line" class="lv-line" :class="{ marked: row.line === markedLine }">
            <template v-if="row.parts">
              <span>{{ row.parts[0] }}</span><span v-if="row.parts[1]" class="lv-match">{{ row.parts[1] }}</span><span>{{ row.parts[2] }}</span><span
                v-if="row.cut"
                class="lv-cut"
                :title="t('largeFile.cutHint')"
                >{{ t('largeFile.cut') }}</span
              >
            </template>
          </div>
        </div>
      </div>
      <div v-if="total > rows" ref="track" class="lv-track" @pointerdown="onTrackDown">
        <div
          class="lv-thumb"
          :style="{ height: `${thumb.size}px`, transform: `translateY(${thumb.offset}px)` }"
          @pointerdown="onThumbDown"
          @pointermove="onThumbMove"
          @pointerup="onThumbUp"
          @pointercancel="onThumbUp"
        />
      </div>
      <FindBar
        v-if="find.open"
        ref="findBar"
        v-model:query="find.query"
        v-model:case-sensitive="find.caseSensitive"
        :current="-1"
        :total="findTotal"
        :truncated="findTruncated"
        :busy="findBusy"
        @step="step"
        @close="closeFind"
      />
    </div>
  </div>
</template>

<style scoped>
.large-viewer {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  outline: none;
  background: var(--bg-primary);
}

.lv-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
}

.lv-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.lv-badge {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
}

.lv-progress {
  color: var(--accent);
}

.lv-error {
  color: var(--danger);
}

.lv-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.lv-goto {
  width: 90px;
  padding: 2px 6px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.lv-goto:focus {
  border-color: var(--accent);
}

.lv-text-btn {
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.lv-text-btn:hover {
  color: var(--text-primary);
}

.lv-status {
  padding: 16px;
  color: var(--danger);
}

.lv-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  color: var(--text-primary);
}

.lv-gutter {
  flex: none;
  overflow: hidden;
  padding-right: 8px;
  color: var(--text-secondary);
  text-align: right;
  user-select: none;
}

.lv-text {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  /* 右のスクロールバーの溝のぶん空ける */
  margin-right: 10px;
}

.lv-rows {
  will-change: transform;
}

.lv-num,
.lv-line {
  height: var(--lv-line);
  line-height: var(--lv-line);
  white-space: pre;
}

.lv-line {
  width: max-content;
  min-width: 100%;
  padding-left: 4px;
}

.lv-num.marked,
.lv-line.marked {
  background: var(--selection-bg);
}

.lv-match {
  background: var(--find-current-bg);
  color: var(--find-current-fg);
}

.lv-cut {
  margin-left: 8px;
  color: var(--text-secondary);
  font-style: italic;
  user-select: none;
}

.lv-track {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 10px;
  background: transparent;
}

.lv-thumb {
  width: 100%;
  border-radius: 5px;
  background: var(--scrollbar-thumb);
}

.lv-thumb:hover {
  background: var(--scrollbar-thumb-hover);
}
</style>
