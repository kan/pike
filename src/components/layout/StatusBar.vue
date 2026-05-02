<script setup lang="ts">
import { Cpu, FolderOpen, GitBranch, Github, Gitlab } from 'lucide-vue-next'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useEditorInfo } from '../../composables/useEditorInfo'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'
import { formatCost, formatTokens } from '../../lib/format'
import { buildRepoLink } from '../../lib/gitRemote'
import { openUrlWithConfirm } from '../../lib/tauri'
import { useAgentStore } from '../../stores/agent'
import { useClaudeUsageStore } from '../../stores/claudeUsage'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'

const { t } = useI18n()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()

function toggleLanguage() {
  settingsStore.language = settingsStore.language === 'en' ? 'ja' : 'en'
}
const gitStore = useGitStore()
const editorInfo = useEditorInfo()
const updater = useUpdater()
const claudeUsageStore = useClaudeUsageStore()
const agentStore = useAgentStore()
const tabStore = useTabStore()

const codexSession = computed(() => {
  const tab = tabStore.activeTab
  if (!tab || tab.kind !== 'agent-chat' || tab.agentType !== 'codex') return null
  const s = agentStore.getExistingSession(tab.id)
  return s?.tokenUsage ? s : null
})

const showClaudeUsage = ref(false)

function toggleClaudeUsage() {
  showClaudeUsage.value = !showClaudeUsage.value
  if (showClaudeUsage.value) {
    nextTick(() => window.addEventListener('mousedown', closeClaudeUsage, { once: true }))
  }
}

function closeClaudeUsage() {
  showClaudeUsage.value = false
}

declare const __GIT_COMMIT_HASH__: string
const devHash = import.meta.env.DEV && __GIT_COMMIT_HASH__ ? `-${__GIT_COMMIT_HASH__}` : ''

const repoLink = computed(() => buildRepoLink(gitStore.remoteUrl))
const repoIcon = computed(() => {
  switch (repoLink.value?.provider) {
    case 'github':
      return Github
    case 'gitlab':
      return Gitlab
    // bitbucket / codeberg は lucide に専用アイコンが無いため汎用 Git アイコンで代用
    default:
      return GitBranch
  }
})

async function openProjectRepo() {
  if (repoLink.value) await openUrlWithConfirm(repoLink.value.url)
}

// Refresh git status on project change (polling is managed by git store lifecycle in App.vue)
watch(
  () => projectStore.currentProject?.id,
  (id) => {
    if (id) {
      gitStore.refreshStatus()
    }
  },
  { immediate: true },
)

// Encoding dropdown (2-step: pick encoding → pick action)
const encodings = ['UTF-8', 'Shift_JIS', 'EUC-JP', 'ISO-2022-JP', 'ISO-8859-1', 'UTF-16LE', 'UTF-16BE', 'Windows-1252']
const showEncodingMenu = ref(false)
const showEncodingAction = ref(false)
const selectedEncoding = ref('')
const showLineEndingMenu = ref(false)

function toggleEncodingMenu() {
  showLineEndingMenu.value = false
  showEncodingAction.value = false
  showEncodingMenu.value = !showEncodingMenu.value
  if (showEncodingMenu.value) {
    nextTick(() => window.addEventListener('mousedown', closeEncodingMenu, { once: true }))
  }
}

function closeEncodingMenu() {
  showEncodingMenu.value = false
  showEncodingAction.value = false
}

function selectEncoding(enc: string) {
  selectedEncoding.value = enc
  showEncodingMenu.value = false
  showEncodingAction.value = true
  nextTick(() => window.addEventListener('mousedown', closeEncodingMenu, { once: true }))
}

function reopenWithEncoding() {
  closeEncodingMenu()
  editorInfo.requestEncodingChange(selectedEncoding.value)
}

function saveWithEncoding() {
  closeEncodingMenu()
  editorInfo.requestSaveWithEncoding(selectedEncoding.value)
}

function toggleLineEndingMenu() {
  showEncodingMenu.value = false
  showLineEndingMenu.value = !showLineEndingMenu.value
  if (showLineEndingMenu.value) {
    nextTick(() => window.addEventListener('mousedown', closeLineEndingMenu, { once: true }))
  }
}

function closeLineEndingMenu() {
  showLineEndingMenu.value = false
}

function selectLineEnding(le: 'LF' | 'CRLF') {
  closeLineEndingMenu()
  editorInfo.requestLineEndingChange(le)
}

// Branch switcher dropdown
const showBranches = ref(false)
const branchQuery = ref('')

const filteredBranches = computed(() => {
  const q = branchQuery.value.toLowerCase()
  if (!q) return gitStore.branches
  return gitStore.branches.filter((b) => b.toLowerCase().includes(q))
})

async function openBranchSwitcher() {
  await gitStore.loadBranches()
  branchQuery.value = ''
  showBranches.value = true
  nextTick(() => {
    window.addEventListener('mousedown', closeBranches)
  })
}

function closeBranches() {
  showBranches.value = false
  window.removeEventListener('mousedown', closeBranches)
}

async function onSelectBranch(branch: string) {
  closeBranches()
  await gitStore.checkoutBranch(branch)
}

onUnmounted(() => {
  window.removeEventListener('mousedown', closeBranches)
  window.removeEventListener('mousedown', closeEncodingMenu)
  window.removeEventListener('mousedown', closeLineEndingMenu)
  window.removeEventListener('mousedown', closeClaudeUsage)
})
</script>

<template>
  <div class="status-bar">
    <button
      class="status-item clickable"
      @click="projectStore.toggleSwitcher()"
    >
      <FolderOpen :size="14" :stroke-width="2" />
      {{ projectStore.currentProject?.name ?? "No project" }}
    </button>

    <div class="spacer"></div>

    <!-- Editor info -->
    <template v-if="editorInfo.current.value">
      <span class="status-text">{{ t('statusBar.ln') }} {{ editorInfo.current.value.line }}, {{ t('statusBar.col') }} {{ editorInfo.current.value.col }}</span>
      <span class="status-text">{{ t('statusBar.spaces') }} {{ editorInfo.current.value.tabSize }}</span>
      <div class="status-dropdown-area">
        <button class="status-item clickable small" @click="toggleEncodingMenu">{{ editorInfo.current.value.encoding }}</button>
        <div v-if="showEncodingMenu" class="status-dropdown" @mousedown.stop>
          <button v-for="enc in encodings" :key="enc" @click="selectEncoding(enc)">{{ enc }}</button>
        </div>
        <div v-if="showEncodingAction" class="status-dropdown" @mousedown.stop>
          <div class="dropdown-label">{{ selectedEncoding }}</div>
          <button @click="reopenWithEncoding">{{ t('statusBar.reopenWithEncoding') }}</button>
          <button @click="saveWithEncoding">{{ t('statusBar.saveWithEncoding') }}</button>
        </div>
      </div>
      <div class="status-dropdown-area">
        <button class="status-item clickable small" @click="toggleLineEndingMenu">{{ editorInfo.current.value.lineEnding }}</button>
        <div v-if="showLineEndingMenu" class="status-dropdown" @mousedown.stop>
          <button @click="selectLineEnding('LF')">{{ t('statusBar.lfUnix') }}</button>
          <button @click="selectLineEnding('CRLF')">{{ t('statusBar.crlfWindows') }}</button>
        </div>
      </div>
      <span class="status-text">{{ editorInfo.current.value.fileType }}</span>
    </template>

    <div v-if="codexSession?.tokenUsage" class="status-item small cc-usage">
      <Cpu :size="12" :stroke-width="2" />
      <span>{{ formatTokens(codexSession.tokenUsage.input) }} {{ t('statusBar.ccIn') }} / {{ formatTokens(codexSession.tokenUsage.output) }} {{ t('statusBar.ccOut') }}</span>
      <span v-if="codexSession.estimatedCostUsd !== null" class="cc-cost">~{{ formatCost(codexSession.estimatedCostUsd) }}</span>
    </div>

    <div v-else-if="claudeUsageStore.usage?.active" class="status-dropdown-area">
      <button class="status-item clickable small cc-usage" @click="toggleClaudeUsage">
        <Cpu :size="12" :stroke-width="2" />
        <span>{{ formatTokens(claudeUsageStore.usage.totalInputTokens) }} {{ t('statusBar.ccIn') }} / {{ formatTokens(claudeUsageStore.usage.totalOutputTokens) }} {{ t('statusBar.ccOut') }}</span>
        <span v-if="claudeUsageStore.usage.estimatedCostUsd !== null" class="cc-cost">~{{ formatCost(claudeUsageStore.usage.estimatedCostUsd) }}</span>
      </button>
      <div v-if="showClaudeUsage" class="status-dropdown cc-dropdown" @mousedown.stop>
        <div class="dropdown-label">{{ t('statusBar.ccSession') }}</div>
        <div v-for="m in claudeUsageStore.usage.models" :key="m.model" class="cc-model-row">
          <div class="cc-model-name">{{ m.model }}</div>
          <div class="cc-model-stats">
            <span>{{ t('statusBar.ccIn') }}: {{ formatTokens(m.inputTokens) }}</span>
            <span>{{ t('statusBar.ccOut') }}: {{ formatTokens(m.outputTokens) }}</span>
            <span>{{ t('statusBar.ccCache') }}: {{ formatTokens(m.cacheReadTokens) }}</span>
            <span>{{ t('statusBar.ccCacheCreate') }}: {{ formatTokens(m.cacheCreationTokens) }}</span>
            <span v-if="m.costUsd !== null" class="cc-cost">{{ formatCost(m.costUsd) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="gitStore.status" class="branch-area">
      <button class="status-item clickable" @click="openBranchSwitcher">
        <GitBranch :size="14" :stroke-width="2" class="branch-icon" />
        <span>{{ gitStore.status.branch }}</span>
        <span v-if="gitStore.status.isDirty" class="dirty-dot"></span>
      </button>

      <div v-if="showBranches" class="branch-dropdown" @mousedown.stop>
        <input
          v-model="branchQuery"
          class="branch-search"
          :placeholder="t('git.switchBranch')"
          @keydown.esc="closeBranches"
        />
        <div class="branch-list">
          <button
            v-for="b in filteredBranches"
            :key="b"
            class="branch-option"
            :class="{ current: b === gitStore.status?.branch }"
            @click="onSelectBranch(b)"
          >
            {{ b }}
            <span v-if="b === gitStore.status?.branch" class="current-mark">*</span>
          </button>
          <div v-if="!filteredBranches.length" class="branch-empty">{{ t('git.noBranches') }}</div>
        </div>
      </div>
    </div>

    <button class="status-item clickable small" @click="toggleLanguage">
      {{ settingsStore.language.toUpperCase() }}
    </button>
    <span v-if="updater.appVersion.value" class="status-text version">v{{ updater.appVersion.value }}{{ devHash }}</span>
    <button
      v-if="repoLink"
      class="status-item clickable github-btn"
      :title="repoLink.label"
      @click="openProjectRepo"
    >
      <component :is="repoIcon" :size="14" :stroke-width="1.5" />
    </button>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  height: 24px;
  min-height: 24px;
  background: var(--statusbar-bg);
  padding: 0 8px;
  font-size: 12px;
  color: var(--text-active);
  user-select: none;
}

.status-item {
  padding: 0 8px;
  border: none;
  background: transparent;
  color: var(--text-active);
  font-size: 12px;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-item.clickable {
  cursor: pointer;
}

.status-item.clickable:hover {
  background: rgba(255, 255, 255, 0.12);
}

.spacer {
  flex: 1;
}

.status-text {
  padding: 0 6px;
  font-size: 11px;
  opacity: 0.85;
}

.status-text.version {
  opacity: 0.5;
}

.github-btn {
  opacity: 0.5;
  padding: 0 4px !important;
}

.github-btn:hover {
  opacity: 1;
}

.status-item.small {
  font-size: 11px;
  padding: 0 4px;
}

.status-dropdown-area {
  position: relative;
}

.status-dropdown {
  position: absolute;
  bottom: 24px;
  left: 0;
  min-width: 140px;
  max-height: 250px;
  overflow-y: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
}

.status-dropdown button {
  display: block;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.status-dropdown button:hover {
  background: var(--tab-hover-bg);
}

.dropdown-label {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

.cc-usage {
  gap: 4px;
  opacity: 0.85;
}

.cc-cost {
  opacity: 0.7;
}

.cc-dropdown {
  min-width: 240px;
}

.cc-model-row {
  padding: 4px 12px;
}

.cc-model-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-active);
  margin-bottom: 2px;
}

.cc-model-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: var(--text-primary);
}

.branch-icon {
  flex-shrink: 0;
}

.dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--git-modify);
  flex-shrink: 0;
}

.branch-area {
  position: relative;
}

.branch-dropdown {
  position: absolute;
  bottom: 24px;
  right: 0;
  width: 260px;
  max-height: 300px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.branch-search {
  padding: 6px 10px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-active);
  font-size: 13px;
  outline: none;
}

.branch-search::placeholder {
  color: var(--text-secondary);
}

.branch-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.branch-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.branch-option:hover {
  background: var(--tab-hover-bg);
}

.branch-option.current {
  color: var(--accent);
  font-weight: 600;
}

.current-mark {
  color: var(--accent);
}

.branch-empty {
  padding: 12px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
