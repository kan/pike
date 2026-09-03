<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useAppActions } from '../composables/useAppActions'
import { usePanelAvailability } from '../composables/usePanelAvailability'
import { useI18n } from '../i18n'
import { openPathInTab } from '../lib/openFile'
import { basename, fuzzyMatch } from '../lib/paths'
import { paletteActions } from '../lib/shortcuts'
import { tabDisplayTitle } from '../lib/tabTitle'
import { gitBranchList, gitCheckout, listProjectFiles } from '../lib/tauri'
import { useGitStore } from '../stores/git'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
import { useTaskStore } from '../stores/tasks'
import type { TaskRunner } from '../types/tasks'

const { t } = useI18n()
const projectStore = useProjectStore()
const { isPanelAvailable } = usePanelAvailability()
const tabStore = useTabStore()
const appActions = useAppActions()
const taskStore = useTaskStore()
const gitStore = useGitStore()

// --- Mode detection ---
type QuickOpenMode = 'file' | 'task' | 'tab' | 'line' | 'branch' | 'help'

const mode = computed<QuickOpenMode>(() => {
  const q = query.value
  if (q.startsWith('>')) return 'task'
  if (q.startsWith('@')) return 'tab'
  if (q.startsWith(':')) return 'line'
  if (q.startsWith('!')) return 'branch'
  if (q === '?') return 'help'
  return 'file'
})

const query = ref('')
const selectedIdx = ref(0)
const inputRef = ref<HTMLInputElement>()

// --- Help items ---
const HELP_ITEMS: { prefix: string; description: string; action?: 'manual' }[] = [
  { prefix: 'F1', description: 'quickOpen.helpManual', action: 'manual' },
  { prefix: '', description: 'quickOpen.helpFile' },
  { prefix: '>', description: 'quickOpen.helpTask' },
  { prefix: '@', description: 'quickOpen.helpTab' },
  { prefix: ':', description: 'quickOpen.helpLine' },
  { prefix: '!', description: 'quickOpen.helpBranch' },
  { prefix: '?', description: 'quickOpen.helpHelp' },
]

// --- File mode ---
const files = ref<string[]>([])
const loading = ref(false)
let lastFilesRoot: string | null = null

const parsedQuery = computed(() => {
  const raw = query.value
  const colonIdx = raw.lastIndexOf(':')
  if (colonIdx > 0) {
    const afterColon = raw.slice(colonIdx + 1)
    const lineNum = parseInt(afterColon, 10)
    if (!Number.isNaN(lineNum) && lineNum > 0) {
      return { pattern: raw.slice(0, colonIdx), line: lineNum }
    }
  }
  return { pattern: raw, line: undefined }
})

const MAX_DISPLAY = 100

const filteredFiles = computed(() => {
  if (mode.value !== 'file') return []
  const p = parsedQuery.value.pattern.toLowerCase()
  const sep = files.value.length > 0 && files.value[0].includes('/') ? '/' : '\\'

  if (!p) {
    const recent = projectStore.recentFiles.filter((r) => files.value.includes(r)).slice(0, MAX_DISPLAY)
    if (recent.length >= MAX_DISPLAY) return recent
    const recentSet = new Set(recent)
    const rest = files.value.filter((f) => !recentSet.has(f))
    return [...recent, ...rest].slice(0, MAX_DISPLAY)
  }

  const basenameMatches: string[] = []
  const pathMatches: string[] = []
  for (const f of files.value) {
    if (basenameMatches.length + pathMatches.length >= MAX_DISPLAY) break
    const name = f.split(sep).pop()?.toLowerCase() ?? ''
    if (fuzzyMatch(name, p)) {
      basenameMatches.push(f)
    } else if (fuzzyMatch(f.toLowerCase(), p)) {
      pathMatches.push(f)
    }
  }
  const recentSet = new Set(projectStore.recentFiles)
  const sortByRecent = (a: string, b: string) => {
    const aRecent = recentSet.has(a)
    const bRecent = recentSet.has(b)
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return 0
  }
  basenameMatches.sort(sortByRecent)
  pathMatches.sort(sortByRecent)
  return [...basenameMatches, ...pathMatches].slice(0, MAX_DISPLAY)
})

// --- Task mode (includes built-in commands + project tasks) ---
interface CommandItem {
  kind: 'command'
  id: string
  name: string
  /** 分類（`表示` `Git` など）。VSCode の `View:` と同じ役目。 */
  category: string
  /** 絞り込み用（日本語と英語の両方を含む）。 */
  search: string
  /** そのコマンドのキー（あれば右に出す）。 */
  chord: string
  action: () => void
}

interface TaskItem {
  kind: 'task'
  name: string
  command: string
  /** justfile の doc comment。あれば command の代わりに出し、絞り込みにも使う */
  description?: string
  runner: TaskRunner
  cwd?: string
  groupLabel: string
}

/** 最近開いたディレクトリ（#271）。コマンドと違い、中身はデータなので別の種別。 */
interface RecentDirItem {
  kind: 'recent-dir'
  path: string
}

type PaletteItem = CommandItem | TaskItem | RecentDirItem

/**
 * パレットに出すコマンド（#270）。**一覧は `lib/shortcuts.ts` の `APP_ACTIONS` が正本**で、
 * ここは表示に落とすだけ。以前はここに 3 件ハードコードしていたので、機能を足しても
 * パレットが増えなかった。
 */
const builtinCommands = computed<CommandItem[]>(() =>
  paletteActions()
    // プロジェクトを持たないウィンドウでは、git のように成立しないものを出さない。
    .filter((a) => !a.needsProject || !!projectStore.currentProject)
    // 条件付きのパネル（#278 の issue）は、サイドバーのアイコンと同じ答えを見る。
    // ここを素通しにすると、アイコンは隠れているのにパレットからは開けてしまう。
    .filter((a) => !a.panel || isPanelAvailable(a.panel))
    .map((a) => ({
      kind: 'command' as const,
      id: a.id,
      name: a.label,
      category: a.category,
      search: a.search,
      chord: a.chord,
      action: appActions[a.id],
    })),
)

const filteredPalette = computed<PaletteItem[]>(() => {
  if (mode.value !== 'task') return []
  const q = query.value.slice(1).trim().toLowerCase()

  // 中身は computed が作ったものをそのまま渡す（打鍵ごとに複製しない）。
  const cmds: PaletteItem[] = builtinCommands.value.filter((c) => !q || c.search.includes(q))

  const tasks: PaletteItem[] = taskStore.allTasks
    .filter(
      (t) =>
        !q ||
        t.name.toLowerCase().includes(q) ||
        t.command.toLowerCase().includes(q) ||
        (t.description?.toLowerCase().includes(q) ?? false),
    )
    .map((t) => ({
      kind: 'task' as const,
      name: t.name,
      command: t.command,
      description: t.description,
      runner: t.runner,
      cwd: t.cwd,
      groupLabel: t.groupLabel,
    }))

  // 最近開いたディレクトリ（#271）。**コマンドとタスクの間**に置く: 「開く」操作の
  // 続きなので、コマンドのすぐ下にあるほうが辿りやすい。
  const dirs: PaletteItem[] = projectStore.recentDirs
    .filter((p) => !q || p.toLowerCase().includes(q))
    .slice(0, MAX_RECENT_DIRS)
    .map((path) => ({ kind: 'recent-dir' as const, path }))

  return [...cmds, ...dirs, ...tasks]
})

/** パレットに出す最近のディレクトリの件数。一覧はタスクと共存するので絞る。 */
const MAX_RECENT_DIRS = 5

/** 行の識別子。種別ごとに衝突しない形にする。 */
function paletteKey(item: PaletteItem): string {
  if (item.kind === 'command') return `cmd:${item.id}`
  if (item.kind === 'recent-dir') return `dir:${item.path}`
  return `task:${item.cwd ?? ''}:${item.name}`
}

// --- Tab mode ---
const filteredTabs = computed(() => {
  if (mode.value !== 'tab') return []
  const q = query.value.slice(1).trim().toLowerCase()
  const tabs = tabStore.visibleTabs
  if (!q) return tabs
  return tabs.filter((tab) => tabDisplayTitle(tab).toLowerCase().includes(q))
})

// --- Branch mode ---
const branches = ref<string[]>([])

const filteredBranches = computed(() => {
  if (mode.value !== 'branch') return []
  const q = query.value.slice(1).trim().toLowerCase()
  if (!q) return branches.value
  return branches.value.filter((b) => b.toLowerCase().includes(q))
})

// --- Line mode ---
const lineNumber = computed(() => {
  if (mode.value !== 'line') return 0
  const n = parseInt(query.value.slice(1), 10)
  return Number.isNaN(n) ? 0 : n
})

// --- Unified item count ---
const itemCount = computed(() => {
  switch (mode.value) {
    case 'file':
      return filteredFiles.value.length
    case 'task':
      return filteredPalette.value.length
    case 'tab':
      return filteredTabs.value.length
    case 'branch':
      return filteredBranches.value.length
    case 'line':
      return lineNumber.value > 0 ? 1 : 0
    case 'help':
      return HELP_ITEMS.length
  }
})

// --- Data loading ---
async function loadFiles() {
  const project = projectStore.currentProject
  if (!project) return
  const root = projectStore.activeRoot
  if (root === lastFilesRoot && files.value.length > 0) return
  loading.value = true
  try {
    files.value = await listProjectFiles(project.shell, root)
    lastFilesRoot = root
  } catch {
    files.value = []
  } finally {
    loading.value = false
  }
}

async function loadBranches() {
  const project = projectStore.currentProject
  if (!project) return
  try {
    branches.value = (await gitBranchList(projectStore.activeRoot, project.shell)).local
  } catch {
    branches.value = []
  }
}

// --- Display helpers ---
function getDisplayPath(fullPath: string): string {
  const root = projectStore.activeRoot
  if (root && fullPath.startsWith(root)) {
    let rel = fullPath.slice(root.length)
    if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1)
    return rel
  }
  return fullPath
}

// --- Actions ---
function openSelected() {
  switch (mode.value) {
    case 'file': {
      const path = filteredFiles.value[selectedIdx.value]
      if (!path) return
      projectStore.trackRecentFile(path)
      void openPathInTab({ path, line: parsedQuery.value.line })
      break
    }
    case 'task': {
      const item = filteredPalette.value[selectedIdx.value]
      if (!item) return
      if (item.kind === 'command') {
        item.action()
      } else if (item.kind === 'recent-dir') {
        void projectStore.openDirectory(item.path)
      } else {
        taskStore.runTask(item)
      }
      break
    }
    case 'tab': {
      const tab = filteredTabs.value[selectedIdx.value]
      if (!tab) return
      tabStore.setActiveTab(tab.id)
      break
    }
    case 'branch': {
      const branch = filteredBranches.value[selectedIdx.value]
      if (!branch) return
      const project = projectStore.currentProject
      if (!project) return
      gitCheckout(projectStore.activeRoot, project.shell, branch)
        .then(() => gitStore.refreshStatus(true))
        .catch(() => {})
      break
    }
    case 'line': {
      if (lineNumber.value <= 0) return
      const active = tabStore.activeTab
      if (active?.kind === 'editor') {
        active.initialLine = lineNumber.value
      }
      break
    }
    case 'help': {
      const item = HELP_ITEMS[selectedIdx.value]
      if (item) {
        if (item.action === 'manual') {
          tabStore.addManualTab()
          break // close
        }
        query.value = item.prefix
        return // don't close
      }
      break
    }
  }
  projectStore.showQuickOpen = false
}

// --- Watchers ---
watch(query, () => {
  selectedIdx.value = 0
})

watch(
  () => projectStore.showQuickOpen,
  (show) => {
    if (show) {
      query.value = ''
      selectedIdx.value = 0
      loadFiles()
      if (taskStore.taskGroups.length === 0) taskStore.refresh()
      loadBranches()
      nextTick(() => inputRef.value?.focus())
    }
  },
)

watch(
  () => projectStore.currentProject?.id,
  () => {
    lastFilesRoot = null
    files.value = []
    branches.value = []
  },
)

// Load branches when entering branch mode
watch(mode, (m) => {
  if (m === 'branch' && branches.value.length === 0) loadBranches()
})

// --- Keyboard navigation ---
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    projectStore.showQuickOpen = false
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (selectedIdx.value < itemCount.value - 1) {
      selectedIdx.value++
      scrollToSelected()
    }
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (selectedIdx.value > 0) {
      selectedIdx.value--
      scrollToSelected()
    }
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    openSelected()
    return
  }
}

const listRef = ref<HTMLDivElement>()

function scrollToSelected() {
  nextTick(() => {
    const container = listRef.value
    if (!container) return
    const item = container.children[selectedIdx.value] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  })
}

// --- Footer hints ---
const footerHints = computed(() => {
  switch (mode.value) {
    case 'task':
      return { action: t('quickOpen.enterRun'), hint: t('quickOpen.taskHint') }
    case 'tab':
      return { action: t('quickOpen.enterSwitch'), hint: t('quickOpen.tabHint') }
    case 'line':
      return { action: t('quickOpen.enterJump'), hint: t('quickOpen.lineHint') }
    case 'branch':
      return { action: t('quickOpen.enterCheckout'), hint: t('quickOpen.branchHint') }
    case 'help':
      return { action: t('quickOpen.enterSelect'), hint: '' }
    default:
      return { action: t('quickOpen.enterOpen'), hint: t('quickOpen.prefixHint') }
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="projectStore.showQuickOpen" class="quickopen-overlay ui-zoom" @mousedown.self="projectStore.showQuickOpen = false">
      <div class="quickopen popup-surface" data-testid="quickopen">
        <input
          ref="inputRef"
          v-model="query"
          class="quickopen-input"
          :placeholder="t('quickOpen.placeholder')"
          @keydown="onKeyDown"
        />
        <div ref="listRef" class="quickopen-list">
          <div v-if="loading && mode === 'file'" class="quickopen-empty">{{ t('common.loading') }}</div>
          <template v-else>
            <!-- Help mode -->
            <template v-if="mode === 'help'">
              <div
                v-for="(item, i) in HELP_ITEMS"
                :key="item.prefix"
                class="quickopen-item"
                :class="{ selected: i === selectedIdx }"
                @click="selectedIdx = i; openSelected()"
                @mouseenter="selectedIdx = i"
              >
                <span class="item-prefix">{{ item.prefix || t('quickOpen.helpFilePrefix') }}</span>
                <span class="item-name">{{ t(item.description) }}</span>
              </div>
            </template>

            <!-- Task / Command mode -->
            <template v-else-if="mode === 'task'">
              <div
                v-for="(item, i) in filteredPalette"
                :key="paletteKey(item)"
                class="quickopen-item"
                :class="{ selected: i === selectedIdx }"
                @click="selectedIdx = i; openSelected()"
                @mouseenter="selectedIdx = i"
              >
                <template v-if="item.kind === 'command'">
                  <span class="item-runner">{{ item.category }}</span>
                  <span class="item-name">{{ item.name }}</span>
                  <span class="item-path item-chord">{{ item.chord }}</span>
                </template>
                <template v-else-if="item.kind === 'recent-dir'">
                  <span class="item-runner">{{ t('quickOpen.recentDir') }}</span>
                  <span class="item-name">{{ basename(item.path) }}</span>
                  <span class="item-path">{{ item.path }}</span>
                </template>
                <template v-else>
                  <span class="item-runner">{{ item.runner }}</span>
                  <span class="item-name">{{ item.name }}</span>
                  <span class="item-path">{{ item.groupLabel }} · {{ item.description ?? item.command }}</span>
                </template>
              </div>
            </template>

            <!-- Tab mode -->
            <template v-else-if="mode === 'tab'">
              <div
                v-for="(tab, i) in filteredTabs"
                :key="tab.id"
                class="quickopen-item"
                :class="{ selected: i === selectedIdx }"
                @click="selectedIdx = i; openSelected()"
                @mouseenter="selectedIdx = i"
              >
                <span class="item-runner">{{ tab.kind }}</span>
                <span class="item-name">{{ tabDisplayTitle(tab) }}</span>
              </div>
            </template>

            <!-- Branch mode -->
            <template v-else-if="mode === 'branch'">
              <div
                v-for="(branch, i) in filteredBranches"
                :key="branch"
                class="quickopen-item"
                :class="{ selected: i === selectedIdx }"
                @click="selectedIdx = i; openSelected()"
                @mouseenter="selectedIdx = i"
              >
                <span class="item-name">{{ branch }}</span>
                <span v-if="branch === gitStore.status?.branch" class="item-path">current</span>
              </div>
            </template>

            <!-- Line mode -->
            <template v-else-if="mode === 'line'">
              <div
                v-if="lineNumber > 0"
                class="quickopen-item"
                :class="{ selected: selectedIdx === 0 }"
                @click="openSelected()"
              >
                <span class="item-name">{{ t('quickOpen.goToLine', { line: lineNumber }) }}</span>
              </div>
            </template>

            <!-- File mode (default) -->
            <template v-else>
              <div
                v-for="(file, i) in filteredFiles"
                :key="file"
                class="quickopen-item"
                :class="{ selected: i === selectedIdx }"
                @click="selectedIdx = i; openSelected()"
                @mouseenter="selectedIdx = i"
              >
                <span class="item-name">{{ basename(file) }}</span>
                <span class="item-path">{{ getDisplayPath(file) }}</span>
              </div>
            </template>

            <div v-if="itemCount === 0 && query && mode !== 'help'" class="quickopen-empty">
              {{ t('quickOpen.noMatch') }}
            </div>
          </template>
        </div>
        <div class="quickopen-footer">
          <span class="hint">{{ footerHints.action }}</span>
          <span v-if="footerHints.hint" class="hint">{{ footerHints.hint }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.quickopen-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  padding-top: 80px;
}

.quickopen {
  width: 520px;
  max-height: 420px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-self: flex-start;
}

.quickopen-input {
  padding: 10px 14px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-active);
  font-size: 14px;
  outline: none;
}

.quickopen-input::placeholder {
  color: var(--text-secondary);
}

.quickopen-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.quickopen-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  cursor: pointer;
}

.quickopen-item.selected {
  background: var(--accent);
}

.item-prefix {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  min-width: 18px;
  text-align: center;
  flex-shrink: 0;
}

.quickopen-item.selected .item-prefix {
  color: var(--text-active);
}

.item-runner {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.item-name {
  font-size: 13px;
  color: var(--text-primary);
  flex-shrink: 0;
}

.quickopen-item.selected .item-name {
  color: var(--text-active);
}

.item-path {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* コマンドのキーは右端に。名前と説明の並びではなく「押せるキー」なので、
   等幅で他の行と桁を揃える。 */
.item-chord {
  margin-left: auto;
  padding-left: 8px;
  font-family: monospace;
  flex-shrink: 0;
}

.quickopen-item.selected .item-path {
  color: rgba(255, 255, 255, 0.7);
}

.quickopen-empty {
  padding: 16px 14px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}

.quickopen-footer {
  border-top: 1px solid var(--border);
  padding: 6px 14px;
  display: flex;
  gap: 16px;
}

.hint {
  font-size: 11px;
  color: var(--text-secondary);
}
</style>
