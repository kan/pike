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
} from 'vue'
import { useAnchoredPopup } from '../../composables/useAnchoredPopup'
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

import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Container,
  FilePlus,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListTree,
  Loader,
  Play,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-vue-next'
import { confirmDialog, infoDialog } from '../../composables/useConfirmDialog'
import { useProjectAccent } from '../../composables/useProjectAccent'
import { useShortcutsModal } from '../../composables/useShortcutsModal'
import { useUpdater } from '../../composables/useUpdater'
import { useI18n } from '../../i18n'
import { actionChord } from '../../lib/shortcuts'
import { openUrlWithConfirm } from '../../lib/tauri'
import { useDiagnosticsStore } from '../../stores/diagnostics'
import { useDockerStore } from '../../stores/docker'
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
const settingsStore = useSettingsStore()
const shortcutsModal = useShortcutsModal()
const showGearMenu = ref(false)
const updater = useUpdater()

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
  await openUrlWithConfirm('https://github.com/kan/pike')
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
}

const icons: IconDef[] = [
  { panel: 'files', labelKey: 'sidebar.files', icon: Files },
  { panel: 'outline', labelKey: 'sidebar.outline', icon: ListTree },
  {
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
  },
  { panel: 'search', labelKey: 'sidebar.search', icon: Search },
  {
    panel: 'diagnostics',
    labelKey: 'sidebar.diagnostics',
    icon: CircleAlert,
    badge: () => (diagStore.total > 0 ? { count: diagStore.total, danger: diagStore.errorCount > 0 } : null),
  },
  { panel: 'docker', labelKey: 'sidebar.docker', icon: Container },
  { panel: 'projects', labelKey: 'sidebar.projects', icon: FolderOpen },
  { panel: 'tasks', labelKey: 'sidebar.tasks', icon: Play },
]

/** panel → manual-relative help target (`page#anchor`). 全パネルを網羅する `Record` なので、
 *  パネルを足してマニュアルの行き先を書き忘れると型エラーになる（`?` ボタンだけ黙って
 *  出ない、を防ぐ）。 */
const PANEL_HELP: Record<SidebarPanel, string> = {
  files: 'panels.md#ファイルツリー',
  git: 'git.md',
  search: 'panels.md#検索ripgrep--grep',
  docker: 'panels.md#docker',
  projects: 'projects-and-windows.md',
  tasks: 'panels.md#タスク',
  outline: 'panels.md#アウトライン',
  diagnostics: 'panels.md#problems診断',
}
const panelHelp = computed(() => (sidebar.activePanel ? PANEL_HELP[sidebar.activePanel] : undefined))

/** panel → current badge/marker, recomputed once per reactive change (not per render). */
const badges = computed(() => {
  const map: Partial<Record<SidebarPanel, BadgeInfo | null>> = {}
  for (const item of icons) {
    if (item.badge) map[item.panel] = item.badge()
  }
  return map
})
const markers = computed(() => {
  const map: Partial<Record<SidebarPanel, MarkerInfo | null>> = {}
  for (const item of icons) {
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
    <nav class="icon-strip" :style="accentStyle">
      <button
        v-for="item in icons"
        :key="item.panel"
        class="icon-button"
        :class="{ active: sidebar.activePanel === item.panel }"
        :title="iconTitle(item)"
        @click="sidebar.togglePanel(item.panel)"
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
        <span class="panel-title">{{ t(icons.find((i) => i.panel === sidebar.activePanel)?.labelKey ?? '') }}</span>
        <div v-if="sidebar.activePanel === 'files'" class="header-actions">
          <button class="header-btn" :title="t('fileTree.newFile')" @click="fileTreeRef?.startCreateAtRoot('file')">
            <FilePlus :size="14" :stroke-width="2" />
          </button>
          <button class="header-btn" :title="t('fileTree.newFolder')" @click="fileTreeRef?.startCreateAtRoot('dir')">
            <FolderPlus :size="14" :stroke-width="2" />
          </button>
          <button class="header-btn" :title="t('common.refresh')" @click="fileTreeRef?.refresh()">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: fileTreeRef?.refreshing }" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'search'" class="header-actions">
          <span class="backend-badge">{{ searchStore.backend ?? '...' }}</span>
        </div>
        <div v-if="sidebar.activePanel === 'git'" class="header-actions">
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
          <button class="header-btn" :disabled="gitStore.refreshing" :title="t('common.refresh')" @click="gitStore.refreshAll()">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: gitStore.refreshing }" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'docker'" class="header-actions">
          <!-- compose up/down live on each compose file's group heading in the
               panel (#221): with several compose files there is no one target. -->
          <button class="header-btn" :disabled="dockerStore.refreshing" :title="t('common.refresh')" @click="dockerStore.refreshContainers(true)">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: dockerStore.refreshing }" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'tasks'" class="header-actions">
          <button class="header-btn" :title="t('common.refresh')" @click="tasksRef?.refresh()">
            <RefreshCw :size="14" :stroke-width="2" />
          </button>
        </div>
        <div v-if="sidebar.activePanel === 'diagnostics'" class="header-actions">
          <button class="header-btn" :disabled="diagStore.running" :title="t('common.refresh')" @click="diagStore.run()">
            <RefreshCw :size="14" :stroke-width="2" :class="{ spin: diagStore.running }" />
          </button>
        </div>
        <HelpButton v-if="panelHelp" :page="panelHelp" :size="15" class="panel-help" />
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
}

.icon-strip {
  grid-column: 1;
  grid-row: 1 / -1;
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  padding-top: 4px;
  padding-bottom: 4px;
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
  color: var(--text-active);
}

.sync-menu-item.danger {
  color: var(--danger);
}

.sync-menu-item.danger:hover {
  background: var(--danger);
  color: var(--text-active);
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
  color: var(--text-active);
}

.gear-menu-item:hover .ctx-key {
  color: rgba(255, 255, 255, 0.7);
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
}

.icon-button:hover {
  opacity: 1;
}

.icon-button.active {
  opacity: 1;
}

/* プロジェクトカラーの上では `--accent`（青）が下地とぶつかるので、読める側の色で描く。 */
.icon-button.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 25%;
  height: 50%;
  width: 2px;
  background: var(--icon-strip-fg, var(--accent));
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
  color: var(--text-active);
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

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
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
  color: #fff;
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
  color: #fff;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 8px;
}
</style>
