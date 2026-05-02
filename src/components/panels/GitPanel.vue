<script setup lang="ts">
import { ArrowUp, ChevronDown, ChevronRight, Minus, Plus, Undo2 } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { confirmDialog, infoDialog, promptDialog } from '../../composables/useConfirmDialog'
import { useI18n } from '../../i18n'
import { fileIconSvg } from '../../lib/fileIcons'
import { buildGraph, DOT_RADIUS, LANE_WIDTH, ROW_HEIGHT } from '../../lib/gitGraph'
import { buildCommitLink } from '../../lib/gitRemote'
import { gitStatusColor, relativeDate } from '../../lib/paths'
import {
  fsDelete,
  gitCreateBranch,
  gitDiff,
  gitDiffCommit,
  gitShowFile,
  gitShowFiles,
  openUrlWithConfirm,
} from '../../lib/tauri'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useSidebarStore } from '../../stores/sidebar'
import { useTabStore } from '../../stores/tabs'
import type { GitFileChange, GitLogEntry } from '../../types/git'

const { t } = useI18n()

const gitStore = useGitStore()
const projectStore = useProjectStore()
const tabStore = useTabStore()
const sidebar = useSidebarStore()

const commitMsg = ref('')
const commitView = ref<'list' | 'graph'>('list')

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
    const project = projectStore.currentProject
    if (!project) return
    const s = project.shell.kind === 'wsl' ? '/' : '\\'
    await fsDelete(project.shell, `${project.root}${s}${file.path}`)
    await gitStore.refreshStatus()
  } else {
    await gitStore.discardChanges([file.path])
  }
}

async function unstageFile(file: GitFileChange) {
  if (file.status === 'A') {
    if (!(await confirmDialog(t('git.unstageNewConfirm', { path: file.path })))) return
    const project = projectStore.currentProject
    if (project) {
      const sep = project.shell.kind === 'wsl' ? '/' : '\\'
      const fullPath = `${project.root}${sep}${file.path}`
      await gitStore.unstageFiles([file.path])
      await fsDelete(project.shell, fullPath).catch(() => {})
      await gitStore.refreshStatus()
    }
  } else {
    await gitStore.unstageFiles([file.path])
  }
}

async function openDiffTab(path: string, staged: boolean, untracked = false) {
  const project = projectStore.currentProject
  if (!project) return
  const diff = await gitDiff(project.root, project.shell, path, staged, untracked)
  tabStore.addDiffTab({ filePath: path, diff, staged })
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
      commitFiles.value[hash] = await gitShowFiles(project.root, project.shell, hash)
    } catch {
      commitFiles.value[hash] = []
    }
  }
}

async function openCommitDiffTab(hash: string, path: string) {
  const project = projectStore.currentProject
  if (!project) return
  const diff = await gitDiffCommit(project.root, project.shell, hash, path)
  tabStore.addDiffTab({ filePath: path, diff, commitHash: hash })
}

const hoveredCommit = ref<GitLogEntry | null>(null)
const tooltipPos = ref({ x: 0, y: 0 })
let tooltipTimer: ReturnType<typeof setTimeout> | null = null

function onCommitEnter(entry: GitLogEntry, e: MouseEvent) {
  if (tooltipTimer) clearTimeout(tooltipTimer)
  const target = e.currentTarget as HTMLElement
  tooltipTimer = setTimeout(() => {
    hoveredCommit.value = entry
    const rect = target.getBoundingClientRect()
    tooltipPos.value = { x: rect.left, y: rect.top - 4 }
  }, 400)
}

function onCommitLeave() {
  if (tooltipTimer) clearTimeout(tooltipTimer)
  tooltipTimer = null
  hoveredCommit.value = null
}

const commitCtx = ref<{ x: number; y: number; entry: GitLogEntry } | null>(null)
const commitLink = computed(() =>
  commitCtx.value ? buildCommitLink(gitStore.remoteUrl, commitCtx.value.entry.hash) : null,
)

function onCommitContext(e: MouseEvent, entry: GitLogEntry) {
  e.preventDefault()
  e.stopPropagation()
  // 同じメニューを開きっぱなしで右クリックされた場合に古い listener が残らないよう先に外す
  window.removeEventListener('mousedown', closeCommitCtx)
  commitCtx.value = { x: e.clientX, y: e.clientY, entry }
  nextTick(() => {
    window.addEventListener('mousedown', closeCommitCtx, { once: true })
  })
}

function closeCommitCtx() {
  commitCtx.value = null
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
    await gitCreateBranch(project.root, project.shell, name.trim(), entry.hash)
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

// File context menu (shared between CHANGES and COMMITS)
const fileCtx = ref<{
  x: number
  y: number
  path: string
  hash?: string
  staged?: boolean
  untracked?: boolean
} | null>(null)

function onFileContext(e: MouseEvent, path: string, opts: { hash?: string; staged?: boolean; untracked?: boolean }) {
  e.preventDefault()
  e.stopPropagation()
  window.removeEventListener('mousedown', closeFileCtx)
  fileCtx.value = { x: e.clientX, y: e.clientY, path, ...opts }
  nextTick(() => {
    window.addEventListener('mousedown', closeFileCtx, { once: true })
  })
}

function closeFileCtx() {
  fileCtx.value = null
  window.removeEventListener('mousedown', closeFileCtx)
}

async function ctxOpenDiff() {
  if (!fileCtx.value) return
  const { path, hash, staged, untracked } = fileCtx.value
  closeFileCtx()
  if (hash) {
    await openCommitDiffTab(hash, path)
  } else {
    await openDiffTab(path, staged ?? false, untracked ?? false)
  }
}

async function ctxOpenFile() {
  if (!fileCtx.value) return
  const { path, hash } = fileCtx.value
  closeFileCtx()
  if (hash) {
    const project = projectStore.currentProject
    if (!project) return
    const content = await gitShowFile(project.root, project.shell, hash, path)
    tabStore.addEditorTab({
      path,
      readOnly: true,
      initialContent: content,
      titleSuffix: ` (${hash.slice(0, 7)})`,
    })
  } else {
    const root = projectStore.currentProject?.root
    if (!root) return
    const sep = projectStore.currentProject?.shell?.kind === 'wsl' ? '/' : '\\'
    tabStore.addEditorTab({ path: root + sep + path })
  }
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
  <div class="git-panel">
    <template v-if="!projectStore.currentProject">
      <div class="empty">{{ t('git.noProject') }}</div>
    </template>

    <template v-else-if="gitStore.error">
      <div class="empty">{{ gitStore.error }}</div>
    </template>

    <template v-else-if="gitStore.status">
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

      <!-- Staged -->
      <div v-if="gitStore.status.staged.length" class="file-section">
        <div class="section-header">
          <span>{{ t('git.staged', { count: gitStore.status.staged.length }) }}</span>
          <button class="section-action" @click="gitStore.unstageFiles(gitStore.status!.staged.map(f => f.path))">
            {{ t('git.unstageAll') }}
          </button>
        </div>
        <div
          v-for="file in gitStore.status.staged"
          :key="'s-' + file.path"
          class="file-item"
          @click="openDiffTab(file.path, true)"
          @contextmenu="onFileContext($event, file.path, { staged: true })"
        >
          <span class="file-icon" v-html="fileIconSvg(file.path)"></span>
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
          @click="openDiffTab(file.path, false, file.status === '?')"
          @contextmenu="onFileContext($event, file.path, { staged: false, untracked: file.status === '?' })"
        >
          <span class="file-icon" v-html="fileIconSvg(file.path)"></span>
          <span class="file-status" :style="{ color: gitStatusColor(file.status) }">{{ file.status }}</span>
          <span class="file-path" :title="file.path">{{ file.path }}</span>
          <button class="file-action discard" :title="t('git.discard')" @click.stop="discardFile(file)"><Undo2 :size="12" :stroke-width="2" /></button>
          <button class="file-action" :title="t('git.stage')" @click.stop="gitStore.stageFiles([file.path])"><Plus :size="12" :stroke-width="2" /></button>
        </div>
      </div>

      <!-- No changes -->
      <div v-if="!gitStore.status.staged.length && !gitStore.status.unstaged.length" class="empty">
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
                @contextmenu="onFileContext($event, file.path, { hash: entry.hash })"
              >
                <span class="file-icon" v-html="fileIconSvg(file.path)"></span>
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
        class="commit-tooltip"
        :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }"
      >
        <div class="tooltip-meta">{{ hoveredCommit.hash.slice(0, 10) }}</div>
        <div class="tooltip-meta">{{ hoveredCommit.author }} &middot; {{ hoveredCommit.date }}</div>
        <div class="tooltip-message">{{ hoveredCommit.message }}</div>
      </div>
    </Teleport>

    <!-- File context menu (CHANGES + COMMITS) -->
    <Teleport to="body">
      <div
        v-if="fileCtx"
        class="commit-file-ctx"
        :style="{ left: fileCtx.x + 'px', top: fileCtx.y + 'px' }"
        @mousedown.stop
      >
        <button @click="ctxOpenDiff">{{ t('git.openDiff') }}</button>
        <button @click="ctxOpenFile">{{ t('git.openFile') }}</button>
      </div>
    </Teleport>

    <!-- Commit context menu -->
    <Teleport to="body">
      <div
        v-if="commitCtx"
        class="commit-file-ctx"
        :style="{ left: commitCtx.x + 'px', top: commitCtx.y + 'px' }"
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

.file-item.indent {
  padding-left: 20px;
}

.file-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.file-icon :deep(svg) {
  width: 16px;
  height: 16px;
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

.empty.small {
  padding: 4px 0;
  font-size: 11px;
}

</style>

<style>
.commit-tooltip {
  position: fixed;
  z-index: 2000;
  transform: translateY(-100%);
  max-width: 420px;
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
