<script setup lang="ts">
import {
  type Component,
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  useTemplateRef,
  watch,
} from 'vue'
import { useAnchoredPopup } from '../../composables/useAnchoredPopup'
import { useDragAndDrop } from '../../composables/useDragAndDrop'
import { useDragResize } from '../../composables/useDragResize'
import { useGitStore } from '../../stores/git'
import { useSidebarStore } from '../../stores/sidebar'
import type { SidebarPanel } from '../../types/tab'

const ProjectPanel = defineAsyncComponent(() => import('../panels/ProjectPanel.vue'))
const FileTreePanel = defineAsyncComponent(() => import('../panels/FileTreePanel.vue'))
const GitPanel = defineAsyncComponent(() => import('../panels/GitPanel.vue'))
const DockerPanel = defineAsyncComponent(() => import('../panels/DockerPanel.vue'))
const SearchPanel = defineAsyncComponent(() => import('../panels/SearchPanel.vue'))
const TasksPanel = defineAsyncComponent(() => import('../panels/TasksPanel.vue'))
const OutlinePanel = defineAsyncComponent(() => import('../panels/OutlinePanel.vue'))
const DiagnosticsPanel = defineAsyncComponent(() => import('../panels/DiagnosticsPanel.vue'))
const IssuesPanel = defineAsyncComponent(() => import('../panels/IssuesPanel.vue'))
const BrowserPanel = defineAsyncComponent(() => import('../panels/BrowserPanel.vue'))

import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Container,
  FilePlus,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  List,
  ListTodo,
  ListTree,
  Loader,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-vue-next'
import { confirmDialog, infoDialog } from '../../composables/useConfirmDialog'
import { usePanelAvailability } from '../../composables/usePanelAvailability'
import { useProjectAccent } from '../../composables/useProjectAccent'
import { useShortcutsModal } from '../../composables/useShortcutsModal'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'
import { PIKE_REPO_URL } from '../../lib/manual'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { useOverlay } from '../../lib/overlay'
import { sideOf } from '../../lib/reorder'
import { actionChord } from '../../lib/shortcuts'
import { useDiagnosticsStore } from '../../stores/diagnostics'
import { useDockerStore } from '../../stores/docker'
import { useIssuesStore } from '../../stores/issues'
import { useSearchStore } from '../../stores/search'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import HelpButton from '../HelpButton.vue'
import ProjectSelect from './ProjectSelect.vue'

const { t } = useI18n()

/**
 * アイコン列にプロジェクトカラーを敷く（#298）。**アイコンの色も一緒に渡す**: 素の
 * `--text-secondary` は灰色なので、黄色や明るい緑の上では読めない。未設定なら何も渡さず、
 * CSS 側の既定（透過してサイドバーの `--bg-secondary` が出る）に落ちる。
 */
const accent = useProjectAccent()
const accentStyle = computed(() =>
  accent.bg.value ? { '--icon-strip-bg': accent.bg.value, '--icon-strip-fg': accent.fg.value } : {},
)
const sidebar = useSidebarStore()
const tabStore = useTabStore()
const gitStore = useGitStore()
const searchStore = useSearchStore()
const diagStore = useDiagnosticsStore()
const dockerStore = useDockerStore()
const issuesStore = useIssuesStore()
const { isPanelAvailable, isPanelRuledOut } = usePanelAvailability()
const settingsStore = useSettingsStore()
const shortcutsModal = useShortcutsModal()
const showGearMenu = ref(false)
const updater = useUpdater()

/**
 * 開いているパネルがそのプロジェクトで使えないなら、ファイルツリーへ逃がす（#353）。
 *
 * パネルの選択はマシンに 1 つ（`pike:activePanel`）なので、issue パネルを開いたまま
 * GitHub でないプロジェクトへ切り替えると、アイコンが消えたうえに「使えません」だけが
 * 残る。**ここが置き場**: サイドバーは自分の `activePanel` の持ち主で、プロジェクトを
 * 持たないウィンドウには居ない（居ても直す相手が無い）。
 *
 * **監視するのは判定そのもの**（プロジェクトの id ではなく）。あれを鍵にすると、origin を
 * 聞き終えて答えが出たときに再評価されない: 一時プロジェクトと初めて開くプロジェクトは
 * `project.remoteUrl` を持たないので、切り替えた瞬間にはまだ答えが出ていない。
 */
watch(
  () => !!sidebar.activePanel && isPanelRuledOut(sidebar.activePanel),
  (ruledOut) => {
    if (ruledOut) sidebar.fallbackPanel('files')
  },
  { immediate: true },
)

onMounted(() => {
  updater.checkOnceInBackground()
})

// Pull/push option menus (#179): right-clicking the header button offers the
// variants (`--rebase`, `--force-with-lease`, …) that the plain click can't.
// Positioned at the cursor with `position: fixed`, because `.panel` clips its
// children (`overflow: hidden`) and an absolutely-placed menu gets cut off at
// the panel edge. Same approach as the tab context menu.
const syncMenu = ref<{ kind: 'pull' | 'push' } | null>(null)
const {
  style: syncMenuStyle,
  placeAt: placeSyncMenu,
  reset: resetSyncMenu,
} = useAnchoredPopup(useTemplateRef<HTMLElement>('syncMenuEl'))

/** `danger` items confirm first — rewriting remote history is worth a second
 *  look. Each item carries its own call so pull and push share one menu. */
type SyncAction = { key: string; danger?: boolean; run: () => Promise<void> }

const PULL_ACTIONS: SyncAction[] = [
  { key: 'git.pullPlain', run: () => gitStore.pull() },
  { key: 'git.pullRebase', run: () => gitStore.pull(['rebase']) },
  { key: 'git.pullRebaseAutostash', run: () => gitStore.pull(['rebase', 'autostash']) },
  { key: 'git.pullFfOnly', run: () => gitStore.pull(['ff-only']) },
]
const PUSH_ACTIONS: SyncAction[] = [
  { key: 'git.pushPlain', run: () => gitStore.push() },
  { key: 'git.pushSetUpstream', run: () => gitStore.push(['set-upstream']) },
  { key: 'git.pushTags', run: () => gitStore.push(['tags']) },
  { key: 'git.pushForceWithLease', danger: true, run: () => gitStore.push(['force-with-lease']) },
]

const syncActions = computed(() => (syncMenu.value?.kind === 'push' ? PUSH_ACTIONS : PULL_ACTIONS))

async function openSyncMenu(which: 'pull' | 'push', e: MouseEvent) {
  resetSyncMenu()
  syncMenu.value = { kind: which }
  // Measured, then clamped (#204): these buttons sit at the bottom of the
  // sidebar, so the menu has to open upward on a short window.
  await placeSyncMenu({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', closeSyncMenu, { once: true })
}

function closeSyncMenu() {
  window.removeEventListener('mousedown', closeSyncMenu)
  syncMenu.value = null
  resetSyncMenu()
}

async function runSyncAction(action: SyncAction) {
  closeSyncMenu()
  if (action.danger && !(await confirmDialog(t('confirm.forcePush')))) return
  await action.run()
}

function onGearClick() {
  showGearMenu.value = !showGearMenu.value
  if (showGearMenu.value) {
    nextTick(() => {
      window.addEventListener('mousedown', closeGearMenu, { once: true })
    })
  } else {
    window.removeEventListener('mousedown', closeGearMenu)
  }
}

function closeGearMenu() {
  window.removeEventListener('mousedown', closeGearMenu)
  showGearMenu.value = false
}

function openShortcuts() {
  closeGearMenu()
  shortcutsModal.toggle()
}

function openSettings() {
  closeGearMenu()
  tabStore.addSettingsTab()
}

function openAgentStatus() {
  closeGearMenu()
  tabStore.addAgentStatusTab()
}

function openManual() {
  closeGearMenu()
  tabStore.addManualTab()
}

async function openGitHub() {
  closeGearMenu()
  await openUrlWithConfirm(PIKE_REPO_URL)
}

async function checkUpdate() {
  closeGearMenu()
  if (!updater.hasUpdate.value) {
    await updater.checkForUpdate()
  }
  if (updater.hasUpdate.value) {
    if (await confirmDialog(t('settings.updateConfirm', { version: updater.updateVersion.value }))) {
      await updater.downloadAndInstall()
    }
  } else if (updater.state.value === 'upToDate') {
    await infoDialog(t('settings.upToDate'))
  } else {
    await infoDialog(t('settings.updateError'))
  }
}

const fileTreeRef = ref<{
  refresh: () => void
  refreshing: boolean
  startCreateAtRoot: (type: 'file' | 'dir') => void
} | null>(null)
const tasksRef = ref<{ refresh: () => void } | null>(null)

interface BadgeInfo {
  count: number
  danger?: boolean
}
/** Small glyph in the icon's bottom-right corner, with a tooltip suffix. */
interface MarkerInfo {
  text: string
  title: string
}
interface IconDef {
  panel: SidebarPanel
  labelKey: string
  icon: Component
  /** Optional count badge resolver — returns null when nothing to show. */
  badge?: () => BadgeInfo | null
  /** Optional corner marker resolver — returns null when nothing to show. */
  marker?: () => MarkerInfo | null
  /**
   * ヘッダの更新ボタン。**表の行に持たせる**（`badge` / `marker` と同じ器）。以前は
   * 5 つのパネルが `header-btn` ＋ `RefreshCw` ＋ `spin` を逐語で書き写していて、
   * パネルを足すたびに 6 本目が増えていた。
   */
  refresh?: { run: () => void; busy?: () => boolean }
}

/**
 * パネルごとの行。**並びは持たない**（既定は `SIDEBAR_PANELS`、利用者の並びは設定の
 * `sidebarIcons`、#364）。全パネルを網羅する形なので、パネルを足して行を書き忘れると
 * 型エラーになり、値の `panel` がキーと食い違っても同じく落ちる。
 */
const ICONS: { [P in SidebarPanel]: IconDef & { panel: P } } = {
  files: {
    panel: 'files',
    labelKey: 'sidebar.files',
    icon: Files,
    refresh: { run: () => fileTreeRef.value?.refresh(), busy: () => !!fileTreeRef.value?.refreshing },
  },
  outline: { panel: 'outline', labelKey: 'sidebar.outline', icon: ListTree },
  git: {
    panel: 'git',
    labelKey: 'sidebar.git',
    icon: GitBranch,
    badge: () => {
      const s = gitStore.status
      if (!s) return null
      const n = s.staged.length + s.unstaged.length + s.conflicted.length
      return n > 0 ? { count: n, danger: s.conflicted.length > 0 } : null
    },
    // Unpushed / unpulled commits. The count badge is taken by the working-tree
    // change count, so this rides along as an arrow in the opposite corner.
    marker: () => {
      const s = gitStore.status
      if (!s) return null
      // A stopped rebase/merge outranks the arrows: a `git pull` that failed to
      // sign leaves no conflicts and no change count, so this is the only sign
      // of it while the panel is closed (#222).
      if (s.operation) return { text: '!', title: t(`git.op.${s.operation.kind}`) }
      if (!s.ahead && !s.behind) return null
      const parts: string[] = []
      if (s.ahead) parts.push(t('git.aheadInfo', { count: s.ahead }))
      if (s.behind) parts.push(t('git.behindInfo', { count: s.behind }))
      return { text: `${s.ahead ? '↑' : ''}${s.behind ? '↓' : ''}`, title: parts.join(' · ') }
    },
    refresh: { run: () => gitStore.refreshAll(), busy: () => gitStore.refreshing },
  },
  search: { panel: 'search', labelKey: 'sidebar.search', icon: Search },
  diagnostics: {
    panel: 'diagnostics',
    labelKey: 'sidebar.diagnostics',
    icon: CircleAlert,
    badge: () => (diagStore.total > 0 ? { count: diagStore.total, danger: diagStore.errorCount > 0 } : null),
    refresh: { run: () => diagStore.run(), busy: () => diagStore.running },
  },
  docker: {
    panel: 'docker',
    labelKey: 'sidebar.docker',
    icon: Container,
    // compose up/down はパネル内の compose ファイルごとの見出しにある（#221）:
    // compose が複数あると対象が一意に決まらないため、ここには置かない。
    refresh: { run: () => dockerStore.refreshContainers(true), busy: () => dockerStore.refreshing },
  },
  projects: { panel: 'projects', labelKey: 'sidebar.projects', icon: FolderOpen },
  tasks: {
    panel: 'tasks',
    labelKey: 'sidebar.tasks',
    icon: Play,
    refresh: { run: () => tasksRef.value?.refresh() },
  },
  issues: {
    panel: 'issues',
    labelKey: 'sidebar.issues',
    // GitHub の issue 記号（`CircleDot`）は他のアイコンに紛れて何のパネルか読めなかった
    // ので、TODO パネルが使っていたチェックリストに戻した（#278）。
    icon: ListTodo,
    refresh: { run: () => issuesStore.refresh(), busy: () => issuesStore.loading },
  },
  // ブラウザのタブのブックマークと閲覧履歴（#368）。タブの種別と同じアイコン。
  browser: { panel: 'browser', labelKey: 'sidebar.browser', icon: Globe },
}

/**
 * 利用者の並び（#364）で、このプロジェクトで使えるパネル。非表示のものも含む（右クリックの
 * 一覧は、隠したものを戻す入口でもあるため）。
 */
const orderedIcons = computed(() =>
  settingsStore.sidebarIcons.flatMap((s) =>
    isPanelAvailable(s.panel) ? [{ def: ICONS[s.panel] as IconDef, hidden: s.hidden }] : [],
  ),
)

/** アイコン列に実際に並べるもの（隠したものを除く）。パネルの見出しは `ICONS` を
 *  直に引くので、隠れているパネルをパレットから開いても名前が出る。 */
const navIcons = computed(() => orderedIcons.value.filter((i) => !i.hidden).map((i) => i.def))

// --- 並べ替えと非表示（#364） ------------------------------------------------
// 非表示はアイコン列から外すだけで、パネルそのものは使える（パレットや `Ctrl+Shift+F` の
// 入口は残す）。利用者が選んで隠したものを、明示的に開きに来た操作まで止める理由が無い。
const { dragId: iconDragId, startDrag: startIconDrag, resetDrag: resetIconDrag } = useDragAndDrop<SidebarPanel>()
const iconDrop = ref<{ panel: SidebarPanel; side: 'top' | 'bottom' } | null>(null)

function onIconDragOver(e: DragEvent, panel: SidebarPanel) {
  if (!iconDragId.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const side = sideOf(e)
  // dragover は連続して届くので、変わったときだけ書く（毎回書くとアイコン列が描き直される）。
  if (iconDrop.value?.panel !== panel || iconDrop.value.side !== side) iconDrop.value = { panel, side }
}

function onIconDrop(panel: SidebarPanel) {
  const moved = iconDragId.value
  const side = iconDrop.value?.side ?? 'top'
  endIconDrag()
  if (moved && moved !== panel) settingsStore.moveSidebarIcon(moved, panel, side)
}

function endIconDrag() {
  resetIconDrag()
  iconDrop.value = null
}

/** 右クリックしたアイコン（空いたところなら null）。null でなければメニューが開いている。 */
const iconMenu = ref<{ panel: SidebarPanel | null } | null>(null)
// 手前に浮くものは数える（#396。ブラウザのタブの子 webview を隠すため）。
useOverlay(() => showGearMenu.value || syncMenu.value !== null || iconMenu.value !== null)
const {
  style: iconMenuStyle,
  placeAt: placeIconMenu,
  reset: resetIconMenu,
} = useAnchoredPopup(useTemplateRef<HTMLElement>('iconMenuEl'))

async function openIconMenu(e: MouseEvent, panel: SidebarPanel | null) {
  resetIconMenu()
  iconMenu.value = { panel }
  await placeIconMenu({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', closeIconMenu, { once: true })
}

function closeIconMenu() {
  window.removeEventListener('mousedown', closeIconMenu)
  iconMenu.value = null
  resetIconMenu()
}

function setIconHidden(panel: SidebarPanel, hidden: boolean) {
  closeIconMenu()
  settingsStore.setSidebarIconHidden(panel, hidden)
}

/**
 * **新しく**隠れたパネルが開いていたら閉じる。開いたままだと、アイコンの無いパネルが残って
 * 閉じる入口が見えなくなる。操作したウィンドウだけでなく、ブロードキャストや同期で届いた
 * ウィンドウでも閉じるよう、呼び出し側ではなく設定の変化を見る。
 *
 * **「隠れているパネルが開いている」を条件にしないこと**: パレットで隠したパネルを開いた
 * 瞬間に閉じてしまう（隠したパネルも使える、という方針に反する）。
 */
watch(
  () => settingsStore.sidebarIcons,
  (now, prev) => {
    const open = sidebar.activePanel
    if (!open) return
    const hiddenNow = now.some((i) => i.panel === open && i.hidden)
    const hiddenBefore = prev.some((i) => i.panel === open && i.hidden)
    if (hiddenNow && !hiddenBefore) sidebar.setPanel(null)
  },
)

function resetIcons() {
  closeIconMenu()
  settingsStore.resetSidebarIcons()
}

/** 今開いているパネルの行（見出し・更新ボタンが読む）。 */
const activeIcon = computed<IconDef | undefined>(() => (sidebar.activePanel ? ICONS[sidebar.activePanel] : undefined))

/** panel → manual-relative help target (`page#anchor`). 全パネルを網羅する `Record` なので、
 *  パネルを足してマニュアルの行き先を書き忘れると型エラーになる（`?` ボタンだけ黙って
 *  出ない、を防ぐ）。 */
const PANEL_HELP: Record<SidebarPanel, string> = {
  files: 'panels.md#ファイルツリー',
  git: 'git.md',
  search: 'panels.md#検索ripgrep--grep',
  docker: 'panels.md#docker',
  projects: 'projects-and-windows.md',
  tasks: 'panels.md#タスクランナー',
  outline: 'panels.md#アウトライン',
  diagnostics: 'panels.md#problems診断',
  issues: 'panels.md#issuegithub',
  browser: 'browser.md#ブラウザパネル',
}
const panelHelp = computed(() => (sidebar.activePanel ? PANEL_HELP[sidebar.activePanel] : undefined))

/** panel → current badge/marker, recomputed once per reactive change (not per render). */
const badges = computed(() => {
  const map: Partial<Record<SidebarPanel, BadgeInfo | null>> = {}
  for (const item of Object.values<IconDef>(ICONS)) {
    if (item.badge) map[item.panel] = item.badge()
  }
  return map
})
const markers = computed(() => {
  const map: Partial<Record<SidebarPanel, MarkerInfo | null>> = {}
  for (const item of Object.values<IconDef>(ICONS)) {
    if (item.marker) map[item.panel] = item.marker()
  }
  return map
})

function iconTitle(item: IconDef) {
  const base = t(item.labelKey)
  const marker = markers.value[item.panel]
  return marker ? `${base} (${marker.title})` : base
}

let startWidth = 0

const { start: onResizeStart } = useDragResize({
  onStart: () => {
    startWidth = sidebar.panelWidth
  },
  // The sidebar carries the UI zoom, so a viewport-px mouse delta corresponds to
  // delta / zoom logical px on the (zoomed) panel width.
  onMove: (dx) => sidebar.setPanelWidth(startWidth + dx / settingsStore.uiZoom),
})

onUnmounted(() => {
  window.removeEventListener('mousedown', closeGearMenu)
})
</script>

<template>
  <div class="sidebar ui-zoom">
    <!--
      プロジェクトの表示と切替（#298）。**パネルが開いているときだけここに出す**: 畳んだ
      サイドバーは 48px しかなく名前が読めないので、そのあいだは `TabPane` が横幅の空いた
      タブバーの左に同じ部品を出す。
    -->
    <ProjectSelect v-if="sidebar.isPanelOpen" class="sidebar-project" />
    <!--
      プロジェクトカラー（#121）はここに敷く（#298）。ウィンドウ左端の 3px の線だったものを
      面に広げたもので、隣のプロジェクトバーと同じ色になるので 2 つで 1 つの帯に見える。
    -->
    <nav class="icon-strip" :style="accentStyle" @contextmenu.prevent="openIconMenu($event, null)">
      <button
        v-for="item in navIcons"
        :key="item.panel"
        class="icon-button"
        :class="{
          active: sidebar.activePanel === item.panel,
          dragging: iconDragId === item.panel,
          'drop-top': iconDrop?.panel === item.panel && iconDrop.side === 'top',
          'drop-bottom': iconDrop?.panel === item.panel && iconDrop.side === 'bottom',
        }"
        :title="iconTitle(item)"
        draggable="true"
        @click="sidebar.togglePanel(item.panel)"
        @contextmenu.prevent.stop="openIconMenu($event, item.panel)"
        @dragstart="startIconDrag($event, item.panel)"
        @dragover="onIconDragOver($event, item.panel)"
        @drop.prevent="onIconDrop(item.panel)"
        @dragend="endIconDrag"
      >
        <component :is="item.icon" :size="22" :stroke-width="1.5" class="icon" />
        <span
          v-if="badges[item.panel]"
          class="count-badge"
          :class="{ danger: badges[item.panel]?.danger }"
        >{{ badges[item.panel]?.count }}</span>
        <span v-if="markers[item.panel]" class="marker-badge">{{ markers[item.panel]?.text }}</span>
      </button>
      <div class="icon-spacer" />
      <div class="gear-wrapper">
        <div v-if="showGearMenu" class="gear-menu popup-surface" @mousedown.stop>
          <button class="gear-menu-item" @click="checkUpdate">
            <span>{{ t('settings.checkUpdate') }}</span>
            <span v-if="updater.hasUpdate.value" class="update-badge">NEW</span>
          </button>
          <div class="gear-menu-divider" />
          <button class="gear-menu-item" @click="openShortcuts">
            <span>{{ t('sidebar.keyboardShortcuts') }}</span>
            <span class="ctx-key">{{ actionChord('shortcuts') }}</span>
          </button>
          <button class="gear-menu-item" @click="openSettings">
            <span>{{ t('sidebar.settings') }}</span>
            <span class="ctx-key">{{ actionChord('settings') }}</span>
          </button>
          <button class="gear-menu-item" @click="openAgentStatus">
            <span>{{ t('agentStatus.title') }}</span>
          </button>
          <div class="gear-menu-divider" />
          <button class="gear-menu-item" @click="openManual">
            <span>{{ t('sidebar.manual') }}</span>
            <span class="ctx-key">F1</span>
          </button>
          <button class="gear-menu-item" @click="openGitHub">
            <span>{{ t('sidebar.github') }}</span>
          </button>
        </div>
        <button
          class="icon-button"
          :title="t('sidebar.settings')"
          @click="onGearClick"
        >
          <Settings :size="22" :stroke-width="1.5" class="icon" />
          <span v-if="updater.hasUpdate.value" class="update-dot" />
        </button>
      </div>
    </nav>
    <aside v-if="sidebar.isPanelOpen" class="panel" :style="{ width: sidebar.panelWidth + 'px' }">
      <div class="panel-header">
        <span class="panel-title">{{ t(activeIcon?.labelKey ?? '') }}</span>
        <!--
          右側は **1 つの `.header-actions` にまとめる**。`.panel-header` は
          `justify-content: space-between` なので、兄弟が 3 つ以上になるとパネル固有の
          ボタンと更新ボタンのあいだに隙間が開く。
        -->
        <div class="header-actions">
          <template v-if="sidebar.activePanel === 'files'">
            <button class="header-btn" :title="t('fileTree.newFile')" @click="fileTreeRef?.startCreateAtRoot('file')">
              <FilePlus :size="14" :stroke-width="2" />
            </button>
            <button class="header-btn" :title="t('fileTree.newFolder')" @click="fileTreeRef?.startCreateAtRoot('dir')">
              <FolderPlus :size="14" :stroke-width="2" />
            </button>
          </template>
          <!-- 版はツールチップで（#376 でパネルの中の重複した表示を外したので、版はここだけが出す。
               WSL は distro の rg を使うので、どの版かで出せる機能が変わる。#304） -->
          <span
            v-if="sidebar.activePanel === 'search'"
            class="backend-badge"
            :title="searchStore.backendInfo?.version ?? ''"
          >{{ searchStore.backend ?? '...' }}</span>
          <template v-if="sidebar.activePanel === 'issues' && issuesStore.visible">
            <!-- 作成は Pike の中で持たないので、ブラウザの新規 issue ページへ逃がす。 -->
            <button
              v-if="issuesStore.newIssueUrl"
              class="header-btn"
              :title="t('issues.newIssue')"
              @click="openUrlWithConfirm(issuesStore.newIssueUrl)"
            >
              <Plus :size="14" :stroke-width="2" />
            </button>
            <!-- 全展開 / 全畳み。畳める親が 1 つも無ければ押しても何も起きないので出さない。 -->
            <button
              v-if="issuesStore.view === 'tree' && issuesStore.collapseAction"
              class="header-btn"
              :title="t(issuesStore.collapseAction === 'collapse' ? 'issues.collapseAll' : 'issues.expandAll')"
              @click="issuesStore.toggleAll()"
            >
              <ChevronsDownUp v-if="issuesStore.collapseAction === 'collapse'" :size="14" :stroke-width="2" />
              <ChevronsUpDown v-else :size="14" :stroke-width="2" />
            </button>
            <!-- ツリー ⇄ フラット。アイコンは**今の表示**（押すと切り替わる）。 -->
            <button
              class="header-btn"
              :title="t(issuesStore.view === 'tree' ? 'issues.viewTree' : 'issues.viewFlat')"
              @click="issuesStore.setView(issuesStore.view === 'tree' ? 'flat' : 'tree')"
            >
              <ListTree v-if="issuesStore.view === 'tree'" :size="14" :stroke-width="2" />
              <List v-else :size="14" :stroke-width="2" />
            </button>
          </template>
          <template v-if="sidebar.activePanel === 'git'">
            <button
              class="header-btn"
              :class="{ primary: gitStore.status?.behind }"
              :disabled="gitStore.pulling"
              :title="t('git.pullHint')"
              @click="gitStore.pull()"
              @contextmenu.prevent="openSyncMenu('pull', $event)"
            >
              <Loader v-if="gitStore.pulling" :size="14" :stroke-width="2" class="spin" />
              <ArrowDown v-else :size="14" :stroke-width="2" />
            </button>
            <button
              class="header-btn"
              data-testid="git-push"
              :class="{ primary: gitStore.status?.ahead }"
              :disabled="gitStore.pushing"
              :title="t('git.pushHint')"
              @click="gitStore.push()"
              @contextmenu.prevent="openSyncMenu('push', $event)"
            >
              <Loader v-if="gitStore.pushing" :size="14" :stroke-width="2" class="spin" />
              <ArrowUp v-else :size="14" :stroke-width="2" />
            </button>
          </template>
          <!-- 更新ボタンは表（`IconDef.refresh`）から。理由はその宣言の doc。 -->
          <button
            v-if="activeIcon?.refresh"
            class="header-btn"
            :disabled="activeIcon.refresh.busy?.()"
            :title="t('common.refresh')"
            @click="activeIcon.refresh.run()"
          >
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: activeIcon.refresh.busy?.() }" />
          </button>
          <HelpButton v-if="panelHelp" :page="panelHelp" :size="15" class="panel-help" />
        </div>
      </div>
      <div class="panel-content">
        <ProjectPanel v-if="sidebar.activePanel === 'projects'" />
        <FileTreePanel v-else-if="sidebar.activePanel === 'files'" ref="fileTreeRef" />
        <GitPanel v-else-if="sidebar.activePanel === 'git'" />
        <SearchPanel v-else-if="sidebar.activePanel === 'search'" />
        <DockerPanel v-else-if="sidebar.activePanel === 'docker'" />
        <TasksPanel v-else-if="sidebar.activePanel === 'tasks'" ref="tasksRef" />
        <OutlinePanel v-else-if="sidebar.activePanel === 'outline'" />
        <DiagnosticsPanel v-else-if="sidebar.activePanel === 'diagnostics'" />
        <IssuesPanel v-else-if="sidebar.activePanel === 'issues'" />
        <BrowserPanel v-else-if="sidebar.activePanel === 'browser'" />
        <span v-else class="placeholder">{{ sidebar.activePanel }} panel (coming soon)</span>
      </div>
      <div class="resize-handle drag-x-handle" @mousedown="onResizeStart"></div>
    </aside>

    <!-- Pull/push options (#179). Outside .panel so its overflow can't clip it. -->
    <div
      v-if="syncMenu"
      ref="syncMenuEl"
      class="sync-menu popup-surface"
      data-testid="sync-menu"
      :style="syncMenuStyle"
      @mousedown.stop
    >
      <button
        v-for="a in syncActions"
        :key="a.key"
        class="sync-menu-item"
        :class="{ danger: a.danger }"
        @click="runSyncAction(a)"
      >
        {{ t(a.key) }}
      </button>
    </div>

    <!-- アイコン列の右クリック（#364）。隠したアイコンを戻す入口もここだけなので、
         空いたところを右クリックしても開く。 -->
    <div
      v-if="iconMenu"
      ref="iconMenuEl"
      class="panel-ctx-menu icon-menu popup-surface"
      data-testid="sidebar-icon-menu"
      :style="iconMenuStyle"
      @mousedown.stop
    >
      <template v-if="iconMenu.panel">
        <button @click="setIconHidden(iconMenu.panel, true)">
          {{ t('sidebar.hideIcon', { name: t(ICONS[iconMenu.panel].labelKey) }) }}
        </button>
        <div class="ctx-separator" />
      </template>
      <button v-for="i in orderedIcons" :key="i.def.panel" class="icon-menu-item" @click="setIconHidden(i.def.panel, !i.hidden)">
        <Check :size="14" :class="{ invisible: i.hidden }" />
        <span>{{ t(i.def.labelKey) }}</span>
      </button>
      <div class="ctx-separator" />
      <button @click="resetIcons">{{ t('sidebar.resetIcons') }}</button>
    </div>
  </div>
</template>

<style scoped>
/* 2 列 2 行の grid。**アイコン列は上まで通し**（`grid-row: 1 / -1`）、プロジェクトバー
   （#298）はその右、パネルの真上に置く。こうするとパネルの開閉でアイコンの位置が動かない。
   **flex の行に包み直さない**: 包むとテンプレートの 130 行を字下げし直すことになるだけで、
   得るものが同じ。パネルを閉じているときは 2 列目の中身が無く、幅 0 の列が残るだけ。 */
.sidebar {
  display: grid;
  grid-template-columns: auto auto;
  grid-template-rows: auto 1fr;
  height: 100%;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border);
}

/* **列の幅を決めるのは `.panel` だけにする。** `auto` の列は中身の max-content で広がるので、
   素のままだと長いプロジェクト名がパネルより広い列を作り、パネルの右に死んだ帯が残る
   （`.panel` は明示 width を持つので stretch されない）うえ、`right: -3px` のリサイズ
   ハンドルもサイドバーの右端から離れる。`width: 0` で列幅への寄与を消し、`min-width: 100%`
   で決まった列いっぱいに伸ばす。名前は `.project-name` の ellipsis で切れる。 */
.sidebar-project {
  grid-column: 2;
  grid-row: 1;
  width: 0;
  min-width: 100%;
  border-bottom: 1px solid var(--border);
  /* アイコン列との区切り（#378）。**アイコン列側に `border-right` を置かないこと**:
     パネルを閉じているとこの列ごと無くなるので、`.sidebar` の右端の線と並んで
     二重線になる。2 列目の側に置けば、列があるときだけ出る。 */
  border-left: 1px solid var(--border);
}

.icon-strip {
  grid-column: 1;
  grid-row: 1 / -1;
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  /* **上に隙間を作らない**（#378）。プロジェクトの帯（`.sidebar-project`）と高さが
     揃わず、1 つ目のアイコンだけ下がって見えていた。下は余白のままにする。 */
  padding-bottom: 4px;
  /* 選択中の印（左の縦線と背景）の高さ。線と背景がここ 1 つを読む。
     **ボタン（`--sidebar-width` の正方形）から左右と同じ `--icon-active-inset` を引いた
     値にする**ので、背景は四辺とも同じ余白＝正方形になる。固定の px にすると、列幅を
     変えたときに縦だけ取り残されて長方形に戻る。 */
  --icon-active-inset: 4px;
  --icon-active-size: calc(var(--sidebar-width) - var(--icon-active-inset) * 2);
  /* Window transparency (issue #162): the parent .sidebar already paints
     --bg-secondary, so painting it again here stacked a second translucent layer
     and made the icon bar look heavier than the panels. Inherit the sidebar
     background instead of doubling it.
     プロジェクトカラー（#298）を設定しているときだけ、その色で塗り替える。**そのときも
     `--surface-alpha` で合成する**: 生の hex をそのまま敷くと、透過・アクリル（#162）の
     ときにアイコン列だけ不透明な板になる（上の注意と同じ穴の裏返し）。 */
  background: color-mix(in srgb, var(--icon-strip-bg, transparent) calc(var(--surface-alpha) * 100%), transparent);
}

.icon-spacer {
  flex: 1;
}

.gear-wrapper {
  position: relative;
}

/* Pull/push option menu (#179). Fixed to the cursor rather than anchored to the
   button: `.panel` has `overflow: hidden`, which clips an absolutely-positioned
   menu at the panel edge (it disappeared under the icon rail). */
.sync-menu {
  position: fixed;
  white-space: nowrap;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  z-index: 1000;
}

.sync-menu-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.sync-menu-item:hover {
  background: var(--accent);
  color: var(--on-accent);
}

.sync-menu-item.danger {
  color: var(--danger);
}

.sync-menu-item.danger:hover {
  background: var(--danger);
  color: var(--on-accent);
}

.gear-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  white-space: nowrap;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  z-index: 1000;
}

.gear-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.gear-menu-item:hover {
  background: var(--accent);
  color: var(--on-accent);
}

.gear-menu-item:hover .ctx-key {
  color: var(--on-accent-muted);
}

.gear-menu-item .ctx-key {
  margin-left: 16px;
}

.icon-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--sidebar-width);
  height: var(--sidebar-width);
  border: none;
  background: transparent;
  cursor: pointer;
  position: relative;
  opacity: 0.6;
  transition: opacity 0.15s;
  /* **選択中の背景（`.active::after`）が `z-index: -1` を使うので、ここで囲っておく**（#378）。
     負の z-index は「いちばん近い stacking context の背景の上」に描かれるだけで、その
     context を作っていない祖先の背景より前には出ない。`position: relative` だけでは
     context にならず、`opacity` も 1 では作らない（非選択の 0.6 のときだけ偶然できる＝
     **背景を出したい選択中にかぎって効かない**）。実際、入れた当初は `.sidebar` の
     `--bg-secondary` の裏に描かれて一度も見えていなかった。 */
  isolation: isolate;
}

.icon-button:hover {
  opacity: 1;
}

.icon-button.active {
  opacity: 1;
}

/* ドラッグでの並べ替え（#364）。落とす位置は上下の端の線で示す（タブバーと同じ）。 */
.icon-button.dragging {
  opacity: 0.3;
}

.icon-button.drop-top {
  box-shadow: inset 0 2px 0 var(--icon-strip-fg, var(--accent));
}

.icon-button.drop-bottom {
  box-shadow: inset 0 -2px 0 var(--icon-strip-fg, var(--accent));
}

/* チェックの列を揃える（隠れているものは印だけ消して、幅は残す）。 */
.icon-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.icon-menu-item .invisible {
  visibility: hidden;
}

/* プロジェクトカラーの上では `--accent`（青）が下地とぶつかるので、読める側の色で描く。 */
.icon-button.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  height: var(--icon-active-size);
  width: 2px;
  background: var(--icon-strip-fg, var(--accent));
}

/* 背景のハイライト（#378）。**同じ色を薄く敷く**ので、プロジェクトカラーを設定して
   いるときもそのまま成立する（`--tab-hover-bg` のような固定色だと下地とぶつかる）。
   **`z-index: -1` が要る**: 擬似要素は中身より後に描かれるので、そのままだとアイコンに
   かぶる。**効くのは `.icon-button` の `isolation: isolate` と対で**（理由はあちらの隣）。 */
.icon-button.active::after {
  content: "";
  position: absolute;
  z-index: -1;
  left: var(--icon-active-inset);
  right: var(--icon-active-inset);
  top: 50%;
  transform: translateY(-50%);
  height: var(--icon-active-size);
  border-radius: 4px;
  background: color-mix(in srgb, var(--icon-strip-fg, var(--accent)) 14%, transparent);
}

/* 色を敷いているあいだは `readableTextOn` が選んだ黒か白。非アクティブとの差は
   `.icon-button` の `opacity` が付けるので、ここは 1 色で足りる。 */
.icon {
  color: var(--icon-strip-fg, var(--text-secondary));
}

.icon-button.active .icon {
  color: var(--icon-strip-fg, var(--text-active));
}

.panel {
  grid-column: 2;
  grid-row: 2;
  position: relative;
  border-right: 1px solid var(--border);
  /* アイコン列との区切り（#378）。理由は `.sidebar-project` の同じ指定の隣。 */
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}

.panel-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-help {
  margin-left: 2px;
}

.header-actions {
  display: flex;
  gap: 2px;
}

.header-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-btn:hover:not(:disabled) {
  background: var(--tab-hover-bg);
  color: var(--text-active);
}

.header-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.header-btn .spin {
  animation: spin 1s linear infinite;
}

.header-btn.primary {
  background: var(--accent);
  color: var(--on-accent);
  opacity: 1;
}

.header-btn.primary:hover:not(:disabled) {
  background: var(--accent);
  opacity: 0.85;
}

.backend-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  text-transform: lowercase;
}

/*
 * パネルの中身（#396）。**`auto` ではなく `scroll` にして、右の padding からレールぶんを
 * 引く。** `auto` だと、スクロールバーが出た瞬間に右の余白がレール（6px）ぶん増えて
 * 「右だけ太い」状態になる（`.diff-tab` の横スクロールの帯が `scroll` なのと同じ事情）。
 * 常にレールを確保しておけば、出ていても出ていなくても本文の右端からパネルの端までは
 * 12px で変わらない。トラックは透明なので、スクロールしない一覧でレールは見えない。
 * 代償は、スクロールしないときも幅が 6px 狭くなること。
 */
.panel-content {
  flex: 1;
  overflow-y: scroll;
  padding: var(--panel-pad) var(--scrollbar-size) var(--panel-pad) var(--panel-pad);
}

/* 見た目（カーソル・ホバー）は `theme.css` の `.drag-x-handle` と共有する。 */
.resize-handle {
  position: absolute;
  right: -3px;
  top: 0;
  width: 6px;
  height: 100%;
  z-index: 10;
}

.placeholder {
  color: var(--text-secondary);
  font-size: 12px;
}

.update-dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f44336;
  pointer-events: none;
}

.count-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  box-sizing: border-box;
  border-radius: 8px;
  /* 下地がプロジェクトカラーのときは、その上で読める側の色を地にして反転させる
     （灰色の丸だと色によって沈む）。 */
  background: var(--icon-strip-fg, var(--text-secondary));
  color: var(--icon-strip-bg, var(--bg-secondary));
  font-size: 9px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  pointer-events: none;
}

.marker-badge {
  position: absolute;
  bottom: 3px;
  right: 5px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -1px;
  color: var(--icon-strip-fg, var(--accent));
  pointer-events: none;
}

.count-badge.danger {
  background: #f44336;
  color: var(--on-accent);
}

.gear-menu-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.update-badge {
  font-size: 9px;
  font-weight: 700;
  background: #f44336;
  color: var(--on-accent);
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 8px;
}
</style>
