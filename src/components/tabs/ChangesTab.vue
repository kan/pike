<script setup lang="ts">
import { Minus, Plus, RefreshCw, Undo2 } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { fsWatcher } from '../../composables/useFsWatcher'
import { useGitFileActions } from '../../composables/useGitFileActions'
import { useI18n } from '../../i18n'
import { type PatchFile, parsePatch, patchFilesByPath } from '../../lib/commitPatch'
import { normalizeSep } from '../../lib/paths'
import { gitDiff, gitWorkingPatch } from '../../lib/tauri'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { GitFileChange } from '../../types/git'
import type { ChangesTab as ChangesTabDef } from '../../types/tab'
import PatchFileRow from '../PatchFileRow.vue'
import PatchSplit from '../PatchSplit.vue'

/**
 * まだコミットしていない変更を、コミットタブと同じ配置で見る（#526）。左上がコミット
 * メッセージの欄、左下が変更の一覧（コンフリクト / ステージ済み / 未ステージ）、右が選んだ
 * 1 ファイルの差分。分割と右の差分は `PatchSplit.vue`（コミットタブと共有）。
 *
 * **一覧は `gitStore.status` から作り、差分の行だけをこのタブが取る。** Git パネルと同じ一覧が
 * 並ぶので、ステージやコミットの結果が両方に同じ形で出る。差分は `git_working_patch` で
 * ステージ済み・未ステージの 2 本をまとめて取り、パスで引く。未追跡のファイルは `git diff` に
 * 出ないので、選んだときに 1 つずつ取る（`untracked`）。
 *
 * **操作はファイル単位まで**（ステージ / アンステージ / 破棄。hunk 単位は持たない）。実体は
 * Git パネルの行のボタンと同じ `useGitFileActions`。コミットの欄は Git パネルと中身を共有する
 * （`gitStore.commitDraft`）。
 */
const { t } = useI18n()
const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const gitStore = useGitStore()
const statusMessage = useStatusMessageStore()
const { workingPath, openWorkingFile, discardFile, unstageFile } = useGitFileActions()

const tab = computed(() => tabStore.tabs.find((x): x is ChangesTabDef => x.id === props.tabId && x.kind === 'changes'))

type Section = 'staged' | 'unstaged'

/** 差分（パス → ファイル）。`null` はまだ一度も取れていない。 */
const stagedFiles = ref<Map<string, PatchFile> | null>(null)
const unstagedFiles = ref<Map<string, PatchFile> | null>(null)
/**
 * 未追跡のファイルの差分（選んだときに取る）。`'failed'` は取れなかったもの（読み込み中の
 * まま出し続けず、10 秒ごとに取り直しもしない）。取り直しのたびに捨てる。
 */
const untrackedFiles = ref(new Map<string, PatchFile | 'failed'>())
/**
 * 未追跡の取得の世代。`untrackedFiles` を捨てたときだけ進める（取り直しが**通ったとき**と
 * root が変わったとき）。`fetchSeq` で見ると、取り直しが失敗したときに飛んでいた取得まで
 * 捨てられ、誰も取り直さないので「読み込み中」のまま残る。
 */
let untrackedEpoch = 0
/** 飛んでいる取得は最後のものだけを採る（`DiffTab` の `refreshSeq` と同じ）。 */
let fetchSeq = 0
const truncated = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
/**
 * 空白の違いを無視して見るか（#453）。こちらは**一覧を `status` から作る**ので、`-w` で
 * ファイルが差分から消えても一覧からは消えない（コミットタブの `spaceFiles` の仕掛けが要らない）。
 * 切り替えたら取り直すだけでよい。
 */
const ignoreSpace = ref(false)
const selected = ref<{ section: Section; path: string } | null>(null)

const status = computed(() => gitStore.status)
const staged = computed(() => status.value?.staged ?? [])
const unstaged = computed(() => status.value?.unstaged ?? [])
const conflicted = computed(() => status.value?.conflicted ?? [])

/**
 * 行の差分。`undefined` はまだ取れていない、`'failed'` は取れなかった（未追跡のみ）。
 * 取れた差分に居ないファイルは `null`（名前やモードだけの変更、空白だけの変更）。
 */
function patchOf(section: Section, file: GitFileChange): PatchFile | 'failed' | null | undefined {
  if (section === 'unstaged' && file.status === '?') return untrackedFiles.value.get(file.path)
  const map = (section === 'staged' ? stagedFiles : unstagedFiles).value
  return map ? (map.get(file.path) ?? null) : undefined
}

/**
 * 一覧の 2 区画。**行ごとの差分はここで 1 回だけ引く**（テンプレートで行ごとに何度も
 * 引かない）。
 */
const sections = computed(() =>
  (
    [
      { key: 'staged', files: staged.value },
      { key: 'unstaged', files: unstaged.value },
    ] as const
  )
    .filter((s) => s.files.length)
    .map((s) => ({
      key: s.key,
      rows: s.files.map((file) => {
        const patch = patchOf(s.key, file)
        return { file, patch: typeof patch === 'object' && patch ? patch : null }
      }),
    })),
)

/** 差分に出てこなかったファイルの代わり（見出しだけを出す）。 */
function placeholder(file: GitFileChange): PatchFile {
  const s = file.status === '?' ? 'A' : file.status
  const status = s === 'A' || s === 'D' || s === 'R' || s === 'C' ? s : 'M'
  return { path: file.path, oldPath: file.origPath ?? null, status, binary: false, added: 0, removed: 0, lines: [] }
}

const selectedChange = computed(() => {
  const sel = selected.value
  if (!sel) return null
  return (sel.section === 'staged' ? staged.value : unstaged.value).find((f) => f.path === sel.path) ?? null
})

/**
 * 右に出すファイルと、差分の代わりに出す文言。差分がまだ無ければ見出しだけ出せるよう代わりの
 * ファイルを置き、文言（読み込み中・取れなかった）が中身を言う。取れた差分に居ないなら文言は
 * 出さない（`PatchSplit` が「内容の変更はありません」を出す）。
 */
const view = computed(() => {
  const sel = selected.value
  const change = selectedChange.value
  if (!sel || !change) return { file: null, note: null }
  const patch = patchOf(sel.section, change)
  if (patch && patch !== 'failed') return { file: patch, note: null }
  const note = patch === 'failed' ? t('changesTab.loadFailed') : patch === undefined ? t('common.loading') : null
  return { file: placeholder(change), note }
})

/**
 * 選択を保つ。一覧が変わったら（ステージした・コミットした）、**同じパスをもう一方の区画で
 * 探す**: ステージしたファイルは選んだまま「ステージ済み」へ移る。どちらにも無ければ先頭へ。
 */
watch(
  [staged, unstaged],
  () => {
    const sel = selected.value
    const has = (section: Section, path: string) =>
      (section === 'staged' ? staged.value : unstaged.value).some((f) => f.path === path)
    if (sel && has(sel.section, sel.path)) return
    const other: Section = sel?.section === 'staged' ? 'unstaged' : 'staged'
    if (sel && has(other, sel.path)) {
      selected.value = { section: other, path: sel.path }
      return
    }
    const first = staged.value[0] ? { section: 'staged' as const, path: staged.value[0].path } : null
    selected.value = first ?? (unstaged.value[0] ? { section: 'unstaged', path: unstaged.value[0].path } : null)
  },
  { immediate: true },
)

/** 未追跡のファイルの差分を取る（選んだときだけ。取れなかったものも取り直さない）。 */
async function loadUntracked(path: string) {
  const project = projectStore.currentProject
  if (!project || untrackedFiles.value.has(path)) return
  const root = projectStore.activeRoot
  const epoch = untrackedEpoch
  let entry: PatchFile | 'failed'
  try {
    const file = parsePatch(await gitDiff(root, project.shell, path, false, true))[0]
    entry = file ? { ...file, path } : 'failed'
  } catch {
    entry = 'failed'
  }
  if (epoch === untrackedEpoch) untrackedFiles.value.set(path, entry)
}

/** 未追跡のぶんを捨てる（次に選んだとき、または今選んでいれば今取り直す）。 */
function dropUntracked(paths?: string[]) {
  untrackedEpoch++
  if (paths) for (const p of paths) untrackedFiles.value.delete(p)
  else untrackedFiles.value = new Map()
  if (!untrackedSelection.value) return
  // 描かれていないなら取りに行かず、見えた時点の取り直しに任せる（`scheduleRefetch` と同じ）。
  if (tabStore.isTabVisible(props.tabId)) void loadUntracked(untrackedSelection.value)
  else staleWhileHidden = true
}

/**
 * 選んでいる未追跡のファイル。**文字列で見る**: `selectedChange` は 10 秒ごとのポーリングで
 * 別のオブジェクトになるので、そちらを見ると選び直していないのに取りに行く。
 */
const untrackedSelection = computed(() => (selectedChange.value?.status === '?' ? selectedChange.value.path : null))
watch(untrackedSelection, (path) => path && loadUntracked(path))

/**
 * 差分を取り直す。`space` は空白を無視して取るか（既定は今の見方）。**見方（`ignoreSpace`）は
 * 取れてから差分と一緒に書く**（コミットタブと同じ。先に変えると、取れるまでのあいだボタンは
 * 無視している見た目なのに中身は無視していない差分になり、失敗するとそのまま残る）。
 */
async function refetch(space = ignoreSpace.value) {
  const project = projectStore.currentProject
  if (!project) return
  // **await の前に捕まえる**（`.claude/rules/git-diff.md` の #321）。待っているあいだに
  // worktree を切り替えられても、取り直しは新しい root で走り直す（`statusKey` が root を含む）。
  const root = projectStore.activeRoot
  const seq = ++fetchSeq
  loading.value = true
  try {
    const res = await gitWorkingPatch(root, project.shell, space)
    if (seq !== fetchSeq) return
    stagedFiles.value = patchFilesByPath(res.staged)
    unstagedFiles.value = patchFilesByPath(res.unstaged)
    ignoreSpace.value = space
    truncated.value = res.truncated
    error.value = null
    dropUntracked()
  } catch (e) {
    if (seq === fetchSeq) error.value = String(e)
  } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

/**
 * 取り直しの予約。ファイルの変更は続けて来る（エージェントが何ファイルも書く、保存が
 * 複数のイベントになる）ので、少し待ってまとめる。**描かれていないタブでは取り直さない**
 * （`DiffTab` と同じ。見えるようになった時点で 1 回だけ取り直す）。
 */
const REFETCH_DELAY_MS = 200
let refetchTimer: ReturnType<typeof setTimeout> | null = null
let staleWhileHidden = false
function scheduleRefetch() {
  if (!tabStore.isTabVisible(props.tabId)) {
    staleWhileHidden = true
    return
  }
  if (refetchTimer) clearTimeout(refetchTimer)
  refetchTimer = setTimeout(() => {
    refetchTimer = null
    void refetch()
  }, REFETCH_DELAY_MS)
}

/**
 * 一覧の中身が変わったら取り直す。**`status` そのものを見ない**: 10 秒ごとのポーリングで
 * 中身が同じでも別のオブジェクトに入れ替わるので、そのたびに差分を取り直すことになる。
 *
 * **root も含める。** 同じコミットにいる 2 つの worktree で同じファイルを直していると、
 * 切り替えても一覧は同じに見え、前の worktree の差分が残る（操作は新しい root に効く）。
 */
const statusKey = computed(() => {
  const s = status.value
  if (!s) return ''
  const list = (files: GitFileChange[]) => files.map((f) => `${f.status}:${f.path}`).join('|')
  return `${projectStore.activeRoot}\n${s.head}\n${list(s.staged)}\n${list(s.unstaged)}`
})
watch(statusKey, scheduleRefetch)
watch(
  () => tabStore.isTabVisible(props.tabId),
  (visible) => {
    if (!visible || !staleWhileHidden) return
    staleWhileHidden = false
    void refetch()
  },
)

/**
 * 一覧に並んでいるファイルの絶対パス（区切りは正規化済み）。ファイルの変更の照合に使う。
 * `status` が変わったときだけ作り直す（ファイルの変更は続けて来るので、そのたびに作らない）。
 */
const watchedPaths = computed(() => {
  // 絶対パス → 一覧のパス（ルート相対）と、未追跡だけか。未追跡のファイルは `git diff` に
  // 出ないので、それだけが変わったときは 2 本の `git diff` を走らせずにそのぶんだけ捨てる。
  const out = new Map<string, { rel: string; untrackedOnly: boolean }>()
  for (const f of [...staged.value, ...unstaged.value]) {
    const full = workingPath(f.path)
    if (!full) continue
    const key = normalizeSep(full)
    const untracked = f.status === '?' && (out.get(key)?.untrackedOnly ?? true)
    out.set(key, { rel: f.path, untrackedOnly: untracked })
  }
  return out
})

/**
 * 一覧が同じままファイルの中身だけ変わったら取り直す。**一覧に並んでいるファイルだけを拾う**:
 * 増えたファイルは 10 秒ごとの `git status` が知らせ（`statusKey`）、ビルドの出力のような
 * 無視されたファイルの変更では取り直さない。
 *
 * **自分で購読してよい**（diff タブは `App.vue` の照合に乗る。`.claude/rules/git-diff.md` の
 * #321）。あちらが 1 か所に閉じているのは、タブごとに焼き込んだ root との照合と、自分の保存の
 * 印（`isRecentlySaved`）の消費があるため。このタブは `activeRoot` を見ていて、印も読まない。
 */
const stopWatching = fsWatcher.onFileChange((files) => {
  const paths = watchedPaths.value
  const hits = files.flatMap((f) => paths.get(normalizeSep(f.path)) ?? [])
  if (!hits.length) return
  if (hits.every((h) => h.untrackedOnly)) dropUntracked(hits.map((h) => h.rel))
  else scheduleRefetch()
})
// 監視が張り直された（#433）。止まっていたあいだに何が変わったかは分からないので取り直す。
const stopResync = fsWatcher.onRestart(scheduleRefetch)

function toggleIgnoreSpace() {
  void refetch(!ignoreSpace.value)
}

function onCommit() {
  void gitStore.commitChanges((message) => statusMessage.show({ text: message, variant: 'error', durationMs: 6000 }))
}

onMounted(() => {
  // `status` がまだ無い（パネルを一度も開いていない）なら取りに行く。届いたら `statusKey` の
  // watcher が差分を取るので、ここで並べて取らない（取ると同じ差分を 2 回取る）。
  if (status.value) void refetch()
  else void gitStore.refreshStatus()
})
onUnmounted(() => {
  stopWatching()
  stopResync()
  if (refetchTimer) clearTimeout(refetchTimer)
})
</script>

<template>
  <div class="changes-tab" data-testid="changes-tab">
    <div class="md-toolbar">
      <span class="changes-title">
        {{ t('changesTab.title') }}<template v-if="status?.branch"> · {{ status.branch }}</template>
      </span>
      <button class="tool-btn" :title="t('commitTab.refresh')" :disabled="loading" @click="refetch()">
        <RefreshCw :size="14" :class="{ spin: loading }" />
      </button>
    </div>

    <PatchSplit
      v-if="tab"
      :file="view.file"
      :ignore-space="ignoreSpace"
      :note="view.note"
      :empty-text="t(staged.length || unstaged.length ? 'commitTab.selectFile' : 'git.noChanges')"
      @toggle-ignore-space="toggleIgnoreSpace"
    >
      <!-- 左上：コミットメッセージ（Git パネルの欄と中身を共有する）。 -->
      <template #head>
        <div class="commit-box">
          <textarea
            v-model="gitStore.commitDraft"
            class="commit-input"
            :placeholder="t('changesTab.messagePlaceholder')"
          ></textarea>
          <div class="commit-row">
            <span v-if="status && (status.ahead || status.behind)" class="sync-info">
              <span v-if="status.ahead">{{ t('git.aheadInfo', { count: status.ahead }) }}</span>
              <span v-if="status.ahead && status.behind"> · </span>
              <span v-if="status.behind">{{ t('git.behindInfo', { count: status.behind }) }}</span>
            </span>
            <button
              class="commit-btn"
              :disabled="!gitStore.commitDraft.trim() || !staged.length || gitStore.committing"
              @click="onCommit"
            >
              {{ t('git.commit', { count: staged.length }) }}
            </button>
          </div>
        </div>
      </template>

      <!-- 左下：変更の一覧。区画の並びと操作は Git パネルと同じ。 -->
      <template #files>
        <div v-if="error" class="patch-error selectable">{{ error }}</div>

        <template v-if="conflicted.length">
          <div class="files-head">
            <span>{{ t('git.conflicts', { count: conflicted.length }) }}</span>
          </div>
          <!-- コンフリクトは差分を出さず、エディタで開く（`git diff` が combined diff を返す。#309）。 -->
          <PatchFileRow
            v-for="file in conflicted"
            :key="'c-' + file.path"
            :status="file.status"
            :path="file.path"
            :selected="false"
            :title="t('git.openConflict')"
            danger
            @click="openWorkingFile(file.path)"
          />
        </template>

        <template v-for="section in sections" :key="section.key">
          <div class="files-head">
            <template v-if="section.key === 'staged'">
              <span>{{ t('git.staged', { count: staged.length }) }}</span>
              <button class="head-action" @click="gitStore.unstageFiles(staged)">{{ t('git.unstageAll') }}</button>
            </template>
            <template v-else>
              <span>{{ t('git.changes', { count: unstaged.length }) }}</span>
              <button class="head-action" @click="gitStore.stageFiles(unstaged.map((f) => f.path))">
                {{ t('git.stageAll') }}
              </button>
            </template>
          </div>
          <PatchFileRow
            v-for="{ file, patch } in section.rows"
            :key="section.key + file.path"
            :status="file.status"
            :path="file.path"
            :old-path="file.origPath"
            :added="patch?.added"
            :removed="patch?.removed"
            :selected="selected?.section === section.key && selected.path === file.path"
            @click="selected = { section: section.key, path: file.path }"
          >
            <button v-if="section.key === 'staged'" :title="t('git.unstage')" @click="unstageFile(file)">
              <Minus :size="12" :stroke-width="2" />
            </button>
            <template v-else>
              <button :title="t('git.discard')" @click="discardFile(file)">
                <Undo2 :size="12" :stroke-width="2" />
              </button>
              <button :title="t('git.stage')" @click="gitStore.stageFiles([file.path])">
                <Plus :size="12" :stroke-width="2" />
              </button>
            </template>
          </PatchFileRow>
        </template>

        <div v-if="!staged.length && !unstaged.length && !conflicted.length" class="patch-empty">
          {{ t('git.noChanges') }}
        </div>
        <div v-if="truncated" class="patch-empty">{{ t('commitTab.truncated') }}</div>
      </template>
    </PatchSplit>
  </div>
</template>

<style scoped>
.changes-tab {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.changes-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
}

/* 左上の区画いっぱいに欄を広げる（区画の高さは分割線で変わる）。 */
.commit-box {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
}

.commit-input {
  flex: 1;
  min-height: 40px;
  resize: none;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}

.commit-input:focus {
  outline: none;
  border-color: var(--accent);
}

.commit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.sync-info {
  font-size: 11px;
  color: var(--text-secondary);
}

.commit-btn {
  margin-left: auto;
  padding: 4px 12px;
  border: none;
  border-radius: 3px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
  cursor: pointer;
}

.commit-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.head-action {
  margin-left: auto;
  padding: 1px 6px;
  border: none;
  border-radius: 2px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
}

.head-action:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}
</style>
