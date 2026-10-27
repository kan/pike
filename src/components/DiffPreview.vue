<script setup lang="ts">
/**
 * diff タブのプレビュー比較（#524）。変更前と変更後を、エディタのプレビューと同じ描き方で
 * 左右に並べる。対象の種別は `lib/fileType.ts` の `previewKindOf`（画像・Markdown・rst・SVG・Mermaid）。
 *
 * **左右がどの版かは `lib/diffSource.ts` の `diffSides`**（省略行の展開と同じ規則）。差分の中身では
 * なくファイルそのものを取り寄せるのは、プレビューは全文から描くため。
 *
 * **取り直しの契機は `tab.diff` の 1 つ。** 作業ツリーのファイルが変わったときは DiffTab が差分を
 * 取り直して代入する（`refreshFromDisk`）ので、それに乗れば見えていないタブで読み直さない規則
 * （`git-diff.md`）もそのまま効く。**中身が変わっていない側は取り直さず、描き直さない**
 * （差分のヘッダの blob で見分ける。保存のたびに変わるのは大抵、作業ツリーの側だけ）。
 *
 * 描き方（HTML 化・図・画像の解決）は `lib/previewRender.ts`、見た目は `assets/preview.css` で、
 * エディタのプレビューと共有する。
 */
import { computed, nextTick, onUnmounted, shallowRef, watch } from 'vue'
import { useI18n } from '../i18n'
import { type DiffSource, diffSides, readDiffSource } from '../lib/diffSource'
import type { PreviewKind } from '../lib/fileType'
import { isExternalLink, openUrlWithConfirm } from '../lib/openUrl'
import { repoPath } from '../lib/paths'
import {
  approveImageChip,
  imageChipAt,
  type PreviewPathBase,
  renderMarkdownExtras,
  renderMarkdownHtml,
  renderMermaidInto,
  renderRstHtml,
  resolvePreviewImages,
} from '../lib/previewRender'
import { createScrollFollow, type SyncPane } from '../lib/scrollFollow'
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'
import type { DiffTab } from '../types/tab'

const props = defineProps<{ tab: DiffTab; kind: PreviewKind }>()

const { t, locale } = useI18n()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()

/** 片側の中身。`content` は画像なら `data:` URL、それ以外は本文。 */
type Side = { state: 'loading' } | { state: 'missing' } | { state: 'failed' } | { state: 'ready'; content: string }

const SIDES = [0, 1] as const

/**
 * 左右の中身。**片側ずつ持つ**: 取り直さなかった側は値が入れ替わらないので、その側の HTML の
 * 組み立てと DOM の後処理（図・画像）が走らない。
 */
const sides = SIDES.map(() => shallowRef<Side>({ state: 'loading' }))

/**
 * 今の中身がどの版か。差分のヘッダの blob まで同じなら中身も同じなので取り直さない。blob が
 * 読めなかった側（null）は毎回取り直す。
 */
const loadedKeys: (string | null)[] = [null, null]

function sourceKey(src: DiffSource): string | null {
  return src.blob === null ? null : `${src.rev}\0${src.path}\0${src.blob}`
}

/**
 * `<img>` で描く種別。**SVG もここに入れる**: 左右を同じ文書に直接埋めると、両側の id
 * （`linearGradient` / `clipPath` / `marker`）が重なり、右の `url(#id)` が左の定義を指して
 * 変更後が変更前の色や形で描かれる。`<img>` なら 1 枚ずつ別の文書になり、スクリプトも外部参照も
 * 走らない（secure static mode）。
 */
const asImage = computed(() => props.kind === 'image' || props.kind === 'svg')

/** 飛んでいる取得のうち、最後のものだけを採る。 */
let loadSeq = 0

async function load() {
  const t0 = props.tab
  const seq = ++loadSeq
  const shell = projectStore.shellForIO
  const as = asImage.value ? 'dataUrl' : 'text'
  await Promise.all(
    diffSides(t0).map(async (src, i) => {
      if (!src) {
        loadedKeys[i] = null
        if (sides[i].value.state !== 'missing') sides[i].value = { state: 'missing' }
        return
      }
      const key = sourceKey(src)
      if (key !== null && key === loadedKeys[i]) return
      let side: Side
      try {
        side = { state: 'ready', content: await readDiffSource(t0.root, shell, src, as) }
      } catch {
        side = { state: 'failed' }
      }
      if (seq !== loadSeq) return
      loadedKeys[i] = side.state === 'ready' ? key : null
      sides[i].value = side
    }),
  )
}

// 差分が入れ替わったら（ファイルの変更への追従・開き直し）取り直す。描き直すまで前の中身を残す
// （読み込み中の表示に戻すと、保存のたびに左右が一瞬白くなる）。
watch(
  () => props.tab.diff,
  () => void load(),
  { immediate: true },
)

// --- 描画 -------------------------------------------------------------------

/** 本文から HTML を作る種別（Markdown と rst）の HTML。ほかは空（`<img>` か DOM へ直接描く）。 */
function toHtml(side: Side): string {
  if (side.state !== 'ready') return ''
  // `#123` はリンクにしない（押しても開く先が無い。リンクの扱いは `onClick`）。
  if (props.kind === 'markdown') return renderMarkdownHtml(side.content)
  if (props.kind === 'rst') return renderRstHtml(side.content)
  return ''
}

/** 画像（ローカルと外部）を解く種別。 */
const hasImages = computed(() => props.kind === 'markdown' || props.kind === 'rst')

const htmls = sides.map((side) => computed(() => toHtml(side.value)))

/** 左右のスクロール領域（同期の相手）と、その中の描画先。描画には使わないので reactive にしない。 */
const scrollEls: (HTMLElement | null)[] = [null, null]
const bodyEls: (HTMLElement | null)[] = [null, null]
// 関数の ref は描くたびに呼ばれるので、作るのは 1 回にする。
const setScrollEl = SIDES.map((i) => (el: unknown) => {
  scrollEls[i] = (el as HTMLElement | null) ?? null
})
const setBodyEl = SIDES.map((i) => (el: unknown) => {
  bodyEls[i] = (el as HTMLElement | null) ?? null
})

/** 相対パスの画像を解く基準。描いているのは作業ツリーのファイルの位置として扱う（`git-diff.md`）。 */
function pathBase(): PreviewPathBase | null {
  const shell = projectStore.shellForIO
  const filePath = repoPath(props.tab.root, props.tab.filePath, shell)
  return filePath ? { filePath, root: props.tab.root, shell } : null
}

/** 後から始まった描画が勝つ（`renderMarkdownExtras` / `renderMermaidInto` の `stale`）。片側ずつ数える。 */
const renderRuns = [0, 0]

/**
 * 描いた DOM の後処理。`images` は画像も解き直すか: 中身が変わったときだけで、書体の変更では
 * 図だけを描き直す（ローカル画像は 1 枚につき 1 回の IPC 読みになる）。
 */
async function renderSide(i: number, images: boolean) {
  const run = ++renderRuns[i]
  await nextTick()
  const el = bodyEls[i]
  const side = sides[i].value
  if (!el || side.state !== 'ready') return
  const stale = () => run !== renderRuns[i]
  const font = settingsStore.uiFontFamilyCss
  const id = `diff-preview-${props.tab.id}-${i}`
  if (props.kind === 'mermaid') void renderMermaidInto(el, side.content, `${id}-${Date.now()}`, font, stale)
  if (props.kind === 'markdown') void renderMarkdownExtras(el, id, font, stale)
  if (images && hasImages.value) void resolvePreviewImages(el, pathBase())
}

// 中身（Mermaid は HTML が空のままなので、中身そのものも見る）か HTML（テーマで変わる）が
// 変わった側だけ描き直す。
for (const i of SIDES) {
  watch([sides[i], htmls[i]], () => void renderSide(i, true), { immediate: true })
}
// 書体は図のラベルの幅の計測に効く（色は CSS 変数で追従するので見ない）。
watch(
  () => settingsStore.uiFontFamilyCss,
  () => {
    for (const i of SIDES) void renderSide(i, false)
  },
)

function resolveImages() {
  if (!hasImages.value) return
  for (const el of bodyEls) if (el) void resolvePreviewImages(el, pathBase())
}

// 承認（と言語の切り替え）で画像の解き方が変わる。HTML は変わらないので、解き直すだけにする。
watch([() => settingsStore.allowedImageHosts, locale], resolveImages)

// --- スクロールの連動 ---------------------------------------------------------

// 左右を 2 つの役に当てる（`SyncPane` の doc）。
const ROLES: readonly [SyncPane, SyncPane] = ['editor', 'preview']
const follow = createScrollFollow()

function onScroll(i: number) {
  const from = scrollEls[i]
  const to = scrollEls[1 - i]
  if (from && to) follow.mirror(ROLES[i], from, to)
}

/** 利用者が直接動かし始めた側は、追従をその場で解く（`scrollFollow.ts` の `release`）。 */
function release(i: number) {
  follow.release(ROLES[i])
}

// --- クリック ----------------------------------------------------------------

/**
 * **リンクは必ず `preventDefault` する。** 素通しすると webview がリンク先へ遷移し、アプリが
 * 丸ごと置き換わる。外部のリンクだけ確認つきで開き、ローカルのファイルとページ内のアンカーは
 * 何もしない（開いているのは比較のための過去の版で、リンク先の版とは対応しない）。
 */
async function onClick(e: MouseEvent) {
  const chip = imageChipAt(e)
  if (chip) {
    e.preventDefault()
    await approveImageChip(chip, resolveImages)
    return
  }
  const href = (e.target as HTMLElement).closest('a')?.getAttribute('href')
  if (href === undefined) return
  e.preventDefault()
  if (href && isExternalLink(href)) await openUrlWithConfirm(href)
}

const labels = computed(() => [t('diff.previewBefore'), t('diff.previewAfter')])

/** 中身の代わりに出す文言。描けるときは null。無いときの文言は、左が「まだ無い」、右が「もう無い」。 */
function noteText(side: Side, i: number): string | null {
  switch (side.state) {
    case 'loading':
      return t('diff.previewLoading')
    case 'missing':
      return i === 0 ? t('diff.previewAdded') : t('diff.previewDeleted')
    case 'failed':
      return t('diff.previewFailed')
    default:
      return null
  }
}

/** 描画先に付ける class（見た目は `assets/preview.css`）。 */
const bodyClass = computed(() => {
  switch (props.kind) {
    case 'markdown':
      return 'md-preview'
    case 'rst':
      return 'md-preview rst-preview'
    case 'mermaid':
      return 'mermaid-preview'
    default:
      return 'diff-preview-image'
  }
})

onUnmounted(() => {
  // 飛んでいる取得と描画の結果を捨てる。
  loadSeq++
  renderRuns[0]++
  renderRuns[1]++
})
</script>

<template>
  <div class="diff-preview">
    <div v-for="i in SIDES" :key="i" class="diff-preview-side">
      <div class="diff-preview-label">{{ labels[i] }}</div>
      <div
        :ref="setScrollEl[i]"
        class="diff-preview-scroll selectable"
        tabindex="-1"
        @scroll="onScroll(i)"
        @wheel.capture.passive="release(i)"
        @pointerdown.capture.passive="release(i)"
        @keydown.capture.passive="release(i)"
        @touchstart.capture.passive="release(i)"
        @click="onClick"
      >
        <div v-if="sides[i].value.state !== 'ready'" class="diff-preview-note">
          {{ noteText(sides[i].value, i) }}
        </div>
        <div v-else-if="asImage" :ref="setBodyEl[i]" :class="bodyClass">
          <img :src="(sides[i].value as { content: string }).content" alt="" />
        </div>
        <!-- Mermaid は `renderSide` が描く。 -->
        <div v-else-if="kind === 'mermaid'" :ref="setBodyEl[i]" :class="bodyClass"></div>
        <div v-else :ref="setBodyEl[i]" :class="bodyClass" v-html="htmls[i].value"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-preview {
  flex: 1;
  min-height: 0;
  display: flex;
}

.diff-preview-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.diff-preview-side + .diff-preview-side {
  border-left: 1px solid var(--border);
}

.diff-preview-label {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
}

/* スクロールするのはこの外側で、中の描画先（`.md-preview` など）は高さを持たずに伸びる
   （寸法は置いた側が決める。`assets/preview.css` の冒頭）。 */
.diff-preview-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* クリックでフォーカスを持つ（キーでスクロールでき、追従もキーで解ける）が、枠は出さない。 */
.diff-preview-scroll:focus {
  outline: none;
}

.diff-preview-note {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}

.diff-preview-image {
  display: flex;
  justify-content: center;
  padding: 16px;
}

.diff-preview-image img {
  max-width: 100%;
  height: auto;
  /* 透過のある画像でも縁が分かるように、チェッカーボードを敷く。 */
  background-color: var(--bg-tertiary);
  background-image:
    linear-gradient(45deg, var(--bg-secondary) 25%, transparent 25%),
    linear-gradient(-45deg, var(--bg-secondary) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--bg-secondary) 75%),
    linear-gradient(-45deg, transparent 75%, var(--bg-secondary) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
</style>
