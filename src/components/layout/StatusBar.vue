<script setup lang="ts">
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  Circle,
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
import { confirmDialog } from '../../composables/useConfirmDialog'
import { useEditorInfo } from '../../composables/useEditorInfo'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'
import type { AgentDef } from '../../lib/agents'
import { macroRecording, toggleMacroRecording } from '../../lib/editorMacro'
import { formatCost, formatTokens } from '../../lib/format'
import { buildRepoLink } from '../../lib/gitRemote'
import { languageOptions } from '../../lib/languages'
import { PIKE_REPO_URL } from '../../lib/manual'
import { useOverlay } from '../../lib/overlay'
import { basename } from '../../lib/paths'
import { traySetTooltip } from '../../lib/tauri'
import { THEME_MODE_VIEW } from '../../lib/themeModes'
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

/**
 * テーマのモードの表示（#407）。アイコンと文言は設定画面と同じ表（`lib/themeModes.ts`）。
 * **ツールチップも computed にする**: この行は桁と行番号を描いている都合で打鍵のたびに
 * 再描画されるので、テンプレートに置くと i18n の補間がそのたびに走る。
 */
const themeView = computed(() => THEME_MODE_VIEW[settingsStore.themeMode])
const themeTitle = computed(() => t('statusBar.themeHint', { mode: t(themeView.value.labelKey) }))

/**
 * 「未登録」を押したときの登録（#373）。**確認を挟む**: この印が名乗っているのは状態で
 * あって操作ではないので、押した先が「ディレクトリを `project.json` に書く」だとは
 * 読み取れない。プロジェクトパネルの帯のボタンは「プロジェクトに登録」と名乗っているので
 * そちらでは聞かない（確認を `registerTransientProject` の中へ置くと、名乗っている側にも
 * 付く）。
 *
 * 断っても何も覚えない。**`offerToRegisterDirectory`（開いたときの確認）と混同しないこと**:
 * あちらは「いいえ」でその root を記録して二度と聞かないが、ここは押した人が能動的に
 * 開いた確認なので、閉じたら何も起きないのが素直。
 */
async function registerTransient() {
  const root = projectStore.currentProject?.root ?? ''
  if (await confirmDialog(t('statusBar.transientRegisterConfirm', { root }))) {
    await projectStore.registerTransientProject()
  }
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
  needsLogin: agentsNeedingLogin,
  login: loginAgent,
} = useAgentUsage()

function onLoginAgent(agent: AgentDef) {
  showAgentStatus.value = false
  loginAgent(agent)
}

const hasAgentStatus = computed(() => agentEntries.value.length > 0)
/**
 * worktree / ブランチ / リポジトリの組を出すか（#383）。**テンプレートに論理式を置かない**:
 * 中身の `v-if` を書き写した式にすると、この組に 4 つ目を足した人が伸ばし忘れたときに
 * **空の組の左に区切りだけが出る**（`usePanelAvailability` で「可否の述語は 1 箇所」を
 * 選んでいるのと同じ判断）。
 */
const hasRepoInfo = computed(() => worktreeStore.hasMultiple || !!gitStore.status || !!repoLink.value)

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
  agentEntries.value.map(({ agent, usage, needsLogin }) => ({
    agent,
    usage,
    needsLogin,
    meters: summaryMeters(usage),
  })),
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

/**
 * リポジトリのページをブラウザのタブ（#368）で開く。Pike の中でタブを開くだけなので、
 * 外部 URL を開く確認（`openUrlWithConfirm`）は挟まない（issue パネルの行のクリックと同じ）。
 */
function openProjectRepo() {
  if (repoLink.value) tabStore.addBrowserTab(repoLink.value.url)
}

/**
 * Pike 自身の GitHub（#383）。**隣のリポジトリのボタンと同じくブラウザのタブで開く**
 * （`frontend.md` の「外部ブラウザで URL を開く」の規約は、#368 以降 StatusBar の
 * リポジトリリンクには当たらない）。歯車メニューの「GitHub」は外部ブラウザのままで、
 * あちらは Pike の外へ出る意図の操作。
 */
function openPikeRepo() {
  tabStore.addBrowserTab(PIKE_REPO_URL)
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

// 手前に浮くものは数える（#396。ブラウザのタブの子 webview を隠すため）。
useOverlay(
  () =>
    showBranches.value ||
    showWorktrees.value ||
    showAgentStatus.value ||
    showEncodingMenu.value ||
    showEncodingAction.value ||
    showLineEndingMenu.value ||
    showFileTypeMenu.value,
)

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
    </button>
    <!--
      登録せずに開いたディレクトリ（#230）。ここは保存されないので、そう言っておく。
      **押すと確認してから登録する**（#373）。プロジェクトパネルまで行かずに済ませられる
      唯一の入口で、以前は説明のツールチップだけだった。
      **上のボタンの中に置かない**: `<button>` の中の `<button>` は置けないし、`<span>` に
      クリックを付けると、押す場所が入れ子になっていることが読み取れない。
    -->
    <button
      v-if="projectStore.isTransient"
      class="status-item clickable transient-btn"
      data-testid="statusbar-register"
      :title="t('statusBar.transientRegisterHint')"
      @click="registerTransient"
    >
      <span class="missing-tag transient-tag">{{ t('statusBar.transient') }}</span>
    </button>

    <!-- キーボードマクロの記録中（#180）。止めるキーを忘れても、ここを押せば止まる。 -->
    <button
      v-if="macroRecording"
      class="status-item clickable macro-badge"
      data-testid="macro-recording"
      :title="t('macro.recordingTitle')"
      @click="toggleMacroRecording"
    >
      <Circle :size="10" :stroke-width="0" fill="currentColor" />
      {{ t('macro.recording') }}
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

    <!--
      右側は 4 つの組に分けて `|` で区切る（#383）。**区切りは後ろの組が描く**
      （`.status-group + .status-group::before`）ので、前の組が消えても区切りだけが残らない。
      最後の組（言語 + バージョン）だけは条件を持たず常に出る。
    -->
    <!-- Editor info -->
    <div v-if="editorInfo.current.value" class="status-group">
      <span class="status-text" :title="t('statusBar.cursorHint')">{{ t('statusBar.ln') }} {{ editorInfo.current.value.line }}, {{ t('statusBar.col') }} {{ editorInfo.current.value.col }}</span>
      <span class="status-text" :title="t('statusBar.spacesHint')">{{ t('statusBar.spaces') }} {{ editorInfo.current.value.tabSize }}</span>
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
    </div>

    <!-- Agents: one item for both Claude and Codex; the detail lives in the status tab (#226) -->
    <div v-if="hasAgentStatus" class="status-group status-dropdown-area">
      <button class="status-item clickable small cc-usage" :title="headlineTitle" @click="toggleAgentStatus">
        <Gauge :size="13" :stroke-width="2" />
        <!-- ログインが切れていたら、利用率より先にそれを出す（#381。古い数字は出さない） -->
        <span v-if="agentsNeedingLogin.length" class="rate-warn">{{ t('agentStatus.loginRequiredShort') }}</span>
        <template v-else-if="headlineMeters.length">
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
        <div v-for="{ agent, usage, needsLogin, meters } in agentRows" :key="agent.id" class="cc-agent">
          <div class="cc-agent-name">
            <Bot :size="12" :stroke-width="2" />
            <span>{{ agent.label }}</span>
          </div>
          <div v-if="needsLogin" class="cc-login">
            <AlertTriangle :size="12" :stroke-width="2" class="rate-warn" />
            <span>{{ t('agentStatus.loginRequired') }}</span>
            <button class="accent-btn cc-login-btn" :title="agent.login" @click="onLoginAgent(agent)">
              {{ t('agentStatus.login') }}
            </button>
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

    <!-- worktree / ブランチ / リポジトリは同じリポジトリの話なので 1 つの組にする。 -->
    <div v-if="hasRepoInfo" class="status-group">
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
        <button
          class="status-item clickable"
          data-testid="branch-selector"
          :title="t('statusBar.branchHint')"
          @click="openBranchSwitcher"
        >
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

      <!-- リポジトリはブランチの隣（#383）。 -->
      <button
        v-if="repoLink"
        class="status-item clickable github-btn"
        :title="t('statusBar.openProjectRepo', { provider: repoLink.label })"
        @click="openProjectRepo"
      >
        <component :is="repoIcon" :size="14" :stroke-width="1.5" />
      </button>
    </div>

    <div class="status-group">
      <!-- ダーク / ライト / システム追従を順に巡る（#407）。設定画面まで行かずに切り替えられる
           唯一の入口なので、言語の切り替えと並べて常に出す。 -->
      <button
        class="status-item clickable small"
        data-testid="theme-toggle"
        :title="themeTitle"
        @click="settingsStore.cycleThemeMode()"
      >
        <component :is="themeView.icon" :size="13" :stroke-width="2" />
      </button>
      <button class="status-item clickable small" :title="t('statusBar.languageHint')" @click="toggleLanguage">
        {{ settingsStore.language.toUpperCase() }}
      </button>
      <!-- 押すと Pike 自身の GitHub を開く（#383）。プロジェクトのリポジトリを開く
           上のボタンと紛れないよう、ツールチップで何のバージョンかを言う。 -->
      <button
        v-if="updater.appVersion.value"
        class="status-item clickable small version"
        :title="t('statusBar.pikeVersion', { version: updater.appVersion.value })"
        @click="openPikeRepo"
      >v{{ updater.appVersion.value }}{{ devHash }}</button>
    </div>
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

/* バッジ 1 つだけのボタン。左右の余白は中のバッジが持つので、ここでは詰める。 */
.transient-btn {
  padding: 0 4px;
}

.status-item.admin-badge {
  color: var(--warning, #d29922);
  font-weight: 600;
  cursor: default;
}

.status-item.clickable {
  cursor: pointer;
}

.status-item.macro-badge {
  color: var(--danger);
  font-weight: 600;
}

.status-item.clickable:hover {
  background: rgba(255, 255, 255, 0.12);
}

.spacer {
  flex: 1;
}

/* 右側の組（#383）。**区切りは後ろの組が描く**ので、前の組が消えたときに区切りだけが
   残らない。縦の中央は親の `align-items` で揃うが、組の中でも揃えておく（中身の
   font-size が 11px と 12px で混ざるため）。 */
.status-group {
  display: flex;
  align-items: center;
  height: 100%;
}

/* **区切りは流し込みの枠を占めない**（#383）。flex の子にすると、組がドロップダウンの
   器を兼ねているとき `position: absolute; left: 0` の中身が区切りのぶんだけ右にずれ、
   器をもう 1 枚かぶせる羽目になる。絶対配置なら組を分けずに済む（タブバーの
   `.tab-add-arrow` が `border-left` でやっているのと同じ「箱を占めない区切り」）。
   `~` なのは、表したいのが「先頭の組ではない」であって「隣り合っている」ではないため。 */
.status-group ~ .status-group {
  position: relative;
  margin-left: 13px;
}

.status-group ~ .status-group::before {
  content: "";
  position: absolute;
  left: -7px;
  top: 50%;
  transform: translateY(-50%);
  width: 1px;
  height: 12px;
  background: var(--border);
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

/* 淡く置いて、ホバーで戻す（#383）。隣の `.github-btn` と同じ対にしないと、並んだ
   2 つの淡色ボタンで押せることの見え方が割れる。 */
.version,
.github-btn {
  opacity: 0.5;
}

.version:hover,
.github-btn:hover {
  opacity: 1;
}

.github-btn {
  padding: 0 4px !important;
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
/* メニュー項目だけを全幅にする。**除外を名前で 1 つずつ増やさない**（#381）:
   `.detail-link` を除外し忘れたときは見出し行のリンクが幅いっぱいに広がって見出しを
   潰し、`.accent-btn` のときはログインボタンが全幅になって文言が 2 行に折れた。
   `.accent-btn` は「共有のボタン様式を当てたもの＝メニュー項目ではない」という印なので、
   ここで除けば次に足すボタンも自動的に外れる。 */
.status-dropdown button:not(.help-btn):not(.rate-refresh):not(.detail-link):not(.accent-btn) {
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

.status-dropdown button:not(.help-btn):not(.rate-refresh):not(.accent-btn):hover {
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

/* ログインが切れている知らせ（#381）。 */
.cc-login {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 12px;
  font-size: 11px;
  color: var(--text-primary);
}

.cc-login-btn {
  margin-left: auto;
  padding: 1px 8px;
  font-size: 11px;
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
