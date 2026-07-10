<script setup lang="ts">
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  Cpu,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Github,
  Gitlab,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-vue-next'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useEditorInfo } from '../../composables/useEditorInfo'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'
import { formatCost, formatTokens } from '../../lib/format'
import { buildRepoLink } from '../../lib/gitRemote'
import { basename } from '../../lib/paths'
import { openUrlWithConfirm } from '../../lib/tauri'
import { elevated, globalMode } from '../../lib/window'
import { useAgentStore } from '../../stores/agent'
import { useClaudeRateStore } from '../../stores/claudeRate'
import { useClaudeUsageStore } from '../../stores/claudeUsage'
import { useCodexUsageStore } from '../../stores/codexUsage'
import { useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import { useWorktreeStore } from '../../stores/worktree'
import type { GitWorktree } from '../../types/git'
import HelpButton from '../HelpButton.vue'

const { t, locale } = useI18n()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()

function toggleLanguage() {
  settingsStore.language = settingsStore.language === 'en' ? 'ja' : 'en'
}
const gitStore = useGitStore()
const worktreeStore = useWorktreeStore()
const editorInfo = useEditorInfo()
const updater = useUpdater()
const claudeUsageStore = useClaudeUsageStore()
const codexUsageStore = useCodexUsageStore()
const agentStore = useAgentStore()
const tabStore = useTabStore()
const statusMessageStore = useStatusMessageStore()

const statusIcon = computed(() => {
  switch (statusMessageStore.variant) {
    case 'loading':
      return Loader2
    case 'success':
      return Check
    case 'warn':
    case 'error':
      return AlertTriangle
    default:
      return null
  }
})

const codexSession = computed(() => {
  const tab = tabStore.activeTab
  if (tab?.kind !== 'agent-chat' || tab.agentType !== 'codex') return null
  const s = agentStore.getExistingSession(tab.id)
  return s?.tokenUsage ? s : null
})

const claudeRateStore = useClaudeRateStore()

// Rate-limit windows from `claude -p "/usage"` (account-wide, not per-session).
const claudeRate = computed(() => {
  const r = claudeRateStore.usage
  return r?.active ? r : null
})

// The 5h session window — the headline number for the status-bar chip.
// No fallback to other windows: a weekly quota must not be labeled "5h".
const claudeRateSession = computed(() => claudeRate.value?.windows.find((w) => w.kind === 'session') ?? null)

/** Short UI label per window kind; unrecognized windows show the raw CLI label. */
function rateWindowLabel(w: { kind: string; label: string }): string {
  if (w.kind === 'session') return t('statusBar.rate5h')
  if (w.kind === 'weekAll') return t('statusBar.rateWeekly')
  return w.label
}

const RESET_MONTHS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
}

/**
 * The CLI prints reset times with an English month name ("Jul 2, 2:40pm
 * (Asia/Tokyo)"). For the ja locale, rewrite just the date part to numeric
 * ("7/2 2:40pm (Asia/Tokyo)"). Text-level rewrite only — the time is already
 * in the user's timezone, so no time math is needed or attempted.
 */
function localizedResetLabel(resetsAt: string): string {
  if (locale.value !== 'ja') return resetsAt
  return resetsAt.replace(
    /([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?,?/,
    (match, mon: string, day: string, year?: string) => {
      const m = RESET_MONTHS[mon]
      if (!m) return match
      return year ? `${year}/${m}/${day}` : `${m}/${day}`
    },
  )
}

/** Color emphasis for a usage percentage: yellow past 80%, red past 90%. */
function rateLevelClass(pct: number): string {
  if (pct > 90) return 'rate-danger'
  if (pct > 80) return 'rate-warn'
  return ''
}

const rateFetchedAtLabel = computed(() => {
  const r = claudeRate.value
  if (!r?.fetchedAt) return ''
  const time = new Date(r.fetchedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return t('statusBar.ccRateFetchedAt', { time })
})

const rateRefreshing = ref(false)

async function refreshRateLimits() {
  if (rateRefreshing.value) return
  rateRefreshing.value = true
  try {
    await claudeRateStore.refreshUsage(true)
  } finally {
    rateRefreshing.value = false
  }
}

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

// Codex used indirectly (a Claude codex skill / a script calling the `codex` CLI)
// shows up in ~/.codex rollouts. Suppress it when a native Codex agent-chat tab is
// active — `codexSession` above already covers that case more precisely.
const codexCliUsage = computed(() => {
  if (codexSession.value) return null
  const u = codexUsageStore.usage
  return u?.active ? u : null
})

const showCodexUsage = ref(false)

function toggleCodexUsage() {
  showCodexUsage.value = !showCodexUsage.value
  if (showCodexUsage.value) {
    nextTick(() => window.addEventListener('mousedown', closeCodexUsage, { once: true }))
  }
}

function closeCodexUsage() {
  showCodexUsage.value = false
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
    case 'bitbucket':
      return Archive
    // codeberg は lucide に専用アイコンが無いため汎用 Git アイコンで代用
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

// Worktree switcher dropdown
const showWorktrees = ref(false)

const worktreeLabel = computed(() => {
  const active = worktreeStore.worktrees.find((w) => worktreeStore.isActive(w))
  if (active) return basename(active.path)
  const root = projectStore.activeRoot
  return root ? basename(root) : ''
})

async function openWorktreeSwitcher() {
  await worktreeStore.loadWorktrees()
  showWorktrees.value = true
  nextTick(() => window.addEventListener('mousedown', closeWorktrees))
}

function closeWorktrees() {
  showWorktrees.value = false
  window.removeEventListener('mousedown', closeWorktrees)
}

async function onSelectWorktree(w: GitWorktree) {
  closeWorktrees()
  await worktreeStore.setActiveWorktree(w)
}

function worktreeBranchLabel(w: GitWorktree): string {
  if (w.isDetached) return t('worktree.detached')
  return w.branch ?? ''
}

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
  window.removeEventListener('mousedown', closeWorktrees)
  window.removeEventListener('mousedown', closeEncodingMenu)
  window.removeEventListener('mousedown', closeLineEndingMenu)
  window.removeEventListener('mousedown', closeClaudeUsage)
  window.removeEventListener('mousedown', closeCodexUsage)
})
</script>

<template>
  <div class="status-bar ui-zoom">
    <span v-if="elevated" class="status-item admin-badge" :title="t('statusBar.adminTooltip')">
      <ShieldCheck :size="14" :stroke-width="2" />
      {{ t('statusBar.admin') }}
    </span>
    <button
      v-if="!globalMode"
      class="status-item clickable"
      @click="projectStore.toggleSwitcher()"
    >
      <FolderOpen :size="14" :stroke-width="2" />
      {{ projectStore.currentProject?.name ?? "No project" }}
    </button>

    <Transition name="status-msg">
      <div
        v-if="statusMessageStore.visible"
        class="status-message"
        :class="`variant-${statusMessageStore.variant}`"
      >
        <component
          :is="statusIcon"
          v-if="statusIcon"
          :size="12"
          :stroke-width="2"
          :class="{ 'spin-icon': statusMessageStore.variant === 'loading' }"
        />
        <span>{{ statusMessageStore.text }}</span>
      </div>
    </Transition>

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

    <div v-if="claudeUsageStore.usage?.active || claudeRate" class="status-dropdown-area">
      <button class="status-item clickable small cc-usage" @click="toggleClaudeUsage">
        <Cpu :size="12" :stroke-width="2" />
        <template v-if="claudeUsageStore.usage?.active">
          <span>{{ formatTokens(claudeUsageStore.usage.totalInputTokens) }} {{ t('statusBar.ccIn') }} / {{ formatTokens(claudeUsageStore.usage.totalOutputTokens) }} {{ t('statusBar.ccOut') }}</span>
          <span v-if="claudeUsageStore.usage.estimatedCostUsd !== null" class="cc-cost">~{{ formatCost(claudeUsageStore.usage.estimatedCostUsd) }}</span>
        </template>
        <span v-else>{{ t('statusBar.ccName') }}</span>
        <span v-if="claudeRateSession" class="cc-cost" :class="rateLevelClass(claudeRateSession.usedPercent)">{{ t('statusBar.rate5h') }} {{ claudeRateSession.usedPercent.toFixed(0) }}%</span>
      </button>
      <div v-if="showClaudeUsage" class="status-dropdown cc-dropdown" @mousedown.stop>
        <div class="dropdown-label">
          <span>{{ claudeUsageStore.usage?.active ? t('statusBar.ccSession') : t('statusBar.rate') }}</span>
          <HelpButton page="terminal-and-agents.md#トークン使用量とコスト" :size="13" />
        </div>
        <template v-if="claudeUsageStore.usage?.active">
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
        </template>
        <div v-if="claudeRate" class="cc-model-row">
          <div class="cc-model-name cc-rate-name">
            <span>{{ t('statusBar.rate') }}</span>
            <button
              class="rate-refresh"
              :title="t('statusBar.ccRateRefresh')"
              :disabled="rateRefreshing"
              @click="refreshRateLimits"
            >
              <RefreshCw :size="11" :stroke-width="2" :class="{ 'spin-icon': rateRefreshing }" />
            </button>
            <span v-if="rateFetchedAtLabel" class="cc-rate-resets">{{ rateFetchedAtLabel }}</span>
          </div>
          <div v-for="w in claudeRate.windows" :key="w.label" class="cc-rate-row">
            <span class="cc-rate-window" :class="rateLevelClass(w.usedPercent)">{{ rateWindowLabel(w) }}: {{ w.usedPercent.toFixed(0) }}%</span>
            <span v-if="w.resetsAt" class="cc-rate-resets">{{ t('statusBar.ccRateResets', { when: localizedResetLabel(w.resetsAt) }) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Native Codex agent-chat tab (precise, event-driven) -->
    <div v-if="codexSession?.tokenUsage" class="status-item small cc-usage">
      <Bot :size="12" :stroke-width="2" />
      <span>{{ formatTokens(codexSession.tokenUsage.input) }} {{ t('statusBar.ccIn') }} / {{ formatTokens(codexSession.tokenUsage.output) }} {{ t('statusBar.ccOut') }}</span>
      <span v-if="codexSession.estimatedCostUsd !== null" class="cc-cost">~{{ formatCost(codexSession.estimatedCostUsd) }}</span>
    </div>

    <!-- Codex used indirectly via the CLI (Claude skill / scripts), from ~/.codex rollouts -->
    <div v-else-if="codexCliUsage" class="status-dropdown-area">
      <button class="status-item clickable small cc-usage" :title="t('statusBar.codexCli')" @click="toggleCodexUsage">
        <Bot :size="12" :stroke-width="2" />
        <span>{{ formatTokens(codexCliUsage.totalInputTokens) }} {{ t('statusBar.ccIn') }} / {{ formatTokens(codexCliUsage.totalOutputTokens) }} {{ t('statusBar.ccOut') }}</span>
        <span v-if="codexCliUsage.rateLimitPrimary" class="cc-cost">{{ t('statusBar.rate5h') }} {{ codexCliUsage.rateLimitPrimary.usedPercent.toFixed(0) }}%</span>
      </button>
      <div v-if="showCodexUsage" class="status-dropdown cc-dropdown" @mousedown.stop>
        <div class="dropdown-label">
          <span>{{ t('statusBar.codexSession') }}<template v-if="codexCliUsage.sessionCount > 1"> ({{ codexCliUsage.sessionCount }} {{ t('statusBar.codexSessions') }})</template></span>
          <HelpButton page="terminal-and-agents.md#トークン使用量とコスト" :size="13" />
        </div>
        <div class="cc-model-row">
          <div class="cc-model-name">{{ codexCliUsage.model ?? 'codex' }}</div>
          <div class="cc-model-stats">
            <span>{{ t('statusBar.ccIn') }}: {{ formatTokens(codexCliUsage.totalInputTokens) }}</span>
            <span>{{ t('statusBar.ccOut') }}: {{ formatTokens(codexCliUsage.totalOutputTokens) }}</span>
            <span>{{ t('statusBar.codexCached') }}: {{ formatTokens(codexCliUsage.totalCachedInputTokens) }}</span>
            <span>{{ t('statusBar.codexReasoning') }}: {{ formatTokens(codexCliUsage.totalReasoningTokens) }}</span>
            <span v-if="codexCliUsage.estimatedCostUsd !== null" class="cc-cost">{{ formatCost(codexCliUsage.estimatedCostUsd) }}</span>
          </div>
        </div>
        <div v-if="codexCliUsage.rateLimitPrimary || codexCliUsage.rateLimitSecondary" class="cc-model-row">
          <div class="cc-model-name">{{ t('statusBar.rate') }}</div>
          <div class="cc-model-stats">
            <span v-if="codexCliUsage.rateLimitPrimary">{{ t('statusBar.rate5h') }}: {{ codexCliUsage.rateLimitPrimary.usedPercent.toFixed(1) }}%</span>
            <span v-if="codexCliUsage.rateLimitSecondary">{{ t('statusBar.rateWeekly') }}: {{ codexCliUsage.rateLimitSecondary.usedPercent.toFixed(1) }}%</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="worktreeStore.hasMultiple" class="branch-area">
      <button class="status-item clickable" data-testid="worktree-selector" :title="t('worktree.tooltip')" @click="openWorktreeSwitcher">
        <FolderGit2 :size="14" :stroke-width="2" class="branch-icon" />
        <span>{{ worktreeLabel }}</span>
      </button>

      <div v-if="showWorktrees" class="branch-dropdown" @mousedown.stop>
        <div class="dropdown-label">
          <span>{{ t('worktree.switch') }}</span>
          <HelpButton page="git.md#worktree" :size="13" />
        </div>
        <div class="branch-list">
          <button
            v-for="w in worktreeStore.worktrees"
            :key="w.path"
            class="branch-option worktree-option"
            :class="{ current: worktreeStore.isActive(w) }"
            @click="onSelectWorktree(w)"
          >
            <span class="worktree-name">
              {{ basename(w.path) }}
              <span class="worktree-branch">{{ worktreeBranchLabel(w) }}</span>
            </span>
            <span v-if="worktreeStore.isActive(w)" class="current-mark">*</span>
          </button>
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

.status-item.admin-badge {
  color: var(--warning, #d29922);
  font-weight: 600;
  cursor: default;
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

.status-message {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
}

.status-message.variant-success {
  color: var(--git-add, #4caf50);
}

.status-message.variant-warn,
.status-message.variant-error {
  color: var(--git-modify, #e0c46c);
}

.status-message.variant-loading,
.status-message.variant-info {
  opacity: 0.85;
}

.spin-icon {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.status-msg-enter-active,
.status-msg-leave-active {
  transition: opacity 150ms ease;
}

.status-msg-enter-from,
.status-msg-leave-to {
  opacity: 0;
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

/* Full-width menu items — exclude inline icon buttons (help, rate refresh). */
.status-dropdown button:not(.help-btn):not(.rate-refresh) {
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

.status-dropdown button:not(.help-btn):not(.rate-refresh):hover {
  background: var(--tab-hover-bg);
}

.dropdown-label {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 12px;
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
  /* Fixed width + right anchor: the Claude/Codex chips sit near the right end
     of the status bar, so a left-anchored (left: 0) dropdown would extend past
     the window edge. Fixed width (not min-width) also stops nowrap children
     from widening the box and spawning a horizontal scrollbar — they shrink
     with ellipsis instead. */
  width: 360px;
  left: auto;
  right: 0;
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

.cc-rate-name {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  white-space: nowrap;
  gap: 6px;
}

.cc-rate-name .cc-rate-resets {
  margin-left: auto;
  font-weight: 400;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* One window per line: percentage left, reset time right. */
.cc-rate-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11px;
  color: var(--text-primary);
  white-space: nowrap;
}

.cc-rate-row .cc-rate-window {
  flex-shrink: 0;
}

.cc-rate-row .cc-rate-resets {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rate-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
}

.rate-refresh:hover:not(:disabled) {
  color: var(--text-active);
}

.rate-refresh:disabled {
  cursor: default;
  opacity: 0.6;
}

.cc-rate-resets {
  opacity: 0.7;
}

/* Usage-percentage emphasis: yellow past 80%, red past 90%. Overrides the
   dimmed .cc-cost chip style so the warning color reads at full strength. */
.rate-warn {
  color: var(--git-modify);
  opacity: 1;
}

.rate-danger {
  color: var(--danger);
  opacity: 1;
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

.worktree-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.worktree-branch {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.branch-empty {
  padding: 12px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
}
</style>
