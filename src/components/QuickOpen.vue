<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import { basename } from '../lib/paths'
import { gitBranchList, gitCheckout, listProjectFiles } from '../lib/tauri'
import { useGitStore } from '../stores/git'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
import { useTaskStore } from '../stores/tasks'

const { t } = useI18n()
const projectStore = useProjectStore()
const tabStore = useTabStore()
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
const HELP_ITEMS = [
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
let lastProjectId: string | null = null

const recentFiles: string[] = []
const MAX_RECENT = 20

function trackRecent(path: string) {
  const idx = recentFiles.indexOf(path)
  if (idx !== -1) recentFiles.splice(idx, 1)
  recentFiles.unshift(path)
  if (recentFiles.length > MAX_RECENT) recentFiles.pop()
}

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

function fuzzyMatch(text: string, pattern: string): boolean {
  let pi = 0
  for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
    if (text[ti] === pattern[pi]) pi++
  }
  return pi === pattern.length
}

const MAX_DISPLAY = 100

const filteredFiles = computed(() => {
  if (mode.value !== 'file') return []
  const p = parsedQuery.value.pattern.toLowerCase()
  const sep = files.value.length > 0 && files.value[0].includes('/') ? '/' : '\\'

  if (!p) {
    const recent = recentFiles.filter((r) => files.value.includes(r)).slice(0, MAX_DISPLAY)
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
  const recentSet = new Set(recentFiles)
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

// --- Task mode ---
const filteredTasks = computed(() => {
  if (mode.value !== 'task') return []
  const q = query.value.slice(1).trim().toLowerCase()
  const all = taskStore.allTasks
  if (!q) return all
  return all.filter((t) => t.name.toLowerCase().includes(q) || t.command.toLowerCase().includes(q))
})

// --- Tab mode ---
const filteredTabs = computed(() => {
  if (mode.value !== 'tab') return []
  const q = query.value.slice(1).trim().toLowerCase()
  const tabs = tabStore.tabs
  if (!q) return tabs
  return tabs.filter((t) => t.title.toLowerCase().includes(q))
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
      return filteredTasks.value.length
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
  if (project.id === lastProjectId && files.value.length > 0) return
  loading.value = true
  try {
    files.value = await listProjectFiles(project.shell, project.root)
    lastProjectId = project.id
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
    branches.value = await gitBranchList(project.root, project.shell)
  } catch {
    branches.value = []
  }
}

// --- Display helpers ---
function getDisplayPath(fullPath: string): string {
  const root = projectStore.currentProject?.root ?? ''
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
      trackRecent(path)
      tabStore.addEditorTab({ path, initialLine: parsedQuery.value.line })
      break
    }
    case 'task': {
      const task = filteredTasks.value[selectedIdx.value]
      if (!task) return
      taskStore.runTask(task)
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
      gitCheckout(project.root, project.shell, branch)
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
    lastProjectId = null
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
    <div v-if="projectStore.showQuickOpen" class="quickopen-overlay" @mousedown.self="projectStore.showQuickOpen = false">
      <div class="quickopen">
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

            <!-- Task mode -->
            <template v-else-if="mode === 'task'">
              <div
                v-for="(task, i) in filteredTasks"
                :key="`${task.runner}:${task.name}`"
                class="quickopen-item"
                :class="{ selected: i === selectedIdx }"
                @click="selectedIdx = i; openSelected()"
                @mouseenter="selectedIdx = i"
              >
                <span class="item-runner">{{ task.runner }}</span>
                <span class="item-name">{{ task.name }}</span>
                <span class="item-path">{{ task.command }}</span>
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
                <span class="item-name">{{ tab.title }}</span>
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
