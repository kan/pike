<script setup lang="ts">
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  Cloud,
  FolderGit2,
  FolderOpen,
  Gauge,
  GitBranch,
  Github,
  Gitlab,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-vue-next'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useAgentUsage } from '../../composables/useAgentUsage'
import { useEditorInfo } from '../../composables/useEditorInfo'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'
import { formatCost, formatTokens } from '../../lib/format'
import { buildRepoLink } from '../../lib/gitRemote'
import { languageOptions } from '../../lib/languages'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { basename } from '../../lib/paths'
import { traySetTooltip } from '../../lib/tauri'
import { type Meter, rateLevelClass, toMeter } from '../../lib/usageFormat'
import { elevated, globalMode, isMainWindow } from '../../lib/window'
import { localBranchName, useGitStore } from '../../stores/git'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import { useWorktreeStore } from '../../stores/worktree'
import type { AgentUsage } from '../../types/agentUsage'
import type { GitWorktree } from '../../types/git'
import HelpButton from '../HelpButton.vue'
import RateMeters from '../RateMeters.vue'

const { t } = useI18n()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()

function toggleLanguage() {
  settingsStore.language = settingsStore.language === 'en' ? 'ja' : 'en'
}
const gitStore = useGitStore()
const worktreeStore = useWorktreeStore()
const editorInfo = useEditorInfo()
const updater = useUpdater()
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

const {
  visible: agentEntries,
  headline: agentHeadline,
  refreshing: agentRefreshing,
  refreshAll: refreshAgentUsage,
} = useAgentUsage()

const hasAgentStatus = computed(() => agentEntries.value.length > 0)

/**
 * ヘッドラインの「25% / 5%」。**5h と週間だけ**に絞る（モデル別の枠まで並べると、
 * ステータスバーに入らないうえ、どの数字かが読めない）。詳細は状態タブへ。
 */
function summaryMeters(usage: AgentUsage | null): Meter[] {
  const meters = usage?.meters ?? []
  return [meters.find((m) => m.kind === 'session'), meters.find((m) => m.kind === 'weekAll')]
    .filter((m) => m !== undefined)
    .map(toMeter)
}

const headlineMeters = computed<Meter[]>(() => summaryMeters(agentHeadline.value?.usage ?? null))

/** ドロップダウンの行。**帯はここで 1 回だけ組む**（テンプレートで 2 回呼ばない）。 */
const agentRows = computed(() =>
  agentEntries.value.map(({ agent, usage }) => ({ agent, usage, meters: summaryMeters(usage) })),
)

/** Which window is which, for the button's tooltip — the bare "25% / 5%" cannot say. */
const headlineTitle = computed(() => {
  const name = agentHeadline.value?.agent.label ?? ''
  const parts = headlineMeters.value.map((m) => `${m.label} ${m.percent.toFixed(0)}%`)
  return parts.length ? `${name}: ${parts.join(' / ')}` : t('agentStatus.title')
})

/**
 * System-tray tooltip (#161): 畳んでいるあいだホバーで出る 1 行。トレイはプロセスに 1 つ
 * なので main ウィンドウだけが押す。
 *
 * **利用率を出せる先頭のエージェント**（`headline`）の 5h 枠を出し、無ければそのエージェントの
 * トークン合計に落ちる。Rust がアプリ名を前置するので、ここは使用量の半分だけ。
 */
const trayTooltip = computed(() => {
  const entry = agentHeadline.value ?? agentEntries.value[0]
  if (!entry?.usage) return ''
  const session = entry.usage.meters.find((m) => m.kind === 'session')
  if (session) {
    return `${entry.agent.label} ${t('statusBar.rate5h')} ${session.usedPercent.toFixed(0)}%`
  }
  const total = entry.usage.total
  if (entry.usage.active && total && total.input + total.output > 0) {
    return `${entry.agent.label} ${formatTokens(total.input)} ${t('statusBar.ccIn')} / ${formatTokens(total.output)} ${t('statusBar.ccOut')}`
  }
  return ''
})
if (isMainWindow()) {
  watch(trayTooltip, (text) => traySetTooltip(text).catch(() => {}), { immediate: true })
}

const showAgentStatus = ref(false)

function toggleAgentStatus() {
  showAgentStatus.value = !showAgentStatus.value
  if (showAgentStatus.value) {
    nextTick(() => window.addEventListener('mousedown', closeAgentStatus, { once: true }))
  }
}

function closeAgentStatus() {
  showAgentStatus.value = false
}

function openAgentStatus() {
  showAgentStatus.value = false
  tabStore.addAgentStatusTab()
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

// ファイルタイプの手動切り替え（#312 の続き）。**一時的で、記憶しない**（開き直せば自動判定）。
// 選択肢は起動から不変なので 1 回だけ作る（テンプレートから呼ぶと再描画のたびに組み直す）。
const fileTypeOptions = languageOptions()
const showFileTypeMenu = ref(false)

function toggleFileTypeMenu() {
  showEncodingMenu.value = false
  showLineEndingMenu.value = false
  showFileTypeMenu.value = !showFileTypeMenu.value
  if (showFileTypeMenu.value) {
    nextTick(() => window.addEventListener('mousedown', closeFileTypeMenu, { once: true }))
  }
}

function closeFileTypeMenu() {
  showFileTypeMenu.value = false
}

function selectFileType(key: string | null) {
  closeFileTypeMenu()
  editorInfo.requestFileTypeChange(key)
}

// Branch switcher dropdown
const showBranches = ref(false)
const branchQuery = ref('')

const filteredBranches = computed(() => {
  const q = branchQuery.value.toLowerCase()
  if (!q) return gitStore.branches
  return gitStore.branches.filter((b) => b.toLowerCase().includes(q))
})

// Remote-tracking branches that have no local counterpart yet — the ones the
// local list above cannot already switch to (#197).
const filteredRemoteBranches = computed(() => {
  const local = new Set(gitStore.branches)
  const q = branchQuery.value.toLowerCase()
  return gitStore.remoteBranches.filter((b) => !local.has(localBranchName(b)) && (!q || b.toLowerCase().includes(q)))
})

async function openBranchSwitcher() {
  await gitStore.loadBranches()
  branchQuery.value = ''
  showBranches.value = true
  nextTick(() => {
    window.addEventListener('mousedown', closeBranches)
  })
  // The list is already usable from the cached refs; pick up branches pushed
  // since the last fetch in the background.
  void gitStore.refreshRemoteBranches()
}

function closeBranches() {
  showBranches.value = false
  window.removeEventListener('mousedown', closeBranches)
}

async function onSelectBranch(branch: string) {
  closeBranches()
  await gitStore.checkoutBranch(branch)
}

async function onSelectRemoteBranch(remoteBranch: string) {
  closeBranches()
  await gitStore.checkoutRemoteBranch(remoteBranch)
}

onUnmounted(() => {
  window.removeEventListener('mousedown', closeBranches)
  window.removeEventListener('mousedown', closeWorktrees)
  window.removeEventListener('mousedown', closeEncodingMenu)
  window.removeEventListener('mousedown', closeLineEndingMenu)
  window.removeEventListener('mousedown', closeFileTypeMenu)
  window.removeEventListener('mousedown', closeAgentStatus)
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
      <!-- Directory opened without registering it (#230): nothing here is saved,
           so say so rather than letting it pass for a project. -->
      <span v-if="projectStore.isTransient" class="missing-tag transient-tag" :title="t('statusBar.transientHint')">
        {{ t('statusBar.transient') }}
      </span>
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
        <div v-if="showEncodingMenu" class="status-dropdown popup-surface" @mousedown.stop>
          <button v-for="enc in encodings" :key="enc" @click="selectEncoding(enc)">{{ enc }}</button>
        </div>
        <div v-if="showEncodingAction" class="status-dropdown popup-surface" @mousedown.stop>
          <div class="dropdown-label">{{ selectedEncoding }}</div>
          <button @click="reopenWithEncoding">{{ t('statusBar.reopenWithEncoding') }}</button>
          <button @click="saveWithEncoding">{{ t('statusBar.saveWithEncoding') }}</button>
        </div>
      </div>
      <div class="status-dropdown-area">
        <button class="status-item clickable small" @click="toggleLineEndingMenu">{{ editorInfo.current.value.lineEnding }}</button>
        <div v-if="showLineEndingMenu" class="status-dropdown popup-surface" @mousedown.stop>
          <button @click="selectLineEnding('LF')">{{ t('statusBar.lfUnix') }}</button>
          <button @click="selectLineEnding('CRLF')">{{ t('statusBar.crlfWindows') }}</button>
        </div>
      </div>
      <div class="status-dropdown-area">
        <button class="status-item clickable small" :title="t('statusBar.fileTypeHint')" @click="toggleFileTypeMenu">
          {{ editorInfo.current.value.fileType }}
        </button>
        <div v-if="showFileTypeMenu" class="status-dropdown popup-surface file-type-menu" @mousedown.stop>
          <button :class="{ current: !editorInfo.current.value.fileTypeKey }" @click="selectFileType(null)">
            {{ t('statusBar.fileTypeAuto') }}
          </button>
          <div class="ctx-separator" />
          <button
            v-for="opt in fileTypeOptions"
            :key="opt.key"
            :class="{ current: editorInfo.current.value.fileTypeKey === opt.key }"
            @click="selectFileType(opt.key)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>
    </template>

    <!-- Agents: one item for both Claude and Codex; the detail lives in the status tab (#226) -->
    <div v-if="hasAgentStatus" class="status-dropdown-area">
      <button class="status-item clickable small cc-usage" :title="headlineTitle" @click="toggleAgentStatus">
        <Gauge :size="13" :stroke-width="2" />
        <template v-if="headlineMeters.length">
          <template v-for="(m, i) in headlineMeters" :key="m.label">
            <span v-if="i" class="cc-rate-sep">/</span>
            <span :class="rateLevelClass(m.percent)">{{ m.percent.toFixed(0) }}%</span>
          </template>
        </template>
        <span v-else>{{ t('statusBar.agents') }}</span>
      </button>
      <div v-if="showAgentStatus" class="status-dropdown cc-dropdown popup-surface" @mousedown.stop>
        <div class="dropdown-label">
          <span class="dropdown-title">{{ t('agentStatus.title') }}</span>
          <button class="detail-link" @click="openAgentStatus">{{ t('agentStatus.open') }}</button>
          <button
            class="rate-refresh"
            :title="t('statusBar.ccRateRefresh')"
            :disabled="agentRefreshing"
            @click="refreshAgentUsage"
          >
            <RefreshCw :size="11" :stroke-width="2" :class="{ 'spin-icon': agentRefreshing }" />
          </button>
          <HelpButton page="terminal-and-agents.md#エージェント状態タブ" :size="13" />
        </div>

        <!--
          使っているエージェントを順に出す（#263）。**種別の分岐を持たない**ので、
          レジストリに行を足すだけで増える。ここは要約だけで、内訳は状態タブへ。
        -->
        <div v-for="{ agent, usage, meters } in agentRows" :key="agent.id" class="cc-agent">
          <div class="cc-agent-name">
            <Bot :size="12" :stroke-width="2" />
            <span>{{ agent.label }}</span>
          </div>
          <div v-if="usage?.account?.email || usage?.account?.name" class="cc-account">
            <span class="cc-account-name">{{ usage.account.email ?? usage.account.name }}</span>
            <span v-if="usage.account.plan" class="cc-account-meta">{{ usage.account.plan }}</span>
          </div>
          <div v-if="usage?.total && usage.total.input + usage.total.output > 0" class="cc-summary">
            <span>{{ t('statusBar.ccIn') }} {{ formatTokens(usage.total.input) }}</span>
            <span>{{ t('statusBar.ccOut') }} {{ formatTokens(usage.total.output) }}</span>
            <span v-if="usage.total.costUsd !== null" class="cc-cost">~{{ formatCost(usage.total.costUsd) }}</span>
          </div>
          <!--
            **枠を持たないエージェントでは出さない。** `RateMeters` は空だと「利用率を
            取得できていません」を出すので、構造的に出せない Copilot / opencode に対して
            恒久的な事実を取得失敗として見せてしまう（状態タブは節ごと出さない側で、
            出し分けが食い違う）。
          -->
          <RateMeters v-if="meters.length > 0" :meters="meters" class="cc-meters" />
        </div>
      </div>
    </div>

    <div v-if="worktreeStore.hasMultiple" class="branch-area">
      <button class="status-item clickable" data-testid="worktree-selector" :title="t('worktree.tooltip')" @click="openWorktreeSwitcher">
        <FolderGit2 :size="14" :stroke-width="2" class="branch-icon" />
        <span>{{ worktreeLabel }}</span>
      </button>

      <div v-if="showWorktrees" class="branch-dropdown popup-surface" @mousedown.stop>
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
      <button class="status-item clickable" data-testid="branch-selector" @click="openBranchSwitcher">
        <GitBranch :size="14" :stroke-width="2" class="branch-icon" />
        <span>{{ gitStore.status.branch }}</span>
        <span v-if="gitStore.status.isDirty" class="dirty-dot"></span>
      </button>

      <div v-if="showBranches" class="branch-dropdown popup-surface" @mousedown.stop>
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
          <template v-if="filteredRemoteBranches.length || gitStore.fetchingBranches">
            <div class="dropdown-label group">
              <span>{{ t('git.remoteBranches') }}</span>
              <RefreshCw
                v-if="gitStore.fetchingBranches"
                :size="11"
                :stroke-width="2"
                class="spin-icon"
              />
            </div>
            <button
              v-for="b in filteredRemoteBranches"
              :key="b"
              class="branch-option remote-option"
              :title="t('git.checkoutRemoteHint', { branch: localBranchName(b) })"
              @click="onSelectRemoteBranch(b)"
            >
              <Cloud :size="12" :stroke-width="2" class="remote-icon" />
              <span class="remote-name">{{ b }}</span>
            </button>
          </template>
          <div
            v-if="!filteredBranches.length && !filteredRemoteBranches.length"
            class="branch-empty"
          >{{ t('git.noBranches') }}</div>
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

/* Shares the project-status badge shape with .missing-tag (theme.css); only the
   dashed edge and the inherited color differ. */
.transient-tag {
  border-style: dashed;
  color: inherit;
  opacity: 0.75;
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
/* メニュー項目だけを全幅にする。`.detail-link` を除外しないと、見出し行の
   リンクが幅いっぱいに広がって見出しを潰し、更新・ヘルプが枠外へ押し出される。 */
.status-dropdown button:not(.help-btn):not(.rate-refresh):not(.detail-link) {
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
  gap: 6px;
  padding: 2px 12px;
  font-size: 11px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

/* Section header inside a list, rather than at the top of the dropdown */
.dropdown-label.group {
  margin-top: 4px;
  border-top: 1px solid var(--border);
}

/* 言語の一覧は他のメニューより行数が多いので、上限だけ引き上げる（スクロールは
   `.status-dropdown` が既に持っている）。 */
.file-type-menu {
  max-height: 60vh;
}

.ctx-separator {
  margin: 4px 0;
  border-top: 1px solid var(--border);
}

/* いま選ばれている行。**基底の `:not()` 3 連鎖より特異度を上げないと当たらない**
   （`:not()` は引数の特異度を取るので、素の `button.current` では負ける）。 */
.status-dropdown button.current:not(.help-btn):not(.rate-refresh):not(.detail-link) {
  color: var(--accent);
  font-weight: 600;
}

.cc-usage {
  gap: 4px;
  opacity: 0.85;
}

/* 5h と週の区切り。数字より落として、色付き（warn/danger）の数字を目立たせる。 */
.cc-rate-sep {
  margin: 0 -2px;
  color: var(--text-secondary);
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

/* 見出しは折り返さない。以前は「詳細」リンクが `margin-left: auto` で幅を取り、
   「Claude Code セッション」が折り返していた。 */
.dropdown-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* エージェントごとの区切り。 */
.cc-agent {
  padding: 4px 0 6px;
}

.cc-agent + .cc-agent {
  border-top: 1px solid var(--border-color);
}

.cc-agent-name {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-active);
}

.cc-meters {
  display: block;
  padding: 2px 12px 2px;
}

/* 要約行（トークン合計）。詳細はエージェント状態タブへ寄せた（#226）。 */
.cc-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  font-size: 11px;
  color: var(--text-primary);
}

.detail-link {
  flex: 0 0 auto;
  padding: 0;
  font-size: 11px;
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
}

.detail-link:hover {
  text-decoration: underline;
}

/* エージェント名の下にぶら下がる補足。見出しと同じ濃さ・大きさだと区別が付かない
   ので、一段小さく淡くする（区切り線はエージェント間にしか引かない）。 */
.cc-account {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  padding: 0 12px 2px;
  font-size: 10px;
}

.cc-account-name {
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cc-account-meta {
  color: var(--text-secondary);
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

/* Remote rows lead with the cloud glyph instead of a trailing marker */
.branch-option.remote-option {
  justify-content: flex-start;
  gap: 6px;
}

.remote-icon {
  flex-shrink: 0;
  opacity: 0.7;
}

.remote-name {
  overflow: hidden;
  text-overflow: ellipsis;
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
