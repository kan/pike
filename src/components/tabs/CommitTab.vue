<script setup lang="ts">
import { Copy, ExternalLink, RefreshCw, Rows2 } from 'lucide-vue-next'
import { computed, onMounted, type Ref, ref, useTemplateRef, watch } from 'vue'
import { useDragResize } from '../../composables/useDragResize'
import { useI18n } from '../../i18n'
import { type PatchFile, type PatchLine, parsePatch } from '../../lib/commitPatch'
import { buildCommitLink } from '../../lib/gitRemote'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { absoluteDate, gitStatusColor, relativeDate } from '../../lib/paths'
import { loadJson, saveJson } from '../../lib/storage'
import { gitCommitPatch } from '../../lib/tauri'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { CommitTab as CommitTabDef } from '../../types/tab'

/**
 * コミット 1 つの中身（#374、#396 で 4 分割に）。Git パネルのグラフ表示で行を押すと開く。
 *
 * **配置は SourceTree の下半分にそろえてある**: 左上にメタとメッセージ、左下に変更された
 * ファイルの一覧、右に選んだ 1 ファイルの差分。以前は全ファイルの差分を縦に積んでいたので、
 * 大きいコミットでは目当てのファイルまでスクロールし続けることになり、畳む仕掛け
 * （`COLLAPSE_LINES`）を別に持つ必要もあった。**1 ファイルずつ描けばその仕掛けごと要らない。**
 *
 * **メッセージの 1 行目に見出しの様式を当てない**（#396）。件名と本文は 1 つの文章で、
 * git 自身も 1 行目を特別な書式として扱わない。太く大きくすると、本文の 1 行目だけが
 * 見出しに見える。
 *
 * **読み取り専用。** ファイルの見出しの「左右に並べて見る」は既存の diff タブ（文字単位の
 * 強調つき）を開く。こちらはコミット全体をひと目で読むための場所。
 */
const { t } = useI18n()
const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const gitStore = useGitStore()
const statusMessage = useStatusMessageStore()

const tab = computed(() => tabStore.tabs.find((x): x is CommitTabDef => x.id === props.tabId && x.kind === 'commit'))

const files = ref<PatchFile[]>([])
const truncated = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
/** 右に出しているファイル（パス）。取得のたびに先頭へ戻す。 */
const selectedPath = ref<string | null>(null)
const selected = computed(() => files.value.find((f) => f.path === selectedPath.value) ?? null)

const message = computed(() => tab.value?.message.trim() ?? '')
const subject = computed(() => tab.value?.message.split('\n')[0] ?? '')
const commitLink = computed(() => (tab.value ? buildCommitLink(gitStore.remoteUrl, tab.value.hash) : null))
const totals = computed(() =>
  files.value.reduce((s, f) => ({ added: s.added + f.added, removed: s.removed + f.removed }), {
    added: 0,
    removed: 0,
  }),
)
const dateTitle = computed(() => (tab.value ? absoluteDate(tab.value.date) : ''))

/**
 * 画面の割り方（#396）。**比で持ち、開き方（`stacked`）と一緒にマシンごとに覚える**
 * （`pike:commit-split`）。
 *
 * **px ではなく比にしてある**のは、覚えた値をウィンドウの大きさが違う環境でも使うため
 * （diff タブの `--split` と同じ形）。下限だけは px で見る: 比の下限にすると、狭い
 * ウィンドウで左の列が読めない幅まで詰められる。
 *
 * **プロジェクトでは分けない**（グラフの列幅 `pike:git-graph-width` と同じ扱い）。
 * 見た目の好みなので、同期の対象にもしない。
 *
 * **ドラッグ中は Vue を通さない**（`.claude/rules/git.md` の diff タブと同じ）。値を
 * `:style` に載せると、動かすたびにこのコンポーネントの render が丸ごと走り、**仮想化して
 * いない差分の表の vnode が行数ぶん作り直される**（1 ファイルで数千行になりうる）。
 * 書きたいのはカスタムプロパティなので、そこだけ素の DOM 操作に逃がし、確定値だけを
 * ref に入れる。
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

/** 取得は開いたときと更新ボタンのときだけ（コミットの中身は変わらない）。 */
async function load() {
  const def = tab.value
  const project = projectStore.currentProject
  if (!def || !project || loading.value) return
  loading.value = true
  try {
    const res = await gitCommitPatch(def.root, project.shell, def.hash, def.parent)
    files.value = parsePatch(res.patch)
    // 取り直したら先頭のファイルを出す。**ここが `files` を書く唯一の場所**なので、
    // watcher を挟まずに並べて書く（初回も更新ボタンも `load()` を通る）。
    selectedPath.value = files.value[0]?.path ?? null
    truncated.value = res.truncated
    error.value = null
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

/**
 * 上下に並べたときの 2 つの面（#396）。**統合形式の行を濾すだけで作る**ので、差分を
 * 取り直さない（新しい側は削除行を、古い側は追加行を落とす）。
 *
 * **hunk の見出しは両方に残す。** 飛ばした範囲の目印なので、片方から落とすと、離れた
 * 変更どうしが続きの行に見える。
 */
const stackedSides = computed(() => {
  const lines = selected.value?.lines ?? []
  return [
    {
      key: 'new' as const,
      label: t('commitTab.newSide'),
      lines: lines.filter((l) => l.type !== 'del'),
      num: (l: PatchLine) => l.newNum,
    },
    {
      key: 'old' as const,
      label: t('commitTab.oldSide'),
      lines: lines.filter((l) => l.type !== 'add'),
      num: (l: PatchLine) => l.oldNum,
    },
  ]
})

/** 上下に並べられるか（中身の無いファイルでは押しても何も変わらない）。 */
const canStack = computed(() => !!selected.value && !selected.value.binary && selected.value.lines.length > 0)

async function copyHash() {
  if (!tab.value) return
  try {
    await navigator.clipboard.writeText(tab.value.hash)
    statusMessage.show({ text: t('commitTab.hashCopied'), durationMs: 2000 })
  } catch (e) {
    statusMessage.show({ text: String(e), variant: 'error', durationMs: 6000 })
  }
}

onMounted(load)
</script>

<template>
  <div class="commit-tab" data-testid="commit-tab">
    <div class="md-toolbar">
      <span class="commit-title">{{ subject }}</span>
      <button class="tool-btn" :title="t('commitTab.refresh')" :disabled="loading" @click="load">
        <RefreshCw :size="14" :class="{ spin: loading }" />
      </button>
      <button
        v-if="commitLink"
        class="tool-btn"
        :title="t('commitTab.openRemote', { label: commitLink.label })"
        @click="openUrlWithConfirm(commitLink.url)"
      >
        <ExternalLink :size="14" />
      </button>
    </div>

    <!--
      分割の位置は 2 つともカスタムプロパティで持つ（#396）。ドラッグ中はここを素の DOM 操作で
      書き換えるので、`:style` に載せるのは押していないときの値だけ。
    -->
    <div v-if="tab" ref="rootRef" class="commit-split" :style="{ '--left-r': leftRatio, '--meta-r': metaRatio }">
      <div ref="leftRef" class="commit-left">
        <!-- 左上：メタとメッセージ。 -->
        <div class="commit-head">
          <div class="commit-meta">
            <button class="hash" :title="t('commitTab.copyHash')" @click="copyHash">
              <Copy :size="11" />{{ tab.hash.slice(0, 10) }}
            </button>
            <span>{{ tab.author }}</span>
            <span :title="dateTitle">{{ relativeDate(tab.date) }}</span>
            <span v-if="tab.refs" class="refs">{{ tab.refs }}</span>
          </div>
          <pre class="commit-message">{{ message }}</pre>
        </div>
        <div class="split-h drag-y-handle" @mousedown="metaDrag.start" />

        <!-- 左下：変更されたファイルの一覧。 -->
        <div class="commit-files">
          <div class="files-head">
            <span>{{ t('commitTab.files') }}</span>
            <template v-if="files.length">
              <span class="file-count">{{ t('commitTab.stats', { files: String(files.length) }) }}</span>
              <span class="add-count">+{{ totals.added }}</span>
              <span class="del-count">-{{ totals.removed }}</span>
            </template>
            <span v-if="!tab.parent" class="note">{{ t('commitTab.rootCommit') }}</span>
          </div>
          <div v-if="error" class="commit-error">{{ error }}</div>
          <div v-else-if="loading && !files.length" class="commit-empty">{{ t('common.loading') }}</div>
          <div v-else-if="!files.length" class="commit-empty">{{ t('commitTab.noChanges') }}</div>
          <button
            v-for="file in files"
            :key="file.path"
            class="file-row"
            :class="{ selected: file.path === selectedPath }"
            @click="selectedPath = file.path"
          >
            <span class="file-status" :style="{ color: gitStatusColor(file.status) }">{{ file.status }}</span>
            <span class="file-path" :title="file.path">
              <template v-if="file.oldPath">{{ file.oldPath }} → </template>{{ file.path }}
            </span>
            <span class="add-count">+{{ file.added }}</span>
            <span class="del-count">-{{ file.removed }}</span>
          </button>
          <div v-if="truncated" class="commit-empty">{{ t('commitTab.truncated') }}</div>
        </div>
      </div>

      <div class="split-v drag-x-handle" @mousedown="leftDrag.start" />

      <!-- 右：選んだファイルの差分。 -->
      <div class="commit-diff">
        <template v-if="selected">
          <div class="diff-head">
            <span class="file-status" :style="{ color: gitStatusColor(selected.status) }">{{ selected.status }}</span>
            <span class="file-path" :title="selected.path">
              <template v-if="selected.oldPath">{{ selected.oldPath }} → </template>{{ selected.path }}
            </span>
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
          <div v-if="selected.binary" class="patch-note">{{ t('commitTab.binary') }}</div>
          <div v-else-if="!selected.lines.length" class="patch-note">{{ t('commitTab.noContentChange') }}</div>
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
                  <table class="patch-table">
                    <tbody>
                      <tr v-for="(line, j) in side.lines" :key="j" :class="line.type">
                        <td class="num">{{ side.num(line) ?? '' }}</td>
                        <td class="code">{{ line.text }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </template>
          </div>
          <div v-else class="diff-scroll">
            <table class="patch-table">
              <tbody>
                <tr v-for="(line, i) in selected.lines" :key="i" :class="line.type">
                  <td class="num">{{ line.oldNum ?? '' }}</td>
                  <td class="num">{{ line.newNum ?? '' }}</td>
                  <td class="code">{{ line.text }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <div v-else class="commit-empty pad">{{ t('commitTab.selectFile') }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.commit-tab {
  --patch-font: "PlemolJP Console NF", "Cascadia Code", "Fira Code", monospace;
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.commit-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
}

/* 4 分割（#396）。左の列は幅を、その中はメタの高さを持つ。 */
.commit-split {
  flex: 1;
  min-height: 0;
  display: flex;
}

.commit-left {
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
 * 左上のメタとメッセージ。高さは `metaHeight`（インラインの `height`）で決まるが、
 * **縮む側に倒してある**（`flex-shrink: 1`）。固定にすると、ペインが分割の高さより
 * 低いときに下のファイル一覧が 0 まで潰れ、分割線ごと画面の外へ出て戻せなくなる。
 * ドラッグ中の clamp は「動かしているとき」しか効かないので、それだけでは足りない。
 */
.commit-head {
  height: calc(var(--meta-r) * 100%);
  flex-shrink: 1;
  min-height: 32px;
  overflow: auto;
  padding: 10px 12px;
}

.commit-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.hash {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--patch-font);
  font-size: 11px;
  cursor: pointer;
}

.hash:hover {
  color: var(--text-primary);
  background: var(--tab-hover-bg);
}

.refs {
  font-size: 10px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--accent);
  color: var(--on-accent);
}

/* **1 行目に見出しの様式を当てない**（#396）。件名と本文は 1 つの文章。 */
.commit-message {
  margin: 8px 0 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ファイル一覧は最低限の高さを確保する（上の `.commit-head` が先に縮む）。 */
.commit-files {
  flex: 1;
  min-height: 96px;
  overflow: auto;
  padding-bottom: 8px;
}

.files-head {
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

.file-count {
  margin-left: auto;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  padding: 3px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.file-row:hover {
  background: var(--tab-hover-bg);
}

.file-row.selected {
  background: var(--accent);
  color: var(--on-accent);
}

/* 塗りの上では、状態とファイル名以外も読める色にそろえる（`--text-active` は地の色を
   見ないので、ライトテーマの青地で沈む）。 */
.file-row.selected .add-count,
.file-row.selected .del-count {
  color: var(--on-accent-muted);
}

.file-status {
  font-family: var(--patch-font);
  font-weight: 600;
  width: 12px;
  flex-shrink: 0;
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add-count {
  color: var(--git-add);
  font-size: 11px;
}

.del-count {
  color: var(--git-delete);
  font-size: 11px;
}

.note {
  font-style: italic;
}

.commit-diff {
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

.tool-btn.active {
  color: var(--accent);
}

.commit-error {
  padding: 8px 12px;
  color: var(--danger);
  font-size: 12px;
  white-space: pre-wrap;
}

.commit-empty {
  color: var(--text-secondary);
  font-size: 12px;
  padding: 8px 12px;
}

.commit-empty.pad {
  padding: 16px;
}

.patch-note {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-secondary);
}

.patch-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--patch-font);
  font-size: 12px;
  line-height: 18px;
}

.num {
  width: 1%;
  min-width: 36px;
  padding: 0 6px;
  text-align: right;
  color: var(--text-secondary);
  opacity: 0.5;
  user-select: none;
  white-space: nowrap;
  vertical-align: top;
}

.code {
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.add {
  background: rgba(78, 201, 176, 0.1);
}

.del {
  background: rgba(244, 71, 71, 0.1);
}

.hunk {
  background: rgba(0, 122, 204, 0.08);
  color: var(--accent);
}

.note .code {
  color: var(--text-secondary);
  font-style: italic;
}
</style>
