<script setup lang="ts">
import { Rows2 } from 'lucide-vue-next'
import { computed, type Ref, ref, useTemplateRef, watch } from 'vue'
import { useDiffWrap } from '../composables/useDiffWrap'
import { useDragResize } from '../composables/useDragResize'
import { useI18n } from '../i18n'
import type { PatchFile } from '../lib/commitPatch'
import { gitStatusColor } from '../lib/paths'
import { loadJson, saveJson } from '../lib/storage'
import WrapToggle from './editor/WrapToggle.vue'
import IgnoreSpaceToggle from './IgnoreSpaceToggle.vue'
import PatchLines from './PatchLines.vue'

/**
 * コミットタブ（#374、#396）と作業中の変更のタブ（#526）が共有する 3 分割の器。
 *
 * **配置は SourceTree の下半分にそろえてある**: 左上（`head` の slot）、左下にファイルの一覧
 * （`files` の slot）、右に選んだ 1 ファイルの差分（`file`）。全ファイルの差分を縦に積むと、
 * 大きい変更では目当てのファイルまでスクロールし続けることになり、畳む仕掛けも別に要る。
 * **1 ファイルずつ描けばその仕掛けごと要らない。**
 *
 * 一覧の行は `PatchFileRow.vue`、差分の表は `PatchLines.vue`。一覧の見出しと空の表示
 * （`.files-head` / `.patch-empty` / `.patch-error`）だけはここが `:deep` で持つ。slot の中身は
 * 呼び出し側のスコープで描かれるので、両方のタブに同じ CSS を写さずに済む。
 */
const props = defineProps<{
  /** 右に出すファイル。`null` なら `emptyText` を出す。 */
  file: PatchFile | null
  /** 空白の違いを無視して見ているか（#453）。取り直しは呼び出し側。 */
  ignoreSpace: boolean
  /** 差分の代わりに出す文言（読み込み中・取得の失敗など）。 */
  note?: string | null
  emptyText: string
}>()
const emit = defineEmits<{ toggleIgnoreSpace: [] }>()
const { t } = useI18n()
const { wrapOn, toggleWrap } = useDiffWrap()

/**
 * 画面の割り方（#396）。**比で持ち、開き方（`stacked`）と一緒にマシンごとに覚える**
 * （`pike:commit-split`。コミットタブと作業中の変更のタブで共有）。
 *
 * **px ではなく比にしてある**のは、覚えた値をウィンドウの大きさが違う環境でも使うため
 * （diff タブの `--split` と同じ形）。下限だけは px で見る: 比の下限にすると、狭い
 * ウィンドウで左の列が読めない幅まで詰められる。
 *
 * **プロジェクトでは分けない**（グラフの列幅 `pike:git-graph-width` と同じ扱い）。
 * 見た目の好みなので、同期の対象にもしない。
 *
 * **ドラッグ中は Vue を通さない**（`.claude/rules/git-diff.md` の「スクロールとドラッグの
 * 最中は Vue を通さない」）。値を `:style` に載せると、動かすたびにこのコンポーネントの
 * render が丸ごと走り、**仮想化していない差分の表の vnode が行数ぶん作り直される**（1 ファイルで
 * 数千行になりうる）。書きたいのはカスタムプロパティなので、そこだけ素の DOM 操作に逃がし、
 * 確定値だけを ref に入れる。
 */
const SPLIT_KEY = 'pike:commit-split'
const LEFT_MIN = 180
const TOP_MIN = 80
const LEFT_DEFAULT = 0.34
const META_DEFAULT = 0.5
const DIFF_DEFAULT = 0.5

/** 覚えた比。壊れた値（手で書き換えた localStorage）は既定に落とす。 */
function storedRatio(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 && value < 1 ? value : fallback
}
const stored = loadJson<{ left?: unknown; meta?: unknown; diff?: unknown; stacked?: unknown }>(SPLIT_KEY, {})
const leftRatio = ref(storedRatio(stored.left, LEFT_DEFAULT))
const metaRatio = ref(storedRatio(stored.meta, META_DEFAULT))
const diffRatio = ref(storedRatio(stored.diff, DIFF_DEFAULT))
/** 右のペインを上下（新 / 旧）に分けて出すか。押した状態も覚える。 */
const stacked = ref(stored.stacked === true)
watch([leftRatio, metaRatio, diffRatio, stacked], ([left, meta, diff, isStacked]) =>
  saveJson(SPLIT_KEY, { left, meta, diff, stacked: isStacked }),
)

const rootRef = useTemplateRef<HTMLElement>('rootRef')
const leftRef = useTemplateRef<HTMLElement>('leftRef')
const stackRef = useTemplateRef<HTMLElement>('stackRef')

/**
 * 分割線 1 本ぶんの配線。**入れ物の大きさは `onStart` で 1 回だけ測る**: ドラッグ中に
 * `clientWidth` / `clientHeight` を読むと、直前に書いたスタイルのせいで mousemove ごとに
 * 強制リフローが走る（しかもこの値は、その分割線を動かしているあいだ変わらない）。
 */
function paneDrag(ratio: Ref<number>, min: number, axis: 'x' | 'y', prop: string, extent: () => number) {
  let startPx = 0
  let span = 0
  let latest = 0
  let frame = 0
  const paint = () => rootRef.value?.style.setProperty(prop, `${latest}`)
  return useDragResize({
    axis,
    onStart: () => {
      span = Math.max(extent(), 1)
      startPx = ratio.value * span
      latest = ratio.value
    },
    onMove: (delta) => {
      const px = Math.min(Math.max(startPx + delta, min), Math.max(min, span - min))
      latest = px / span
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        paint()
      })
    },
    onEnd: () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      ratio.value = latest
    },
  })
}

const leftDrag = paneDrag(leftRatio, LEFT_MIN, 'x', '--left-r', () => rootRef.value?.clientWidth ?? 800)
const metaDrag = paneDrag(metaRatio, TOP_MIN, 'y', '--meta-r', () => leftRef.value?.clientHeight ?? 400)
const diffDrag = paneDrag(diffRatio, TOP_MIN, 'y', '--diff-r', () => stackRef.value?.clientHeight ?? 400)

/**
 * 上下に並べたときの 2 つの面（#396）。**統合形式の行を濾すだけで作る**ので、差分を
 * 取り直さない（新しい側は削除行を、古い側は追加行を落とす）。
 *
 * **hunk の見出しは両方に残す。** 飛ばした範囲の目印なので、片方から落とすと、離れた
 * 変更どうしが続きの行に見える。
 */
const stackedSides = computed(() => {
  const lines = props.file?.lines ?? []
  return [
    { key: 'new' as const, label: t('commitTab.newSide'), lines: lines.filter((l) => l.type !== 'del') },
    { key: 'old' as const, label: t('commitTab.oldSide'), lines: lines.filter((l) => l.type !== 'add') },
  ]
})

/** 上下に並べられるか（中身の無いファイルでは押しても何も変わらない）。 */
const canStack = computed(() => !!props.file && !props.file.binary && props.file.lines.length > 0 && !props.note)
</script>

<template>
  <!--
    分割の位置は 2 つともカスタムプロパティで持つ（#396）。ドラッグ中はここを素の DOM 操作で
    書き換えるので、`:style` に載せるのは押していないときの値だけ。
  -->
  <div
    ref="rootRef"
    class="patch-split"
    :style="{ '--left-r': leftRatio, '--meta-r': metaRatio, '--diff-r': diffRatio }"
  >
    <div ref="leftRef" class="patch-left">
      <div class="patch-head">
        <slot name="head" />
      </div>
      <div class="split-h drag-y-handle" @mousedown="metaDrag.start" />
      <div class="patch-files">
        <slot name="files" />
      </div>
    </div>

    <div class="split-v drag-x-handle" @mousedown="leftDrag.start" />

    <!-- 右：選んだファイルの差分。 -->
    <div class="patch-diff selectable">
      <template v-if="file">
        <div class="diff-head">
          <span class="file-status" :style="{ color: gitStatusColor(file.status) }">{{ file.status }}</span>
          <span class="file-path" :title="file.path">
            <template v-if="file.oldPath">{{ file.oldPath }} → </template>{{ file.path }}
          </span>
          <!-- 空白の違いを無視する（#453）。バイナリには行が無いので出さない。 -->
          <IgnoreSpaceToggle v-if="!file.binary" toolbar :on="ignoreSpace" @toggle="emit('toggleIgnoreSpace')" />
          <!-- 折り返し。押せるのは行があるときだけ（上下に並べるボタンと同じ条件）。 -->
          <WrapToggle v-if="canStack" toolbar :on="wrapOn" @toggle="toggleWrap" />
          <!-- 上下（新 / 旧）に分ける。押した状態は覚える（`pike:commit-split`）。 -->
          <button
            v-if="canStack"
            class="tool-btn"
            :class="{ active: stacked }"
            :title="t(stacked ? 'commitTab.unified' : 'commitTab.stacked')"
            @click="stacked = !stacked"
          >
            <Rows2 :size="13" />
          </button>
        </div>
        <div v-if="note" class="patch-note">{{ note }}</div>
        <div v-else-if="file.binary" class="patch-note">{{ t('commitTab.binary') }}</div>
        <div v-else-if="!file.lines.length" class="patch-note">
          {{ t(ignoreSpace ? 'diff.noChangesBesidesSpace' : 'commitTab.noContentChange') }}
        </div>
        <!--
          上下に並べた表示（#396）。上が新しい側、下が古い側で、**行は統合形式のものを
          濾しただけ**（差分を取り直さない）。分割線は他の 2 本と同じ配線。
        -->
        <div v-else-if="stacked" ref="stackRef" class="diff-stacked">
          <template v-for="(side, i) in stackedSides" :key="side.key">
            <div v-if="i > 0" class="split-h drag-y-handle" @mousedown="diffDrag.start" />
            <div class="stacked-pane" :class="`${side.key}-side`">
              <div class="side-head">{{ side.label }}</div>
              <div class="side-scroll">
                <PatchLines :lines="side.lines" :side="side.key" :wrap="wrapOn" />
              </div>
            </div>
          </template>
        </div>
        <div v-else class="diff-scroll">
          <PatchLines :lines="file.lines" :wrap="wrapOn" />
        </div>
      </template>
      <div v-else class="patch-empty pad">{{ emptyText }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 3 分割（#396）。左の列は幅を、その中は上の区画の高さを持つ。 */
.patch-split {
  --patch-font: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  flex: 1;
  min-height: 0;
  display: flex;
}

.patch-left {
  width: calc(var(--left-r) * 100%);
  flex-shrink: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
}

/* 分割線。見た目（ホバー・カーソル）は `theme.css` の `.drag-*-handle` と共有する。 */
.split-v {
  width: 5px;
  flex-shrink: 0;
  margin-left: -3px;
  z-index: 1;
}

.split-h {
  height: 5px;
  flex-shrink: 0;
  border-top: 1px solid var(--border);
}

/*
 * 左上の区画。高さは `--meta-r` で決まるが、**縮む側に倒してある**（`flex-shrink: 1`）。
 * 固定にすると、ペインが分割の高さより低いときに下のファイル一覧が 0 まで潰れ、分割線ごと
 * 画面の外へ出て戻せなくなる。ドラッグ中の clamp は「動かしているとき」しか効かないので、
 * それだけでは足りない。
 */
.patch-head {
  height: calc(var(--meta-r) * 100%);
  flex-shrink: 1;
  min-height: 32px;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

/* ファイル一覧は最低限の高さを確保する（上の `.patch-head` が先に縮む）。 */
.patch-files {
  flex: 1;
  min-height: 96px;
  overflow: auto;
  padding-bottom: 8px;
}

/* ここから一覧の行（slot の中身。呼び出し側のスコープで描かれるので `:deep`）。 */
.patch-files :deep(.files-head) {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
}

.patch-files :deep(.file-count) {
  margin-left: auto;
}

/* 見出しの合計の行数（コミットタブ）。行ごとの数は `PatchFileRow.vue` が持つ。 */
.patch-files :deep(.files-head .add-count) {
  color: var(--git-add);
}

.patch-files :deep(.files-head .del-count) {
  color: var(--git-delete);
}

.patch-files :deep(.patch-empty),
.patch-empty {
  color: var(--text-secondary);
  font-size: 12px;
  padding: 8px 12px;
}

.patch-files :deep(.patch-error) {
  padding: 8px 12px;
  color: var(--danger);
  font-size: 12px;
  white-space: pre-wrap;
}

.patch-files :deep(.note) {
  font-style: italic;
}

.patch-empty.pad {
  padding: 16px;
}

.diff-head .file-status {
  font-family: var(--patch-font);
  font-weight: 600;
  width: 12px;
  flex-shrink: 0;
}

.diff-head .file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.patch-diff {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.diff-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  flex-shrink: 0;
}

.diff-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* 上下に並べた表示（#396）。上が新しい側で、`--diff-r` の高さを取る。 */
.diff-stacked {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.stacked-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 上は覚えた比、下は残り。低い窓では上が先に縮む（左の列と同じ倒し方）。 */
.stacked-pane.new-side {
  height: calc(var(--diff-r) * 100%);
  flex-shrink: 1;
  min-height: 32px;
}

.stacked-pane.old-side {
  flex: 1;
  min-height: 60px;
}

.side-head {
  flex-shrink: 0;
  padding: 2px 8px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-secondary);
}

.side-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.patch-note {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
