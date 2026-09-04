<script setup lang="ts">
import { ArrowUp, Check, ChevronDown, ChevronRight, Minus, Plus, Undo2 } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useActiveFile } from '../../composables/useActiveFile'
import { useAnchoredPopup } from '../../composables/useAnchoredPopup'
import { confirmDialog, infoDialog, promptDialog } from '../../composables/useConfirmDialog'
import { useI18n } from '../../i18n'
import { fileIconSvg } from '../../lib/fileIcons'
import { buildGraph, DOT_RADIUS, LANE_WIDTH, ROW_HEIGHT } from '../../lib/gitGraph'
import { appendGitignoreLine, gitignoreEntry, hasGitignoreEntry } from '../../lib/gitignore'
import { buildCommitLink } from '../../lib/gitRemote'
import { openPathInTab } from '../../lib/openFile'
import { openUrlWithConfirm } from '../../lib/openUrl'
import {
  basename,
  extension,
  gitStatusColor,
  isImageFile,
  joinPath,
  mimeType,
  pathSep,
  relativeDate,
} from '../../lib/paths'
import {
  fsDelete,
  fsReadFile,
  fsWriteFile,
  gitCreateBranch,
  gitDiff,
  gitDiffCommit,
  gitShowFile,
  gitShowFileBase64,
  gitShowFiles,
} from '../../lib/tauri'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useSidebarStore } from '../../stores/sidebar'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { GitFileChange, GitLogEntry } from '../../types/git'

const { t } = useI18n()
const { isActiveFile } = useActiveFile()

const gitStore = useGitStore()
const projectStore = useProjectStore()
const tabStore = useTabStore()
const sidebar = useSidebarStore()
const statusMessage = useStatusMessageStore()

const commitMsg = ref('')
const commitView = ref<'list' | 'graph'>('list')
const initializing = ref(false)

async function onInit() {
  initializing.value = true
  try {
    await gitStore.initRepo()
  } finally {
    initializing.value = false
  }
}

// --- Stopped operation banner (#222) ---------------------------------------
// `am` and `bisect` are reported too, so a stopped merge is never mislabeled as
// a rebase; the backend's `canContinue` says which kinds get buttons.
const operation = computed(() => gitStore.status?.operation ?? null)

const operationTitle = computed(() => {
  const op = operation.value
  if (!op) return ''
  const progress = op.step && op.total ? ` (${op.step}/${op.total})` : ''
  return `${t(`git.op.${op.kind}`)}${op.branch ? ` — ${op.branch}` : ''}${progress}`
})

const operationHint = computed(() => (operation.value ? t(`git.opHint.${operation.value.stop}`) : ''))

const continueLabel = computed(() =>
  operation.value?.stop === 'commit-failed' ? t('git.opRecommit') : t('git.opContinue'),
)

// Every `--continue` refuses outright while paths are still unmerged ("You must
// edit all merge conflicts and then mark them as resolved using git add"), so
// the button waits for the staging the hint asks for rather than handing the
// user that error.
const continueBlocked = computed(() => (gitStore.status?.conflicted.length ?? 0) > 0)

const graphRows = computed(() => buildGraph(gitStore.logEntries))

// Compute set of unpushed commit hashes by following first-parent chain from HEAD
const unpushedHashes = computed(() => {
  const ahead = gitStore.status?.ahead ?? 0
  if (ahead === 0) return new Set<string>()

  const entries = gitStore.logEntries
  if (!entries.length) return new Set<string>()

  const entryMap = new Map<string, GitLogEntry>()
  for (const e of entries) entryMap.set(e.hash, e)

  const set = new Set<string>()
  let current: string | undefined = entries[0]?.hash
  for (let i = 0; i < ahead && current; i++) {
    set.add(current)
    const entry = entryMap.get(current)
    current = entry?.parents[0]
  }
  return set
})
const graphSvgWidth = computed(() => {
  const maxCol = graphRows.value.reduce((m, r) => Math.max(m, r.maxCol), 0)
  return (maxCol + 2) * LANE_WIDTH
})

function switchToGraph() {
  commitView.value = 'graph'
  gitStore.refreshLog(true)
}

function switchToList() {
  commitView.value = 'list'
  gitStore.refreshLog(false)
}

// Commit tree expansion
const expandedCommits = ref<Set<string>>(new Set())
const commitFiles = ref<Record<string, GitFileChange[]>>({})

async function onCommit() {
  if (!commitMsg.value.trim() || !gitStore.status?.staged.length) return
  await gitStore.commitChanges(commitMsg.value.trim())
  commitMsg.value = ''
}

async function discardFile(file: GitFileChange) {
  if (!(await confirmDialog(t('git.discardConfirm', { path: file.path })))) return
  if (file.status === '?') {
    const shell = projectStore.currentProject?.shell
    const full = workingPath(file.path)
    if (!shell || !full) return
    await fsDelete(shell, full)
    await gitStore.refreshStatus()
  } else {
    await gitStore.discardChanges([file.path])
  }
}

async function unstageFile(file: GitFileChange) {
  if (file.status === 'A') {
    if (!(await confirmDialog(t('git.unstageNewConfirm', { path: file.path })))) return
    const shell = projectStore.currentProject?.shell
    const full = workingPath(file.path)
    if (shell && full) {
      await gitStore.unstageFiles([file])
      await fsDelete(shell, full).catch(() => {})
      await gitStore.refreshStatus()
    }
  } else {
    await gitStore.unstageFiles([file])
  }
}

/**
 * **`GitFileChange` をそのまま受ける。** untracked かどうかも元の名前（#306）も、呼び出し元が
 * 持っている 1 つの値から導ける。ばらして渡していたころは、`file.status === '?'` の導出が
 * テンプレートの 4 箇所に写され、`GitFileChange` に diff で要るフィールドが増えるたびに
 * 呼び出しと `fileCtx` の型を並べて直すことになっていた。
 */
async function openDiffTab(file: GitFileChange, staged: boolean) {
  const project = projectStore.currentProject
  if (!project) return
  const untracked = file.status === '?'
  const diff = await gitDiff(
    projectStore.activeRoot,
    project.shell,
    file.path,
    staged,
    untracked,
    file.origPath ?? null,
  )
  tabStore.addDiffTab({ filePath: file.path, diff, staged })
}

/**
 * git が返すルート相対パスを、このプロジェクトのシェルの区切りでフルパスにする。
 * **joinPath で区切りを揃えるのが要点**。git は常に `/` を返すが Windows のタブは `\` を使い、
 * 混ざったパスは fs watcher のイベント（完全一致で比べる）と噛み合わない。
 *
 * **導けないときは空文字ではなく null を返す。** `activeRoot` は空文字になりうる非 null の
 * computed なので、番兵にすると「ルートを知らない」という事実が型から消え、呼び出し側の確認が
 * 強制されない（実際、クリップボードへ空文字を書く経路ができていた）。
 */
function workingPath(path: string): string | null {
  const root = projectStore.activeRoot
  return root ? joinPath(root, path, pathSep(projectStore.currentProject?.shell)) : null
}

// Open the working-tree copy of a file. For a conflicted one the editor is where
// the markers get resolved, by hand or with the per-region buttons (#223).
async function openWorkingFile(path: string) {
  const full = workingPath(path)
  if (full) await openPathInTab({ path: full })
}

/**
 * Stage resolved conflicts. Editing the markers out of the working tree does
 * not touch the index — git keeps reporting the path as unmerged until it is
 * added — so this is what actually ends a conflict, and what re-enables the
 * stopped operation's "continue" (#222).
 *
 * Staging a file that still has markers in it is how they end up committed, so
 * the ones that do get named and confirmed first.
 */
async function markResolved(paths: string[]) {
  const shell = projectStore.currentProject?.shell
  if (!shell) return
  const contents = await Promise.all(
    paths.map((path) => {
      // 読めなかったものは空扱い＝マーカー無しとみなす（catch と同じ判断）。
      const full = workingPath(path)
      if (!full) return ''
      return fsReadFile(shell, full)
        .then((file) => file.content)
        .catch(() => '')
    }),
  )
  const unresolved = paths.filter((_, i) => /^<{7}(\s|$)/m.test(contents[i]))
  if (unresolved.length && !(await confirmDialog(t('git.stageWithMarkers', { paths: unresolved.join('\n') })))) {
    return
  }
  await gitStore.stageFiles(paths)
}

async function toggleCommitExpand(hash: string) {
  if (expandedCommits.value.has(hash)) {
    expandedCommits.value.delete(hash)
    delete commitFiles.value[hash]
    return
  }
  expandedCommits.value.add(hash)
  if (!commitFiles.value[hash]) {
    const project = projectStore.currentProject
    if (!project) return
    try {
      commitFiles.value[hash] = await gitShowFiles(projectStore.activeRoot, project.shell, hash)
    } catch {
      commitFiles.value[hash] = []
    }
  }
}

async function openCommitDiffTab(hash: string, path: string) {
  const project = projectStore.currentProject
  if (!project) return
  const diff = await gitDiffCommit(projectStore.activeRoot, project.shell, hash, path)
  tabStore.addDiffTab({ filePath: path, diff, commitHash: hash })
}

const hoveredCommit = ref<GitLogEntry | null>(null)
const {
  style: tooltipStyle,
  placeNear: placeTooltip,
  reset: resetTooltip,
} = useAnchoredPopup(useTemplateRef<HTMLElement>('tooltipEl'))
let tooltipTimer: ReturnType<typeof setTimeout> | null = null

function onCommitEnter(entry: GitLogEntry, e: MouseEvent) {
  if (tooltipTimer) clearTimeout(tooltipTimer)
  const target = e.currentTarget as HTMLElement
  tooltipTimer = setTimeout(async () => {
    resetTooltip()
    hoveredCommit.value = entry
    await placeTooltip(target.getBoundingClientRect())
  }, 400)
}

function onCommitLeave() {
  if (tooltipTimer) clearTimeout(tooltipTimer)
  tooltipTimer = null
  hoveredCommit.value = null
  resetTooltip()
}

const commitCtx = ref<{ entry: GitLogEntry } | null>(null)
const {
  style: commitCtxStyle,
  placeAt: placeCommitCtx,
  reset: resetCommitCtx,
} = useAnchoredPopup(useTemplateRef<HTMLElement>('commitCtxEl'))
const commitLink = computed(() =>
  commitCtx.value ? buildCommitLink(gitStore.remoteUrl, commitCtx.value.entry.hash) : null,
)

async function onCommitContext(e: MouseEvent, entry: GitLogEntry) {
  e.preventDefault()
  e.stopPropagation()
  // 同じメニューを開きっぱなしで右クリックされた場合に古い listener が残らないよう先に外す
  window.removeEventListener('mousedown', closeCommitCtx)
  resetCommitCtx()
  commitCtx.value = { entry }
  await placeCommitCtx({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', closeCommitCtx, { once: true })
}

function closeCommitCtx() {
  commitCtx.value = null
  resetCommitCtx()
  window.removeEventListener('mousedown', closeCommitCtx)
}

async function ctxCopyHash() {
  if (!commitCtx.value) return
  await navigator.clipboard.writeText(commitCtx.value.entry.hash)
  closeCommitCtx()
}

async function ctxCopyShortHash() {
  if (!commitCtx.value) return
  await navigator.clipboard.writeText(commitCtx.value.entry.hash.slice(0, 7))
  closeCommitCtx()
}

async function ctxCopyMessage() {
  if (!commitCtx.value) return
  await navigator.clipboard.writeText(commitCtx.value.entry.message)
  closeCommitCtx()
}

async function ctxCreateBranch() {
  if (!commitCtx.value) return
  const entry = commitCtx.value.entry
  closeCommitCtx()
  const project = projectStore.currentProject
  if (!project) return
  const name = await promptDialog(t('git.createBranchPrompt', { hash: entry.hash.slice(0, 7) }), '', 'feature/...')
  if (!name) return
  try {
    await gitCreateBranch(projectStore.activeRoot, project.shell, name.trim(), entry.hash)
    await gitStore.refreshLog()
  } catch (e) {
    await infoDialog(t('git.createBranchFailed', { error: String(e) }))
  }
}

async function ctxOpenOnRemote() {
  const link = commitLink.value
  closeCommitCtx()
  if (link) await openUrlWithConfirm(link.url)
}

// File context menu (shared between CHANGES, CONFLICTS and COMMITS)
/**
 * ファイルの右クリックメニュー。**行が持っている値をそのまま覚える**（分解して写さない）。
 *
 * 1 枚のメニューを 4 か所で共有するので、どこから開いたかを `section` で持ち、**出せない項目は
 * 無効化ではなく出さない**（他のメニューと同じ流儀）。
 *
 * **操作の実体は行のホバーボタンと同じ関数を呼ぶこと。** untracked の破棄が `git checkout` では
 * なくファイル削除になること、ステージ済みの新規追加を外すときの確認、リネームの両方の名前を
 * 外すこと（#306）は、どれも `discardFile` / `unstageFile` が持っている分岐で、メニュー側で
 * 書き直すと同じ分岐が 2 か所に散る。
 */
/**
 * **`hash` は `commit` の腕にしか生やさない。** 素の `hash?: string` にすると
 * 「コミット配下の行か」の答えが `section === 'commit'` と `hash != null` の 2 通りになり、
 * 読む場所ごとにどちらを見るかが割れる（実際にテンプレートは前者、ハンドラは後者を見ていた）。
 * 判別共用体なら narrowing で `hash` が必ず取れるので、どこでも `section` だけを見れば済む。
 */
type FileCtx =
  | { section: 'staged' | 'unstaged' | 'conflict'; file: GitFileChange }
  | { section: 'commit'; file: GitFileChange; hash: string }
const fileCtx = ref<FileCtx | null>(null)
const {
  style: fileCtxStyle,
  placeAt: placeFileCtx,
  reset: resetFileCtx,
} = useAnchoredPopup(useTemplateRef<HTMLElement>('fileCtxEl'))

// 文脈は行が組み立てて渡す。ここで `section` と `hash` を別々に受けると、`commit` 以外に
// hash を渡す呼び出しが型で弾けない（それを弾くための判別共用体なので、入口も同じ形にする）。
async function onFileContext(e: MouseEvent, ctx: FileCtx) {
  e.preventDefault()
  e.stopPropagation()
  window.removeEventListener('mousedown', closeFileCtx)
  resetFileCtx()
  fileCtx.value = ctx
  await placeFileCtx({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', closeFileCtx, { once: true })
}

function closeFileCtx() {
  fileCtx.value = null
  resetFileCtx()
  window.removeEventListener('mousedown', closeFileCtx)
}

/**
 * 選ばれた項目の対象を取り出して、メニューを閉じる。**確認ダイアログを挟む項目があるので、
 * 実行より先に閉じる**（開いたままだとダイアログの裏にメニューが残る）。
 */
function takeFileCtx() {
  const ctx = fileCtx.value
  closeFileCtx()
  return ctx
}

async function ctxOpenDiff() {
  const ctx = takeFileCtx()
  if (!ctx) return
  if (ctx.section === 'commit') await openCommitDiffTab(ctx.hash, ctx.file.path)
  else await openDiffTab(ctx.file, ctx.section === 'staged')
}

async function ctxOpenFile() {
  const ctx = takeFileCtx()
  if (!ctx) return
  if (ctx.section === 'commit') await openRevision(ctx.file.path, ctx.hash)
  else await openWorkingFile(ctx.file.path)
}

async function ctxStage() {
  const ctx = takeFileCtx()
  if (ctx) await gitStore.stageFiles([ctx.file.path])
}

async function ctxUnstage() {
  const ctx = takeFileCtx()
  if (ctx) await unstageFile(ctx.file)
}

async function ctxDiscard() {
  const ctx = takeFileCtx()
  if (ctx) await discardFile(ctx.file)
}

async function ctxResolve() {
  const ctx = takeFileCtx()
  if (ctx) await markResolved([ctx.file.path])
}

function ctxOpenHistory() {
  const ctx = takeFileCtx()
  // HistoryTab はルート相対パスを受ける（git が返すものがそのまま使える）。
  if (ctx) tabStore.addHistoryTab({ filePath: ctx.file.path })
}

async function ctxCopyPath() {
  const ctx = takeFileCtx()
  const full = ctx && workingPath(ctx.file.path)
  if (full) await navigator.clipboard.writeText(full)
}

async function ctxCopyRelativePath() {
  const ctx = takeFileCtx()
  if (ctx) await navigator.clipboard.writeText(ctx.file.path)
}

/**
 * untracked なファイルを `.gitignore` に足す（#309）。1 行の作り方と重複の判定は
 * `lib/gitignore.ts` が正本で、ここに残るのは取得・書き込み・再読込。
 *
 * - **出すのは untracked の行だけ。** 追跡済みのファイルを書いても git は追跡をやめないので、
 *   出すと「押しても何も起きない項目」になる
 * - 書く先は **`activeRoot` 直下の `.gitignore`**。**リポジトリルートではない**ので、
 *   リポジトリのサブディレクトリをプロジェクトとして開いていれば、そのディレクトリの
 *   `.gitignore` に書く。git が返すパスも `-C <activeRoot>` からの相対なので、これで揃う。
 *   `.git/info/exclude` を採らないのは、あれが手元だけの除外で、コミットして共有する側とは
 *   用途が違うため
 * - 書いたら `refreshStatus`。git ストアは `fs_changed` を見ていないので、これが無いと
 *   一覧からその行が消えるまで次のポーリングを待つことになる
 */
async function ctxAddToGitignore() {
  const ctx = takeFileCtx()
  const shell = projectStore.currentProject?.shell
  const path = workingPath('.gitignore')
  if (!ctx || !shell || !path) return
  const entry = gitignoreEntry(ctx.file.path)
  try {
    const file = await fsReadFile(shell, path, undefined, { allowMissing: true })
    if (hasGitignoreEntry(file.content, entry)) {
      statusMessage.show({ text: t('git.gitignoreExists', { path: entry }) })
      return
    }
    await fsWriteFile(shell, path, appendGitignoreLine(file.content, entry), file.encoding)
    await gitStore.refreshStatus()
  } catch (e) {
    statusMessage.show({ text: t('git.gitignoreFailed', { error: String(e) }), variant: 'error' })
  }
}

/**
 * Open a file as it was at a commit. Binary revisions have to go through
 * base64: `gitShowFile` decodes stdout as text, so an image would land in the
 * editor as mojibake. Formats without a viewer are reported instead of shown.
 */
async function openRevision(path: string, hash: string) {
  const project = projectStore.currentProject
  if (!project) return
  const root = projectStore.activeRoot
  const revision = hash.slice(0, 7)

  const isPdf = extension(path) === 'pdf'
  if (isImageFile(path) || isPdf) {
    try {
      const base64 = await gitShowFileBase64(root, project.shell, hash, path)
      if (isPdf) {
        tabStore.addPdfTab({ path, revision, dataUrl: `data:application/pdf;base64,${base64}` })
      } else {
        tabStore.addPreviewTab({ path, revision, dataUrl: `data:${mimeType(path)};base64,${base64}` })
      }
    } catch (e) {
      statusMessage.show({ text: String(e), variant: 'error' })
    }
    return
  }

  const content = await gitShowFile(root, project.shell, hash, path)
  if (looksBinary(content)) {
    statusMessage.show({ text: t('git.binaryRevision', { name: basename(path) }) })
    return
  }
  tabStore.addEditorTab({
    path,
    readOnly: true,
    initialContent: content,
    titleSuffix: ` (${revision})`,
  })
}

/**
 * Whether text from `git show` is really binary. The command's stdout is
 * decoded lossily on the Rust side, so binary content arrives as NUL bytes and
 * replacement characters. A stray U+FFFD can occur in genuine text, so require
 * a few of them.
 */
function looksBinary(content: string): boolean {
  const head = content.slice(0, 8192)
  if (head.includes('\u0000')) return true
  return (head.match(/\uFFFD/g)?.length ?? 0) > 8
}

function refreshIfActive() {
  if (sidebar.activePanel === 'git' && projectStore.currentProject) {
    gitStore.refreshStatus()
    gitStore.refreshLog()
    gitStore.fetchInBackground()
  }
}

watch(() => sidebar.activePanel, refreshIfActive)
watch(
  () => projectStore.currentProject,
  () => {
    expandedCommits.value.clear()
    commitFiles.value = {}
    refreshIfActive()
  },
)

onMounted(refreshIfActive)
onUnmounted(() => {
  if (tooltipTimer) clearTimeout(tooltipTimer)
})
</script>

<template>
  <div class="git-panel" data-testid="git-panel">
    <template v-if="!projectStore.currentProject">
      <div class="empty">{{ t('git.noProject') }}</div>
    </template>

    <template v-else-if="!gitStore.isRepo">
      <div class="no-repo">
        <p class="no-repo-msg">{{ t('git.notRepo') }}</p>
        <button class="init-btn" :disabled="initializing" @click="onInit">
          {{ t('git.initRepo') }}
        </button>
      </div>
    </template>

    <!-- Only when there is no status to show: an error must not take the panel
         away from a stopped rebase, which is when it is needed most (#222). -->
    <template v-else-if="gitStore.error && !gitStore.status">
      <div class="empty">{{ gitStore.error }}</div>
    </template>

    <template v-else-if="gitStore.status">
      <div v-if="gitStore.error" class="error-strip" :title="gitStore.error">{{ gitStore.error }}</div>

      <!-- A rebase/merge/… git stopped in the middle of (#222) -->
      <!-- data-testid は E2E の撮影が待ち合わせに使う。 -->
      <div v-if="operation" class="op-banner" data-testid="git-operation">
        <div class="op-title">{{ operationTitle }}</div>
        <p class="no-repo-msg">{{ operationHint }}</p>
        <div v-if="operation.canContinue" class="op-actions">
          <button
            class="commit-btn"
            :disabled="continueBlocked"
            :title="continueBlocked ? t('git.opContinueBlocked') : ''"
            @click="gitStore.continueOperation()"
          >
            {{ continueLabel }}
          </button>
          <button class="op-btn" @click="gitStore.abortOperation()">{{ t('git.opAbort') }}</button>
        </div>
      </div>

      <!-- Commit -->
      <div class="commit-section">
        <textarea
          v-model="commitMsg"
          class="commit-input"
          placeholder="Commit message..."
          rows="2"
        ></textarea>
        <button
          class="commit-btn"
          :disabled="!commitMsg.trim() || !gitStore.status.staged.length"
          @click="onCommit"
        >{{ t('git.commit', { count: gitStore.status.staged.length }) }}</button>
        <div v-if="gitStore.status.ahead || gitStore.status.behind" class="sync-info">
          <span v-if="gitStore.status.ahead">{{ t('git.aheadInfo', { count: gitStore.status.ahead }) }}</span>
          <span v-if="gitStore.status.ahead && gitStore.status.behind"> · </span>
          <span v-if="gitStore.status.behind">{{ t('git.behindInfo', { count: gitStore.status.behind }) }}</span>
        </div>
      </div>

      <!-- Conflicts (unmerged paths) -->
      <div v-if="gitStore.status.conflicted.length" class="file-section">
        <div class="section-header">
          <span>{{ t('git.conflicts', { count: gitStore.status.conflicted.length }) }}</span>
          <button
            class="section-action"
            @click="markResolved(gitStore.status!.conflicted.map((f) => f.path))"
          >
            {{ t('git.resolveAll') }}
          </button>
        </div>
        <div
          v-for="file in gitStore.status.conflicted"
          :key="'c-' + file.path"
          class="file-item conflict"
          :class="{ 'active-file': isActiveFile(file.path) }"
          :title="t('git.openConflict')"
          @click="openWorkingFile(file.path)"
          @contextmenu="onFileContext($event, { section: 'conflict', file })"
        >
          <span class="row-icon row-icon-svg" v-html="fileIconSvg(file.path)"></span>
          <span class="file-status" :style="{ color: gitStatusColor(file.status) }">{{ file.status }}</span>
          <span class="file-path conflict-path" :title="file.path">{{ file.path }}</span>
          <button class="file-action" :title="t('git.resolve')" @click.stop="markResolved([file.path])">
            <Check :size="12" :stroke-width="2" />
          </button>
        </div>
      </div>

      <!-- Staged -->
      <div v-if="gitStore.status.staged.length" class="file-section">
        <div class="section-header">
          <span>{{ t('git.staged', { count: gitStore.status.staged.length }) }}</span>
          <button class="section-action" @click="gitStore.unstageFiles(gitStore.status!.staged)">
            {{ t('git.unstageAll') }}
          </button>
        </div>
        <div
          v-for="file in gitStore.status.staged"
          :key="'s-' + file.path"
          class="file-item"
          :class="{ 'active-file': isActiveFile(file.path) }"
          @click="openDiffTab(file, true)"
          @contextmenu="onFileContext($event, { section: 'staged', file })"
        >
          <span class="row-icon row-icon-svg" v-html="fileIconSvg(file.path)"></span>
          <span class="file-status" :style="{ color: gitStatusColor(file.status) }">{{ file.status }}</span>
          <span class="file-path" :title="file.path">{{ file.path }}</span>
          <button class="file-action" :title="t('git.unstage')" @click.stop="unstageFile(file)"><Minus :size="12" :stroke-width="2" /></button>
        </div>
      </div>

      <!-- Unstaged -->
      <div v-if="gitStore.status.unstaged.length" class="file-section">
        <div class="section-header">
          <span>{{ t('git.changes', { count: gitStore.status.unstaged.length }) }}</span>
          <button class="section-action" @click="gitStore.stageFiles(gitStore.status!.unstaged.map(f => f.path))">
            {{ t('git.stageAll') }}
          </button>
        </div>
        <div
          v-for="file in gitStore.status.unstaged"
          :key="'u-' + file.path"
          class="file-item"
          :class="{ 'active-file': isActiveFile(file.path) }"
          @click="openDiffTab(file, false)"
          @contextmenu="onFileContext($event, { section: 'unstaged', file })"
        >
          <span class="row-icon row-icon-svg" v-html="fileIconSvg(file.path)"></span>
          <span class="file-status" :style="{ color: gitStatusColor(file.status) }">{{ file.status }}</span>
          <span class="file-path" :title="file.path">{{ file.path }}</span>
          <button class="file-action discard" :title="t('git.discard')" @click.stop="discardFile(file)"><Undo2 :size="12" :stroke-width="2" /></button>
          <button class="file-action" :title="t('git.stage')" @click.stop="gitStore.stageFiles([file.path])"><Plus :size="12" :stroke-width="2" /></button>
        </div>
      </div>

      <!-- No changes -->
      <div v-if="!gitStore.status.staged.length && !gitStore.status.unstaged.length && !gitStore.status.conflicted.length" class="empty">
        {{ t('git.noChanges') }}
      </div>

      <!-- Commits -->
      <div class="file-section">
        <div class="section-header">
          <span>{{ t('git.recentCommits') }}</span>
          <div class="view-toggle">
            <button class="view-btn" :class="{ active: commitView === 'list' }" @click="switchToList">{{ t('git.listView') }}</button>
            <button class="view-btn" :class="{ active: commitView === 'graph' }" @click="switchToGraph">{{ t('git.graphView') }}</button>
          </div>
        </div>

        <!-- List view -->
        <template v-if="commitView === 'list'">
          <div v-for="entry in gitStore.logEntries" :key="entry.hash" class="commit-group">
            <div
              class="log-item"
              :class="{ unpushed: unpushedHashes.has(entry.hash) }"
              @click="toggleCommitExpand(entry.hash)"
              @contextmenu="onCommitContext($event, entry)"
              @mouseenter="onCommitEnter(entry, $event)"
              @mouseleave="onCommitLeave"
            >
              <span class="expand-icon"><ChevronDown v-if="expandedCommits.has(entry.hash)" :size="12" :stroke-width="2" /><ChevronRight v-else :size="12" :stroke-width="2" /></span>
              <ArrowUp v-if="unpushedHashes.has(entry.hash)" class="unpushed-icon" :size="12" :stroke-width="2.5" />
              <span class="log-message">{{ entry.message.split('\n')[0] }}</span>
              <span class="log-meta">{{ relativeDate(entry.date) }}</span>
            </div>
            <div v-if="expandedCommits.has(entry.hash)" class="commit-files">
              <div v-if="!commitFiles[entry.hash]" class="empty small">{{ t('common.loading') }}</div>
              <div
                v-else
                v-for="file in commitFiles[entry.hash]"
                :key="file.path"
                class="file-item indent"
                @click.stop="openCommitDiffTab(entry.hash, file.path)"
                @contextmenu="onFileContext($event, { section: 'commit', file, hash: entry.hash })"
              >
                <span class="row-icon row-icon-svg" v-html="fileIconSvg(file.path)"></span>
                <span class="file-status" :style="{ color: gitStatusColor(file.status) }">{{ file.status }}</span>
                <span class="file-path" :title="file.path">{{ file.path }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- Graph view -->
        <template v-if="commitView === 'graph'">
          <div class="graph-container">
            <div
              v-for="(row, i) in graphRows"
              :key="row.hash"
              class="graph-row"
              :class="{ unpushed: unpushedHashes.has(row.hash) }"
              @click="toggleCommitExpand(row.hash)"
              @contextmenu="gitStore.logEntries[i] && onCommitContext($event, gitStore.logEntries[i])"
              @mouseenter="gitStore.logEntries[i] && onCommitEnter(gitStore.logEntries[i], $event)"
              @mouseleave="onCommitLeave"
            >
              <svg class="graph-svg" :width="graphSvgWidth" :height="ROW_HEIGHT">
                <!-- Continuation lines -->
                <line
                  v-for="(line, li) in row.lines"
                  :key="'l' + li"
                  :x1="line.fromCol * LANE_WIDTH + LANE_WIDTH / 2"
                  :y1="0"
                  :x2="line.toCol * LANE_WIDTH + LANE_WIDTH / 2"
                  :y2="ROW_HEIGHT"
                  :stroke="line.color"
                  stroke-width="1.5"
                />
                <!-- This commit's own lane continuation (above dot) -->
                <line
                  :x1="row.column * LANE_WIDTH + LANE_WIDTH / 2"
                  :y1="0"
                  :x2="row.column * LANE_WIDTH + LANE_WIDTH / 2"
                  :y2="ROW_HEIGHT"
                  :stroke="row.color"
                  stroke-width="1.5"
                />
                <!-- Merge lines -->
                <line
                  v-for="(ml, mi) in row.mergeLines"
                  :key="'m' + mi"
                  :x1="ml.fromCol * LANE_WIDTH + LANE_WIDTH / 2"
                  :y1="ROW_HEIGHT / 2"
                  :x2="ml.toCol * LANE_WIDTH + LANE_WIDTH / 2"
                  :y2="ROW_HEIGHT"
                  :stroke="ml.color"
                  stroke-width="1.5"
                />
                <!-- Commit dot -->
                <circle
                  :cx="row.column * LANE_WIDTH + LANE_WIDTH / 2"
                  :cy="ROW_HEIGHT / 2"
                  :r="row.isMerge ? DOT_RADIUS + 1 : DOT_RADIUS"
                  :fill="row.color"
                  :stroke="unpushedHashes.has(row.hash) ? 'var(--text-active)' : 'none'"
                  :stroke-width="unpushedHashes.has(row.hash) ? 1.5 : 0"
                />
              </svg>
              <div class="graph-info">
                <ArrowUp v-if="unpushedHashes.has(row.hash)" class="unpushed-icon" :size="12" :stroke-width="2.5" />
                <span v-if="row.refs" class="graph-refs">{{ row.refs }}</span>
                <span class="graph-message">{{ gitStore.logEntries[i]?.message.split('\n')[0] }}</span>
                <span class="graph-meta">{{ relativeDate(gitStore.logEntries[i]?.date ?? '') }}</span>
              </div>
            </div>
          </div>
        </template>

        <div v-if="!gitStore.logEntries.length" class="empty">{{ t('git.noCommits') }}</div>
      </div>
    </template>

    <template v-else>
      <div class="empty">{{ t('common.loading') }}</div>
    </template>

    <!-- Commit tooltip -->
    <Teleport to="body">
      <div
        v-if="hoveredCommit"
        ref="tooltipEl"
        class="commit-tooltip popup-surface"
        :style="tooltipStyle"
      >
        <div class="tooltip-meta">{{ hoveredCommit.hash.slice(0, 10) }}</div>
        <div class="tooltip-meta">{{ hoveredCommit.author }} &middot; {{ hoveredCommit.date }}</div>
        <div class="tooltip-message">{{ hoveredCommit.message }}</div>
      </div>
    </Teleport>

    <!-- File context menu (CHANGES + CONFLICTS + COMMITS) -->
    <Teleport to="body">
      <div
        v-if="fileCtx"
        ref="fileCtxEl"
        class="commit-file-ctx popup-surface"
        :style="fileCtxStyle"
        @mousedown.stop
      >
        <!-- コンフリクト中のパスに `git diff` を撃つと combined diff が返り、diff タブの
             パーサが読めない。解消はエディタでやるものなので、開く先はファイルだけにする。 -->
        <button v-if="fileCtx.section !== 'conflict'" @click="ctxOpenDiff">{{ t('git.openDiff') }}</button>
        <button @click="ctxOpenFile">{{ t('git.openFile') }}</button>
        <!-- index を動かす操作。コミット配下の行では成立しないので、この節ごと出さない。 -->
        <template v-if="fileCtx.section !== 'commit'">
          <div class="ctx-separator" />
          <button v-if="fileCtx.section === 'conflict'" @click="ctxResolve">{{ t('git.resolve') }}</button>
          <button v-else-if="fileCtx.section === 'staged'" @click="ctxUnstage">{{ t('git.unstage') }}</button>
          <template v-else>
            <button @click="ctxStage">{{ t('git.stage') }}</button>
            <button @click="ctxDiscard">{{ t('git.discard') }}</button>
            <button v-if="fileCtx.file.status === '?'" @click="ctxAddToGitignore">{{ t('git.addToGitignore') }}</button>
          </template>
        </template>
        <div class="ctx-separator" />
        <!-- コンフリクト中のファイルは、まず解消するもの。履歴は解消後に落ち着いて見ればよい。 -->
        <button v-if="fileCtx.section !== 'conflict'" @click="ctxOpenHistory">{{ t('git.gitHistory') }}</button>
        <button @click="ctxCopyPath">{{ t('git.copyPath') }}</button>
        <button @click="ctxCopyRelativePath">{{ t('git.copyRelativePath') }}</button>
      </div>
    </Teleport>

    <!-- Commit context menu -->
    <Teleport to="body">
      <div
        v-if="commitCtx"
        ref="commitCtxEl"
        class="commit-file-ctx popup-surface"
        :style="commitCtxStyle"
        @mousedown.stop
      >
        <button @click="ctxCopyHash">{{ t('git.copyHash') }}</button>
        <button @click="ctxCopyShortHash">{{ t('git.copyShortHash') }}</button>
        <button @click="ctxCopyMessage">{{ t('git.copyMessage') }}</button>
        <div class="ctx-separator" />
        <button @click="ctxCreateBranch">{{ t('git.createBranchFromCommit') }}</button>
        <template v-if="commitLink">
          <div class="ctx-separator" />
          <button @click="ctxOpenOnRemote">{{ t('git.openOnProvider', { provider: commitLink.label }) }}</button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.git-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.commit-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.commit-input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  border-radius: 3px;
  outline: none;
  resize: vertical;
  min-height: 36px;
}

.commit-input:focus {
  border-color: var(--accent);
}

.commit-btn {
  padding: 5px 8px;
  border: none;
  background: var(--accent);
  color: var(--text-active);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.commit-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.sync-info {
  font-size: 11px;
  color: var(--text-secondary);
  text-align: center;
  padding: 2px 0;
}

/* A git error alongside a usable status: a strip, never the whole panel (#222). */
.error-strip {
  padding: 4px 8px;
  border-left: 2px solid var(--danger);
  background: var(--bg-tertiary);
  color: var(--danger);
  font-size: 11px;
  max-height: 4.5em;
  overflow: hidden;
  white-space: pre-wrap;
}

.op-banner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 6px;
  padding: 8px;
  border-left: 2px solid var(--git-modify);
  background: var(--bg-tertiary);
}

.op-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.op-actions {
  display: flex;
  gap: 6px;
}

/* The secondary half of the pair; the primary one reuses `.commit-btn`. */
.op-btn {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11px;
  cursor: pointer;
}

.op-btn:hover {
  filter: brightness(1.15);
}

.file-section {
  display: flex;
  flex-direction: column;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-secondary);
}

.section-action {
  padding: 1px 6px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  border-radius: 2px;
}

.section-action:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.file-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}

.file-item:hover {
  background: var(--tab-hover-bg);
}

/* 印そのものは theme.css の `.active-file`。この 2 行はカスケードのために要る（scoped の
   `:hover` のほうが詳細度が高く、共有クラスの塗りを上書きしてしまう）。 */
.file-item.active-file,
.file-item.active-file:hover {
  background: var(--active-file-bg);
}


.file-item.indent {
  padding-left: 20px;
}

.file-status {
  font-family: monospace;
  font-size: 11px;
  font-weight: 600;
  width: 12px;
  text-align: center;
  flex-shrink: 0;
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.file-path.conflict-path {
  color: var(--danger);
  font-weight: 600;
}

.file-action {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  flex-shrink: 0;
}

.file-item:hover .file-action {
  opacity: 1;
}

.file-action:hover {
  background: var(--accent);
  color: var(--text-active);
}

.file-action.discard:hover {
  background: var(--git-deleted, #f44747);
  color: #fff;
}

.commit-group {
  display: flex;
  flex-direction: column;
}

.log-item {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 3px 4px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.log-item:hover {
  background: var(--tab-hover-bg);
}

.log-item.unpushed {
  border-left: 2px solid var(--accent);
  padding-left: 2px;
}

.unpushed-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.expand-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.log-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.log-meta {
  font-size: 10px;
  color: var(--text-secondary);
  flex-shrink: 0;
  white-space: nowrap;
}

.commit-files {
  display: flex;
  flex-direction: column;
}

.view-toggle {
  display: flex;
  gap: 2px;
}

.view-btn {
  padding: 1px 6px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 10px;
  cursor: pointer;
  border-radius: 2px;
}

.view-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.view-btn.active {
  background: var(--accent);
  color: var(--text-active);
}

.graph-container {
  display: flex;
  flex-direction: column;
}

.graph-row {
  display: flex;
  align-items: center;
  height: 24px;
  cursor: pointer;
  border-radius: 3px;
}

.graph-row:hover {
  background: var(--tab-hover-bg);
}

.graph-row.unpushed {
  border-left: 2px solid var(--accent);
}

.graph-svg {
  flex-shrink: 0;
}

.graph-info {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding-right: 4px;
}

.graph-refs {
  font-size: 10px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--accent);
  color: var(--text-active);
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.graph-message {
  font-size: 12px;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-meta {
  font-size: 10px;
  color: var(--text-secondary);
  flex-shrink: 0;
  white-space: nowrap;
}

.empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
}

.no-repo {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 8px;
  align-items: stretch;
}

.no-repo-msg {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}

.init-btn {
  padding: 6px 8px;
  border: none;
  background: var(--accent);
  color: var(--text-active);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.init-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.init-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.empty.small {
  padding: 4px 0;
  font-size: 11px;
}

</style>

<style>
.commit-tooltip {
  position: fixed;
  z-index: 2000;
  max-width: 420px;
  /* A commit message can be longer than the window is tall; the placement keeps
     the top on screen and this drops the tail (the tooltip can't scroll — it is
     pointer-events: none). */
  max-height: calc(100vh - 2 * 8px);
  overflow: hidden;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  white-space: pre-wrap;
  word-break: break-word;
}

.tooltip-meta {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.tooltip-message {
  font-size: 12px;
  color: var(--text-active);
  margin-top: 4px;
  line-height: 1.5;
}

.commit-file-ctx {
  position: fixed;
  z-index: 2000;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 140px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.commit-file-ctx button {
  display: block;
  width: 100%;
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.commit-file-ctx button:hover {
  background: var(--accent);
  color: var(--text-active);
}

.commit-file-ctx .ctx-separator {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}
</style>
