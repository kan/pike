<script setup lang="ts">
/**
 * 大きなファイルビューア（#630）。エディタの上限を超えたファイルを、全体まで見せて、行の単位で
 * 編集・保存できるようにする。
 *
 * **CodeMirror を使わない。** CodeMirror は文書を丸ごと JS の文字列として持つが、V8 の文字列は
 * 約 5.4 億文字が上限で 1GB のファイルは 1 本の文字列にならない（IPC の戻り値も同じ）。100MB でも
 * 文書を作るだけで 0.2 秒、未保存の判定の `toString` が打鍵のたびに 0.1 秒かかる（#630 の計測）。
 * ここでは Rust の行の索引（`fs/large.rs`）から見えている行だけを読み、見えている行だけを描く。
 * スクロールの計算とキャッシュは `lib/largeFile.ts`。
 *
 * 編集は行の単位（下の「編集」の節）。文書は Rust のピーステーブル（`fs/pieces.rs`）が持ち、
 * 編集で入れた行だけがメモリに載る。
 *
 * 持たないもの（エディタとの違い）：文字単位のカーソルでの編集・自動保存・折り返し・ハイライト・
 * Git の差分ガター・アウトライン・ミニマップ。選択とコピーは描いている行（画面に見えている範囲）だけ。
 */
import { ChevronsDown, List, RefreshCw, Search, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, triggerRef, useTemplateRef, watch } from 'vue'
import { useI18n } from '../../i18n'
import { horizontalReveal } from '../../lib/domFind'
import { buildFontFamily } from '../../lib/fontDetection'
import { formatFileSize } from '../../lib/format'
import { matchChord } from '../../lib/keys'
import {
  BLOCK_LINES,
  blocksFor,
  clampTop,
  extendSelection,
  type LargeViewerInfo,
  type LineBlock,
  LineBlockCache,
  type LineSelection,
  linesForEdit,
  makeBlock,
  maxTop,
  revealTop,
  selectionRange,
  splitAt,
  splitEditText,
  thumbFor,
  topFromThumb,
  visibleSlice,
} from '../../lib/largeFile'
import {
  type LargeCount,
  type LargeFileInfo,
  type LargeFileStatus,
  type LargeHit,
  type LargeHits,
  type LargeMatch,
  largeFileClose,
  largeFileCopy,
  largeFileCount,
  largeFileEdit,
  largeFileFind,
  largeFileLines,
  largeFileOpen,
  largeFileRedo,
  largeFileRefresh,
  largeFileSave,
  largeFileSearchPoll,
  largeFileSearchStart,
  largeFileSearchStop,
  largeFileSetEncoding,
  largeFileStatus,
  largeFileUndo,
} from '../../lib/tauri'
import { useSettingsStore } from '../../stores/settings'
import { useStatusMessageStore } from '../../stores/statusMessage'
import type { ShellType } from '../../types/tab'
import HelpButton from '../HelpButton.vue'
import FindBar from './FindBar.vue'

const props = defineProps<{ path: string; shell: ShellType }>()
const emit = defineEmits<{
  openDefault: []
  /** 保存したときから変わっているか（タブの `*`）。 */
  dirty: [dirty: boolean]
  /** `Ctrl+S`。保存の段取りは EditorTab の `save()` が持ち、こちらの `save` を呼び返す。 */
  save: []
  /**
   * 「再読み込み」のボタン。**ここで `refresh` を呼ばない**: 読み直すと編集を捨てるので、未保存なら
   * 確かめる EditorTab の `reloadFromDisk` を通す（あちらが `refresh` を呼び返す）。
   */
  reload: []
  /** StatusBar に出すもの（文字コード・改行・行）。変わったときに送る。 */
  info: [info: LargeViewerInfo]
}>()

const { t } = useI18n()
const settingsStore = useSettingsStore()
const statusMessageStore = useStatusMessageStore()

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
  /** 編集している行の範囲の先頭（ここに入力欄を描き、範囲の残りの行は描かない）。 */
  edit?: true
}

const visibleRows = computed<Row[]>(() => {
  void cacheVersion.value
  const m = match.value
  const e = editing.value
  const first = Math.floor(top.value)
  const last = Math.min(first + rows.value + 1, total.value)
  const out: Row[] = []
  // ブロックはまたいだときだけ引く（`get` は LRU の並べ替えを伴う）。
  let blockNo = -1
  let block: LineBlock | undefined
  for (let line = first; line < last; line++) {
    if (e && line === e.start) {
      out.push({ line, parts: null, cut: false, edit: true })
      line += e.count - 1
      continue
    }
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
/** 保存を頼んでから戻るまで（`save`）。 */
let savingLocal = false

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
  // 追従していなくても、作り終えたら範囲に収める（ログを切り詰めて行数が減ると、先頭の行が末尾より
  // 後ろに残る）。**作っている途中は収めない**: 作り直しの最初は行数が 0 に近く、見ていた位置が
  // 先頭へ飛んだまま戻らない。
  if (following.value) top.value = maxTop(total.value, rows.value)
  else if (status.value.done) top.value = clampTop(top.value, total.value, rows.value)
  ensureLoaded()
  // 保存のあいだも聞く（進み具合を出す）。
  if (!status.value.done || status.value.saving || savingLocal) {
    pollTimer = setTimeout(poll, POLL_MS)
  } else if (refreshPending) {
    refreshPending = false
    void refresh()
  } else if (find.value.open && find.value.query) {
    // 探すのも数えるのも索引を作り終えた範囲だけなので、作り終えたら件数を数え直す。
    // まだ一致が無ければ探し直す（作っているあいだに打った問い合わせ）。一覧も、途中に始めた
    // ものなら作り直す（追記を拾うたびに作り直すと、書き足され続けるログで全体を読み続ける）。
    if (match.value) {
      void recount()
      if (hitsOpen.value && hitsPartial) void startHits()
    } else scheduleFind()
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
  if (kind === 'appended') {
    // 一致の位置は変わらないので残す（一覧も。追記された行は、検索し直すまで一覧に入らない）。
    // 件数は作り終えたときに `poll` が数え直す。
    resetLines(Math.max(0, before - 1))
  } else {
    onRenumbered(null)
  }
  restartPoll()
}

/**
 * 行の番号が変わった（編集・取り消し・やり直し・外部の書き換え）。`from` より後ろの読んだ行
 * （`null` なら全部）、一致と件数、一覧、行の選択は、どれも同じ番号が別の行を指すので捨てる
 * （一覧は古いと示す）。**後始末を足すときはここに足す**。末尾への追記・保存・文字コードの
 * 開き直しは番号が変わらないので、ここを通さずに要るものだけを捨てる。
 */
function onRenumbered(from: number | null) {
  resetLines(from)
  // 走っている検索と件数は古い中身に対するもの。世代を進めて、届いても捨てる。
  invalidateFind()
  markHitsStale()
  clearLineSelection()
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
  if (recountTimer) clearTimeout(recountTimer)
  if (hitsTimer) clearTimeout(hitsTimer)
  if (docId) void largeFileClose(docId)
})

const resizeObserver = new ResizeObserver(() => {
  bodyHeight.value = body.value?.clientHeight ?? 0
  // 一覧の高さはウィンドウの高さの割合なので、本文と一緒に変わる。
  if (hitsOpen.value) onHitsScroll()
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
  // **編集しているあいだは動かさない**（入力欄が画面の外へ出ると、書きかけの行が描かれなくなる）。
  if (editing.value) return
  const lines =
    e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? e.deltaY
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? e.deltaY * rows.value
        : e.deltaY / lineHeight.value
  scrollTo(top.value + lines)
}

function onKeydown(e: KeyboardEvent) {
  if (matchChord(e, 'Mod+S')) {
    // 編集中なら確定してから保存する。保存の段取りは EditorTab の `save()`（`editor.md` の
    // 「保存の責任」）。
    e.preventDefault()
    e.stopPropagation()
    void commitEdit().then(() => emit('save'))
    return
  }
  if (e.target instanceof HTMLTextAreaElement) {
    onEditKeydown(e)
    return
  }
  if (matchChord(e, 'Mod+F')) {
    e.preventDefault()
    e.stopPropagation()
    openFind()
    return
  }
  if (e.target instanceof HTMLInputElement) return
  if (matchChord(e, 'Mod+Z') || matchChord(e, 'Mod+Shift+Z') || matchChord(e, 'Mod+Y')) {
    e.preventDefault()
    void (matchChord(e, 'Mod+Z') ? undo() : redo())
    return
  }
  if (matchChord(e, 'Mod+A')) {
    // ファイル全体の行を選ぶ（グローバルの `selectAllInPane` は `preventDefault` 済みなら素通し）。
    e.preventDefault()
    selectAllLines()
    return
  }
  if (matchChord(e, 'Mod+C') && lineSel.value) {
    e.preventDefault()
    void copySelection()
    return
  }
  if (e.key === 'Escape' && lineSel.value) {
    e.preventDefault()
    lineSel.value = null
    return
  }
  // ヘッダのボタンにフォーカスがあるときの Enter はボタンのもの。
  if (e.target instanceof HTMLButtonElement) return
  if (e.key === 'Enter' || e.key === 'F2') {
    e.preventDefault()
    const range = targetLines()
    if (range) startEdit(range.start, range.count)
    return
  }
  if (matchChord(e, 'Mod+Shift+K')) {
    e.preventDefault()
    const range = targetLines()
    if (range) void deleteLines(range.start, range.count)
    return
  }
  const page = Math.max(1, rows.value - 1)
  const mod = e.ctrlKey || e.metaKey
  if (e.shiftKey && !e.altKey) {
    // 選択を伸ばす（伸ばしている側の行から動かす）。
    const head = lineSel.value?.head ?? selectionOrigin()
    let to: number | null = null
    if (e.key === 'ArrowDown') to = head + 1
    else if (e.key === 'ArrowUp') to = head - 1
    else if (e.key === 'PageDown') to = head + page
    else if (e.key === 'PageUp') to = head - page
    else if (e.key === 'Home' && mod) to = 0
    else if (e.key === 'End' && mod) to = total.value - 1
    if (to === null) return
    e.preventDefault()
    extendTo(to)
    return
  }
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

// ── 編集 ──
//
// 文書は Rust のピーステーブル（`fs/pieces.rs`）で持ち、ここは「どの行をどう置き換えるか」を送る
// だけ。編集は行の単位で、入力欄（`textarea`）に対象の行を入れて書き換え、確定したらその行の範囲を
// 入力欄の行で置き換える。入力欄に入れるのは画面に見えている行だけなので、文書全体が JS の文字列に
// なることは無い。

/** 入力欄の要素。`v-for` の中に置くので、`useTemplateRef` ではなく関数の ref で受ける（配列になる）。 */
let editTextarea: HTMLTextAreaElement | null = null
function setEditTextarea(el: unknown) {
  editTextarea = el instanceof HTMLTextAreaElement ? el : null
}
/** 編集している行の範囲と、入力欄の中身。確定（`commitEdit`）か取り消し（`cancelEdit`）で消える。 */
const editing = ref<{ start: number; count: number; original: string; text: string } | null>(null)
/** 編集できるか。索引を作り終えるまでと、保存のあいだはできない（Rust も断る）。 */
const editable = computed(() => !!status.value?.done && !status.value.saving)
/** 送った編集（`runEdit`）の待ち行列と、まだ応答の来ていない数。 */
let editQueue: Promise<void> = Promise.resolve()
let pendingEdits = 0

/** 選択の両端の行（`data-line`）から、選択が覆う行の範囲を求める。選択が本文の外なら `null`。 */
function selectedLineRange(sel: Selection | null, pane: HTMLElement | null): { start: number; count: number } | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !pane) return null
  const lineOf = (node: Node | null): number | null => {
    const el = node instanceof Element ? node : (node?.parentElement ?? null)
    const row = el?.closest<HTMLElement>('.lv-line')
    return row && pane.contains(row) ? Number(row.dataset.line) : null
  }
  const a = lineOf(sel.anchorNode)
  const b = lineOf(sel.focusNode)
  if (a === null || b === null) return null
  return selectionRange({ anchor: a, head: b })
}

/**
 * 編集・削除・コピーの対象の行。行の単位の選択（`lineSel`）があればその範囲、次に本文の文字の
 * 選択が覆う行、無ければ目印の行。
 */
function targetLines(): { start: number; count: number } | null {
  if (lineSel.value) return selectionRange(lineSel.value)
  const range = selectedLineRange(window.getSelection(), textPane.value)
  if (range) return range
  return markedLine.value === null ? null : { start: markedLine.value, count: 1 }
}

function startEdit(start: number, count: number) {
  if (!editable.value || editing.value) {
    if (!editable.value) notice.value = t('largeFile.notEditable')
    return
  }
  // 前の編集の応答を待っているあいだは、行番号がずれる前のキャッシュで入力欄を作らない。
  if (pendingEdits > 0) return
  const lines = linesForEdit(cache, start, count)
  if (lines === 'cut') {
    notice.value = t('largeFile.cutNotEditable')
    return
  }
  if (lines === null) {
    // 読んでいない行（画面の外まで選んだ範囲）は入力欄に入れられない。消すとコピーは範囲のまま効く。
    if (lineSel.value) notice.value = t('largeFile.selectionNotEditable')
    return
  }
  const text = lines.join('\n')
  editing.value = { start, count, original: text, text }
  markedLine.value = null
  lineSel.value = null
  window.getSelection()?.removeAllRanges()
  void nextTick(() => {
    const el = editTextarea
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })
}

function cancelEdit() {
  editing.value = null
  root.value?.focus()
}

/** 入力欄の中身で置き換える。変わっていなければ何も送らない。 */
async function commitEdit() {
  const e = editing.value
  if (!e) return
  editing.value = null
  if (e.text !== e.original) await applyEdit(e.start, e.count, splitEditText(e.text))
  root.value?.focus()
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    void commitEdit()
  } else if (e.key === 'Tab' && !e.shiftKey) {
    // フォーカスを移さずにタブ文字を入れる。
    e.preventDefault()
    const el = e.target as HTMLTextAreaElement
    el.setRangeText('\t', el.selectionStart, el.selectionEnd, 'end')
    if (editing.value) editing.value.text = el.value
  }
}

async function deleteLines(start: number, count: number) {
  if (!editable.value) {
    notice.value = t('largeFile.notEditable')
    return
  }
  await applyEdit(start, count, [])
}

function applyEdit(start: number, count: number, insert: string[]) {
  return runEdit((id) => largeFileEdit(id, start, count, insert), start)
}

function undo() {
  // 変わった範囲は Rust が返さないので、読んだ行は全部読み直す（見えている数ブロックだけ）。
  return status.value?.canUndo ? runEdit(largeFileUndo, 0) : undefined
}

function redo() {
  return status.value?.canRedo ? runEdit(largeFileRedo, 0) : undefined
}

/**
 * 編集・取り消し・やり直しを 1 つずつ送り、終わったら `from` より後ろの行を読み直す（位置が
 * 変わった）。一致の位置も変わるので捨てる（件数だけ数え直し、画面は動かさない）。
 */
function runEdit(call: (id: string) => Promise<LargeFileStatus>, from: number): Promise<void> {
  // **捨てずに順に送る**（前の編集の応答を待っているあいだに確定した編集も、その後で送る）。
  // 入力欄を作るのは前の編集が終わってから（`startEdit` が `pendingEdits` を見る）なので、待たせた
  // 編集の行番号が前の編集でずれていることは無い。
  pendingEdits++
  const run = editQueue.then(async () => {
    try {
      if (!docId) return
      status.value = await call(docId)
      const reopen = find.value.open && !!find.value.query
      onRenumbered(from)
      if (reopen) scheduleRecount()
      top.value = clampTop(top.value, total.value, rows.value)
      ensureLoaded()
    } catch (err) {
      notice.value = String(err)
    } finally {
      pendingEdits--
    }
  })
  editQueue = run
  return run
}

/** 読んだ行を捨てる（`from` を含むブロックから後ろ。`null` なら全部）。読みかけの結果も捨てる。 */
function resetLines(from: number | null) {
  epoch++
  inflight.clear()
  if (from === null) cache.clear()
  else cache.dropFrom(from)
  cacheVersion.value++
}

/**
 * 編集のあとの件数の数え直しは、編集が止まってから 1 回だけ（数え直しはファイル全体を読む）。
 */
const RECOUNT_DEBOUNCE_MS = 800
let recountTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRecount() {
  if (recountTimer) clearTimeout(recountTimer)
  recountTimer = setTimeout(() => {
    recountTimer = null
    void recount()
  }, RECOUNT_DEBOUNCE_MS)
}

/** 画面の上の短い知らせ（編集できない理由・保存の失敗など）。編集を始めたら消える。 */
const notice = ref<string | null>(null)
watch(editing, (e) => {
  if (e) notice.value = null
})

// ── 保存 ──

const saveProgress = computed(() => {
  const s = status.value
  if (!s?.saving || s.saveTotal === 0) return 0
  return Math.min(100, Math.floor((s.saveWritten / s.saveTotal) * 100))
})

/**
 * 保存する（EditorTab の `save()` が呼ぶ）。一時ファイルへ書いてから置き換え、置き換えたファイルの
 * 索引を作り直す。保存のあいだは編集を受け付けない（Rust も断る）。失敗したら投げる。
 * `encoding` を渡すと、その文字コードに変換して書く（StatusBar の「このエンコードで保存」）。
 */
async function save(encoding?: string): Promise<boolean> {
  if (!docId) return false
  await commitEdit()
  // 確定した編集を送り終えてから書く。
  await editQueue
  // 変わっていなければ書かない（数百 MB を同じ中身で書き直さない）。文字コードを変えるなら書く。
  const convert = encoding !== undefined && encoding !== status.value?.encoding
  if (!status.value?.dirty && !convert) return false
  const id = docId
  // 進み具合は Rust の `saving` で出すが、立つのは保存が始まってから。それまでに届いた状態で
  // 聞くのをやめないよう、こちらでも保存中の印を持つ（`poll`）。
  savingLocal = true
  restartPoll()
  try {
    await largeFileSave(id, convert ? encoding : undefined)
    return true
  } finally {
    savingLocal = false
    if (id === docId && !disposed) {
      resetLines(null)
      invalidateFind()
      // 検索結果の一覧は残す: 保存は文書の行を変えない（一覧が古くなるのは編集した時点で、
      // そこで `markHitsStale` 済み）。変換したなら一覧の位置（バイト）は古いので古くする。
      if (convert) markHitsStale()
      restartPoll()
    }
  }
}

/**
 * 指定した文字コードで読み直す（StatusBar の「このエンコードで開き直す」）。**索引も未保存の編集も
 * 残す**（理由は Rust の `large_file_set_encoding`）。読んだ行・一致・件数・一覧は古い文字コードの
 * ものなので捨てて、見ている位置で読み直す。失敗したら投げる（UTF-16 など扱えない文字コード）。
 */
async function setEncoding(encoding: string) {
  if (!docId || encoding === status.value?.encoding) return
  await commitEdit()
  await editQueue
  const id = docId
  const next = await largeFileSetEncoding(id, encoding)
  if (id !== docId || disposed) return
  status.value = next
  resetLines(null)
  const reopen = find.value.open && !!find.value.query
  invalidateFind()
  markHitsStale()
  if (reopen) scheduleFind()
  ensureLoaded()
}

watch(
  () => status.value?.dirty ?? false,
  (dirty) => emit('dirty', dirty),
)

// ── 行へ移動 ──

const gotoInput = ref('')
/** 移動した先の行。目印に塗る。 */
const markedLine = ref<number | null>(null)

/**
 * StatusBar に出す今の文字コードと改行と行（EditorTab が `EditorInfo` に写す）。行は目印の行、
 * 無ければ画面の先頭の行。**配列の要素ごとに比べるので、送るのは値が変わったときだけ**
 * （スクロールの途中で行が変わらないフレームでは送らない）。
 */
watch(
  () => [status.value?.encoding, status.value?.lineEnding, (markedLine.value ?? Math.floor(top.value)) + 1] as const,
  ([encoding, lineEnding, line]) => {
    if (encoding && lineEnding && info.value) {
      emit('info', { encoding, lineEnding, line, encodings: info.value.encodings })
    }
  },
)

function gotoLine() {
  const n = Number.parseInt(gotoInput.value, 10)
  if (!Number.isFinite(n) || total.value === 0) return
  const line = Math.min(Math.max(1, n), total.value) - 1
  markedLine.value = line
  clearLineSelection()
  revealLine(line)
  root.value?.focus()
}

// ── 行の選択とコピー ──
//
// 画面の外まで行を選べるように、選択は**行番号だけ**で持つ（`LineSelection`）。本文の DOM には
// 見えている行しか無いので、ブラウザの文字の選択では画面の外まで届かず、スクロールすると外れる。
// 選んだ行の文字列はフロントに持ち込まず、コピーのときに Rust が今の文書から組み立てる
// （`large_file_copy`）。行の中の一部だけを選ぶのは、今までどおりブラウザの文字の選択。

const lineSel = ref<LineSelection | null>(null)
const selBounds = computed(() => (lineSel.value ? selectionRange(lineSel.value) : null))
/**
 * 最後に押した行（Shift+クリックで伸ばすときの起点）。目印（`markedLine`）とは分ける: 目印は
 * 選択と同じ色で塗るので、本文を押すたびに付けると選択と見分けられない。
 */
let clickedLine: number | null = null

function clearLineSelection() {
  lineSel.value = null
  clickedLine = null
}

/**
 * 行を選ぶ。**文字の選択はここで外す**（行の選択と文字の選択は同時に持たない。逆向きは本文を
 * 押したときに `onLineMousedown` が行の選択を外す）。
 */
function selectLines(sel: LineSelection) {
  lineSel.value = sel
  window.getSelection()?.removeAllRanges()
  // 目印は選択と同じ色なので、残すと選択が 2 か所あるように見える（対象になるのは選択だけ）。
  markedLine.value = null
}

function inSelection(line: number): boolean {
  const b = selBounds.value
  return !!b && line >= b.start && line < b.start + b.count
}

/** 選択を伸ばし始める起点（最後に押した行、目印の行、画面の先頭の行の順）。 */
function selectionOrigin(): number {
  return clickedLine ?? markedLine.value ?? Math.floor(top.value)
}

/** 選択の `head` を `to` へ動かし、そこが見えるところまで送る。 */
function extendTo(to: number) {
  if (total.value === 0) return
  const sel = extendSelection(lineSel.value, selectionOrigin(), to, total.value)
  selectLines(sel)
  scrollTo(revealTop(top.value, rows.value, sel.head, total.value))
}

/**
 * 行を押した（本文と行番号の両方）。Shift を押していれば選択を伸ばす。行番号を押したらその行を
 * 選ぶ。本文を押したら行の選択を外す（文字の選択はブラウザに任せる）。
 */
function onLineMousedown(e: MouseEvent) {
  if (e.button !== 0 || editing.value) return
  const row = (e.target as Element | null)?.closest<HTMLElement>('[data-line]')
  if (!row) {
    // 本文の行の無い所（最後の行の下）から文字の選択を始めても、行の選択は外す（同時に持たない）。
    if (!e.shiftKey && e.currentTarget === textPane.value) lineSel.value = null
    return
  }
  const line = Number(row.dataset.line)
  const inGutter = !!row.closest('.lv-gutter')
  if (e.shiftKey) {
    e.preventDefault()
    extendTo(line)
    root.value?.focus()
    return
  }
  clickedLine = line
  if (inGutter) {
    e.preventDefault()
    selectLines({ anchor: line, head: line })
    root.value?.focus()
  } else {
    // 起点（`clickedLine`）は残す: 続く Shift+クリックはここから伸ばす。
    lineSel.value = null
  }
}

function selectAllLines() {
  if (total.value === 0) return
  // 数えている途中に選ぶと、数え終えた行までで止まる（あとから伸びた行が入らないまま全部を
  // 選んだつもりになる）。数え終えてからにする。
  if (indexing.value) {
    statusMessageStore.show({ text: t('largeFile.selectAllAfterIndexing'), variant: 'info' })
    return
  }
  selectLines({ anchor: 0, head: total.value - 1 })
}

/**
 * 選んだ行をコピーする。中身は Rust が組み立て（編集を反映した今の文書。表示で切った長い行も
 * 丸ごと）、書き込みは他のコピーと同じ `navigator.clipboard.writeText`。上限（`MAX_COPY_BYTES`）を
 * 超えたら書き込まずに知らせる（途中までを入れると、全部をコピーしたつもりになる）。
 */
async function copySelection() {
  const sel = lineSel.value
  if (!docId || !sel) return
  if (indexing.value) {
    statusMessageStore.show({ text: t('largeFile.copyAfterIndexing'), variant: 'info' })
    return
  }
  const { start, count } = selectionRange(sel)
  try {
    const res = await largeFileCopy(docId, start, count)
    if (res.indexing) {
      // こちらの状態が届く前に、Rust が数え直しを始めていた（保存の直後など）。
      statusMessageStore.show({ text: t('largeFile.copyAfterIndexing'), variant: 'info' })
      return
    }
    if (res.text === null) {
      statusMessageStore.show({
        text: t('largeFile.copyTooLarge', { size: formatFileSize(res.bytes), limit: formatFileSize(res.limit) }),
        variant: 'error',
      })
      return
    }
    await navigator.clipboard.writeText(res.text)
    statusMessageStore.show({ text: t('largeFile.copied', { lines: count.toLocaleString() }), variant: 'info' })
  } catch (err) {
    statusMessageStore.show({ text: t('largeFile.copyFailed', { error: String(err) }), variant: 'error' })
  }
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
  // 閉じたときに一致と件数は捨てたが、問い合わせは残してある。残っていれば探し直す（問い合わせの
  // watch は値が変わらないので動かない）。
  if (find.value.query) scheduleFind()
}

/**
 * 一致と件数を捨て、待っている検索・走っている検索の結果も捨てる（世代を進める）。閉じたときと、
 * 書き換えを拾ったとき。
 */
function invalidateFind() {
  if (findTimer) clearTimeout(findTimer)
  findTimer = null
  findSeq++
  stepSeq++
  revealPending = false
  match.value = null
  count.value = null
  counting.value = false
}

function closeFind() {
  find.value.open = false
  invalidateFind()
  // 一覧は検索バーの問い合わせの結果なので、検索バーと一緒に閉じる。
  closeHits()
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
    invalidateFind()
    // 前の問い合わせの一覧は止めて捨てる（新しい一覧は `runFind` が始める）。
    discardHits()
    if (find.value.open && find.value.query) scheduleFind()
  },
)

/**
 * 問い合わせが変わったとき。画面の先頭の行から次の一致を探し、並行して件数を数える。一覧を
 * 開いていれば一覧も作り直す。探すのも数えるのも索引を作り終えた範囲だけなので、作り終えたら
 * `poll` が数え直す。
 */
async function runFind() {
  if (!docId || !find.value.query) return
  void recount()
  if (hitsOpen.value) void startHits()
  await step(1, true)
}

// ── 検索結果の一覧 ──
//
// 検索バーの問い合わせの結果を、ファイル全体について裏で集めて並べる（Rust の
// `large_file_search_start`）。見つかった分から出し、行を押すとその一致へ移る。プロジェクトの
// 検索パネル（rg）とは対象が違う（あちらはプロジェクトのファイル群、こちらは開いている 1 つの
// 大きなファイル）ので、入口は検索バーの隣に置き、パネルとは分けてある。

/** 一覧を聞きに行く間隔（見つけた分を取りに行く）。 */
const HITS_POLL_MS = 200

const hitsOpen = ref(false)
const hits = shallowRef<LargeHit[]>([])
const hitsState = ref({ running: false, truncated: false, stale: false, error: null as string | null })
/** 走らせている一覧の世代（Rust が返したもの）。0 なら走っていない。 */
let hitsGeneration = 0
let hitsTimer: ReturnType<typeof setTimeout> | null = null
/** 今の一覧を、索引を作っている途中に始めたか。 */
let hitsPartial = false
/** 一覧を始めた・止めた回数。始めるのを待っているあいだに止められたことを知るため。 */
let hitsSeq = 0

function toggleHits() {
  if (hitsOpen.value) {
    closeHits()
    return
  }
  hitsOpen.value = true
  if (!find.value.open) openFind()
  else if (find.value.query) void startHits()
}

function closeHits() {
  hitsOpen.value = false
  discardHits()
}

/** 走っている一覧を止めて、並べた分も捨てる。 */
function discardHits() {
  stopHits()
  hits.value = []
}

function clearHitsTimer() {
  if (hitsTimer) clearTimeout(hitsTimer)
  hitsTimer = null
}

/** 一覧を作り始める。前の一覧は Rust の側で止まる（世代が進む）。 */
async function startHits() {
  const { query, caseSensitive } = find.value
  if (!docId || !query) return
  clearHitsTimer()
  // 前の世代を先に外す。始めるのを待っているあいだに前の世代の問い合わせが返っても、空にした
  // 一覧へ足さない（`pollHits` は世代が今のものでなければ捨てる）。
  hitsGeneration = 0
  const seq = ++hitsSeq
  hits.value = []
  hitsState.value = { running: true, truncated: false, stale: false, error: null }
  // 索引を作っている途中に始めた一覧は、作り終えた範囲しか探さない。作り終えたら作り直す（`poll`）。
  hitsPartial = indexing.value
  const id = docId
  try {
    const generation = await largeFileSearchStart(id, query, caseSensitive)
    if (seq !== hitsSeq || id !== docId) {
      // 待っているあいだに止められた（問い合わせを消した・一覧を閉じた）か、次の一覧が始まった。
      // 止められたのなら Rust の検索は走ったままなので止める（次の一覧の世代は巻き込まない）。
      void largeFileSearchStop(id, generation)
      return
    }
    hitsGeneration = generation
    await pollHits()
  } catch (err) {
    hitsState.value = { ...hitsState.value, running: false, error: String(err) }
  }
}

async function pollHits() {
  hitsTimer = null
  const generation = hitsGeneration
  if (!docId || generation === 0 || disposed) return
  let res: LargeHits
  try {
    // 渡された分は Rust の側で手放されるので、続きは前回の続きから届く。
    res = await largeFileSearchPoll(docId, generation)
  } catch (err) {
    hitsState.value = { ...hitsState.value, running: false, error: String(err) }
    return
  }
  if (generation !== hitsGeneration) return
  if (res.hits.length > 0) {
    // 配列を作り直さずに足す（上限まで受けても、受け取った件数ぶんしかコピーしない）。
    hits.value.push(...res.hits)
    triggerRef(hits)
  }
  const more = res.total > hits.value.length
  hitsState.value = {
    ...hitsState.value,
    running: !res.done || more,
    truncated: res.truncated,
    error: res.error,
  }
  // 見つけたのに受け取っていない分があればすぐ、まだ探しているなら間を置いて聞き直す。
  if (more) void pollHits()
  else if (!res.done) hitsTimer = setTimeout(pollHits, HITS_POLL_MS)
  else hitsGeneration = 0
}

/** 走っている一覧を止める（一覧は残す）。 */
function stopHits() {
  clearHitsTimer()
  // 始めるのを待っている一覧は、返ってきたところで `startHits` が止める。
  hitsSeq++
  if (hitsGeneration !== 0 && docId) void largeFileSearchStop(docId, hitsGeneration)
  hitsGeneration = 0
  hitsState.value = { ...hitsState.value, running: false }
}

/**
 * 文書が変わった（編集・取り消し・書き換えの取り込み）。**一覧の行番号は補正せず、古いことを
 * 示して検索し直させる**（`editor.md` の「検索結果の一覧」に理由）。走っている検索は変わる前の
 * 文書を探しているので止める。
 */
function markHitsStale() {
  // 0 件の一覧も古くする（編集で一致する行ができたかもしれない）。
  if (!hitsOpen.value || !find.value.query) return
  stopHits()
  hitsState.value = { ...hitsState.value, stale: true }
}

/**
 * 一覧の行を押した。その一致へ移り、検索バーにフォーカスを置く（続けて Enter で次の一致へ進む。
 * 本文にフォーカスがあると、Enter は行の編集を始める）。行は `mousedown` でフォーカスを奪わない。
 */
async function gotoHit(hit: LargeHit) {
  findBar.value?.focus()
  await showMatch(hit)
}

/** `m` を今の一致にして、その行と列が見えるところへ送る（次へ進む・一覧の行を押した）。 */
async function showMatch(m: LargeMatch) {
  match.value = m
  revealPending = true
  revealLine(m.line)
  await nextTick()
  revealMatchColumn()
}

const hitsBox = useTemplateRef<HTMLDivElement>('hitsBox')
const hitsScroll = ref(0)
const hitsViewport = ref(0)
const hitsSlice = computed(() =>
  visibleSlice(hitsScroll.value, hitsViewport.value, lineHeight.value, hits.value.length),
)

function onHitsScroll() {
  hitsScroll.value = hitsBox.value?.scrollTop ?? 0
  hitsViewport.value = hitsBox.value?.clientHeight ?? 0
}

watch(hitsOpen, async (open) => {
  if (!open) return
  await nextTick()
  onHitsScroll()
})

const hitsSummary = computed(() => {
  const n = hits.value.length.toLocaleString()
  if (hitsState.value.error) return hitsState.value.error
  if (hitsState.value.running) return t('largeFile.hitsSearching', { count: n })
  if (hitsState.value.truncated) return t('largeFile.hitsTruncated', { count: n })
  return t('largeFile.hitsCount', { count: n })
})

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
  // 起点は前回の一致（その行の中のバイト）、無ければ画面の先頭の行の行頭。
  const fromLine = cur ? cur.line : Math.floor(top.value)
  const fromByte = cur ? (delta > 0 ? cur.byteEnd : cur.byte) : null
  try {
    const found = await largeFileFind(docId, query, caseSensitive, fromLine, fromByte, delta < 0)
    if (seq !== stepSeq || querySeq !== findSeq) return
    if (found) await showMatch(found)
    else match.value = null
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

/** 編集している範囲の、入力欄の中の行数（入力欄の高さと行番号の数）。 */
const editLines = computed(() => (editing.value ? splitEditText(editing.value.text).length : 0))

defineExpose({ refresh, save, setEncoding, focus: () => root.value?.focus() })
</script>

<template>
  <div ref="root" class="large-viewer" tabindex="0" @keydown="onKeydown">
    <div class="lv-header">
      <div class="lv-info">
        <span class="lv-badge">{{ t('largeFile.badge') }}</span>
        <template v-if="info">
          <span>{{ formatFileSize(info.size) }}</span>
          <span v-if="status">{{ t('largeFile.lines', { lines: total.toLocaleString() }) }}</span>
          <span v-if="status">{{ status.encoding }}</span>
          <span v-if="indexing" class="lv-progress">{{ t('largeFile.indexing', { percent: String(progress) }) }}</span>
          <span v-if="status?.saving" class="lv-progress">{{ t('largeFile.saving', { percent: String(saveProgress) }) }}</span>
          <span v-if="status?.error" class="lv-error">{{ status.error }}</span>
          <span v-if="notice" class="lv-error selectable">{{ notice }}</span>
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
          :class="{ active: hitsOpen }"
          :title="t('largeFile.hits')"
          @click="toggleHits"
        >
          <List :size="14" :stroke-width="2" />
        </button>
        <button
          class="editor-toggle"
          :class="{ active: following }"
          :title="t('largeFile.follow')"
          @click="followTail"
        >
          <ChevronsDown :size="14" :stroke-width="2" />
        </button>
        <button class="editor-toggle" :title="t('editor.reloadFromDisk')" @click="emit('reload')">
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
      <div class="lv-gutter" :style="{ width: `${gutterChars + 2}ch` }" @mousedown="onLineMousedown">
        <div class="lv-rows" :style="{ transform: `translateY(${-offsetPx}px)` }">
          <template v-for="row in visibleRows" :key="row.line">
            <template v-if="row.edit">
              <div v-for="k in editLines" :key="`e${k}`" class="lv-num editing">{{ row.line + k }}</div>
            </template>
            <div
              v-else
              class="lv-num"
              :class="{ marked: row.line === markedLine, selected: inSelection(row.line) }"
              :data-line="row.line"
            >
              {{ row.line + 1 }}
            </div>
          </template>
        </div>
      </div>
      <div ref="textPane" class="lv-text selectable" @mousedown="onLineMousedown">
        <div class="lv-rows" :style="{ transform: `translateY(${-offsetPx}px)` }">
          <template v-for="row in visibleRows" :key="row.line">
            <textarea
              v-if="row.edit && editing"
              :ref="setEditTextarea"
              v-model="editing.text"
              class="lv-edit"
              spellcheck="false"
              wrap="off"
              :style="{ height: `${editLines * lineHeight}px` }"
              @blur="commitEdit"
            />
            <div
              v-else
              class="lv-line"
              :class="{ marked: row.line === markedLine, selected: inSelection(row.line) }"
              :data-line="row.line"
              @dblclick="row.parts && startEdit(row.line, 1)"
            >
            <template v-if="row.parts">
              <span>{{ row.parts[0] }}</span><span v-if="row.parts[1]" class="lv-match">{{ row.parts[1] }}</span><span>{{ row.parts[2] }}</span><span
                v-if="row.cut"
                class="lv-cut"
                :title="t('largeFile.cutHint')"
                >{{ t('largeFile.cut') }}</span
              >
            </template>
            </div>
          </template>
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
    <!-- 検索結果の一覧（検索バーの問い合わせの結果。見つかった分から並べる） -->
    <div v-if="hitsOpen && !openError" class="lv-hits">
      <div class="lv-hits-header">
        <span>{{ find.query ? hitsSummary : t('largeFile.hitsEmpty') }}</span>
        <template v-if="hitsState.stale">
          <span class="lv-error">{{ t('largeFile.hitsStale') }}</span>
          <button class="lv-text-btn" @click="startHits">{{ t('largeFile.hitsRerun') }}</button>
        </template>
        <span class="lv-hits-spacer" />
        <button class="editor-toggle" :title="t('search.close')" @click="closeHits">
          <X :size="14" :stroke-width="2" />
        </button>
      </div>
      <div
        ref="hitsBox"
        class="lv-hits-list"
        :class="{ stale: hitsState.stale }"
        :style="{ fontFamily, fontSize: `${settingsStore.editorFontSize}px`, '--lv-line': `${lineHeight}px` }"
        @scroll="onHitsScroll"
      >
        <div :style="{ height: `${hits.length * lineHeight}px`, position: 'relative' }">
          <div :style="{ transform: `translateY(${hitsSlice.start * lineHeight}px)` }">
            <div
              v-for="(hit, k) in hits.slice(hitsSlice.start, hitsSlice.end)"
              :key="hitsSlice.start + k"
              class="lv-hit"
              :class="{ current: match && match.line === hit.line && match.byte === hit.byte }"
              @mousedown.prevent
              @click="gotoHit(hit)"
            >
              <span class="lv-hit-line">{{ hit.line + 1 }}</span>
              <span class="lv-hit-text"
                >{{ hit.before }}<span class="lv-match">{{ hit.text }}</span>{{ hit.after }}</span
              >
            </div>
          </div>
        </div>
      </div>
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
.lv-line.marked,
.lv-num.selected,
.lv-line.selected {
  background: var(--selection-bg);
}

/* 行番号は押すと行を選ぶ。 */
.lv-num {
  cursor: pointer;
}

.lv-edit {
  display: block;
  width: 100%;
  min-width: 100%;
  margin: 0;
  padding: 0 0 0 4px;
  border: none;
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
  line-height: var(--lv-line);
  white-space: pre;
  overflow: hidden;
  resize: none;
}

.lv-num.editing {
  color: var(--accent);
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

.lv-hits {
  display: flex;
  flex-direction: column;
  flex: none;
  height: 30%;
  min-height: 120px;
  max-height: 360px;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}

.lv-hits-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.lv-hits-spacer {
  flex: 1;
}

.lv-hits-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  color: var(--text-primary);
}

.lv-hits-list.stale {
  opacity: 0.6;
}

.lv-hit {
  display: flex;
  gap: 12px;
  height: var(--lv-line);
  line-height: var(--lv-line);
  padding: 0 8px;
  white-space: pre;
  overflow: hidden;
  cursor: pointer;
}

.lv-hit:hover {
  background: var(--tab-hover-bg);
}

.lv-hit.current {
  background: var(--selection-bg);
}

.lv-hit-line {
  flex: none;
  min-width: 6ch;
  color: var(--text-secondary);
  text-align: right;
}

.lv-hit-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
