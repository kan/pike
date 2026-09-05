<script setup lang="ts">
/**
 * 1 つのペインのタブバー（#308 で `TabPane.vue` から切り出した）。
 *
 * **作業領域を分割すると 2 本になる**ので、溢れ判定・タブの一覧・シェルのプルダウン・
 * コンテキストメニューはこのコンポーネントごとに 1 組ずつ持つ。ペインをまたぐドラッグ
 * だけは 2 本で 1 つの状態を共有する（`composables/useTabDrag.ts`）。
 *
 * **ここから開くタブが自分のペインに入るのは、バーごとの細工ではなく `TabPane` の
 * `mousedown.capture` による**。バーは `.pane` の内側にあり、あちらが click より先に
 * `focusPane` を済ませているので、押した側のペインが必ず `focusedPane` になっている。
 * **マウスを伴わない経路だけが自分で言う必要がある**（OS からのファイルドロップ）。
 */

import { Check, ChevronDown, Columns2, Plus, ShieldPlus } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useAnchoredPopup } from '../../composables/useAnchoredPopup'
import { useAppActions } from '../../composables/useAppActions'
import { openFileTarget } from '../../composables/useCliOpen'
import { useShortcutsModal } from '../../composables/useShortcutsModal'
import { useTabDrag } from '../../composables/useTabDrag'
import { useI18n } from '../../i18n'
import { canResolveDroppedPaths, resolveDroppedPaths } from '../../lib/dropPaths'
import { SHELL_KIND_ICONS } from '../../lib/shellIcons'
import { actionChord } from '../../lib/shortcuts'
import { TAB_KIND_ICONS, tabFileIconSvg } from '../../lib/tabIcons'
import { tabDisplayTitle } from '../../lib/tabTitle'
import { detectWslDistros, openElevatedTerminal } from '../../lib/tauri'
import { elevated, globalMode } from '../../lib/window'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useSidebarStore } from '../../stores/sidebar'
import { useTabStore } from '../../stores/tabs'
import type { PaneId, ShellType, Tab } from '../../types/tab'
import { canReorderTabs, isWindowsShell, shellId, shellProfileLabel } from '../../types/tab'
import HelpButton from '../HelpButton.vue'
import ProjectSelect from './ProjectSelect.vue'
import TabItem from './TabItem.vue'

/**
 * WSL の distro を 1 度だけ探す（#129）。**モジュール単位で持つ**: 分割するとバーが
 * 2 本になるので、コンポーネントごとの掛け金だと `wsl.exe -l` の起動と
 * `syncShellProfiles` がペインの数だけ走る。ウィンドウごとに JS コンテキストが
 * 分かれるので、これで「ウィンドウにつき 1 回」になる。
 */
let distrosRequested = false

const props = defineProps<{ pane: PaneId }>()

const { t } = useI18n()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const sidebar = useSidebarStore()
const settings = useSettingsStore()

const pinnedTabs = computed(() => tabStore.pinnedTabsIn(props.pane))
const unpinnedTabs = computed(() => tabStore.unpinnedTabsIn(props.pane))
const paneTabs = computed(() => tabStore.tabsIn(props.pane))
/** このペインで選んでいるタブ。フォーカスが反対側にあっても強調は残す。 */
const activeId = computed(() => tabStore.activeInPane(props.pane))
const focused = computed(() => tabStore.focusedPane === props.pane)

/**
 * タブの横スクロール（#281）。溢れたぶんは隠れるだけだったので、開いたばかりのタブが
 * 右の外に出ていることに気付けなかった。
 */
const tabsScrollRef = useTemplateRef<HTMLElement>('tabsScrollRef')
const tabsPinnedRef = useTemplateRef<HTMLElement>('tabsPinnedRef')
/** タブが収まりきっていない（スクロールバーと一覧ボタンを出す条件）。 */
const tabsOverflow = ref(false)

/**
 * **固定タブの列も見る（#305）。** あちらはスクロールせず、上限を超えたぶんは
 * `overflow: hidden` で隠れるだけなので、一覧の `▾` が唯一の行き先になる。スクロール列
 * だけを測っていたころは、固定タブを何枚も留めて普通のタブが少ない状態で、隠れたタブへ
 * マウスで辿り着けなかった。
 */
function updateTabOverflow() {
  // 収まっていても 1px 足りないことがある（小数の幅）ので余裕を持たせる。
  const clipped = (el: HTMLElement | null) => !!el && el.scrollWidth > el.clientWidth + 1
  tabsOverflow.value = clipped(tabsScrollRef.value) || clipped(tabsPinnedRef.value)
}

/**
 * 縦ホイールを横スクロールに変換する。タブバーは縦に 1 行しかないので、そのままでは
 * ホイールが何もしない。**横成分を持つ入力には触らない**（タッチパッドの横スワイプや
 * 横チルトはブラウザの既定でそのまま動く）。
 */
function onTabsWheel(e: WheelEvent) {
  const el = tabsScrollRef.value
  if (!el || !tabsOverflow.value || e.deltaX !== 0 || e.deltaY === 0) return
  e.preventDefault()
  el.scrollLeft += e.deltaY
}

/**
 * アクティブなタブを見える位置へ送る（#281）。新しいタブは開いた時点でアクティブになるので、
 * これが「開いたタブが右に見切れる」の答えでもある。
 *
 * `nearest` は「必要な分だけ動かす」意味で、既に見えている祖先は動かさない（ファイルツリー・
 * アウトライン・QuickOpen が同じ書き方をしている）。縦は 1 行なので `block` は不活性。
 */
async function revealActiveTab() {
  await nextTick()
  const id = activeId.value
  if (!id) return
  const el = tabsScrollRef.value?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)
  el?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
}

/**
 * 溢れたタブの一覧（#281）。VSCode が「開いているエディター」でやっていることを、`+` の
 * 左のボタンに寄せた形。**隠れているものだけに絞らず全部出す**: 絞ると押すたびに中身が
 * 変わり、同じタブが列のどこにあるか覚えられない。
 */
const showTabMenu = ref(false)

function toggleTabMenu() {
  if (showTabMenu.value) {
    closeTabMenu()
    return
  }
  showTabMenu.value = true
  nextTick(() => {
    window.addEventListener('mousedown', closeTabMenu, { once: true })
  })
}

function closeTabMenu() {
  window.removeEventListener('mousedown', closeTabMenu)
  showTabMenu.value = false
}

function pickTab(id: string) {
  closeTabMenu()
  tabStore.setActiveTab(id)
}

// **ピン留めの解除でも送り直す（#305）。** 解除するとそのタブはスクロール列の、`tabs` の
// 順に応じた位置へ移るので、タブが多いと画面外に出る。選択は変わらないので、それだけを
// 見ていると追従しない。
// 引くのは `paneTabs`（メモ化済み・このペインの中だけ）。`tabStore.tabs` を舐めると、
// パーク中の他プロジェクトのタブまで含む配列を、バーの数だけ毎回走査することになる。
watch([activeId, () => paneTabs.value.find((t) => t.id === activeId.value)?.pinned], revealActiveTab)
/**
 * 溢れ方が変わる契機を拾う。**タブの枚数とコンテナの幅だけでは足りない**: 枚数も寸法も
 * そのままで中身の幅だけ増える経路がある（編集して `*` が付く、ターミナルのタイトルが
 * 長いコマンド名に変わる）。タブ 1 つ 1 つも監視して、一覧ボタンが出ないまま溢れる状態を
 * 作らない。**スクロールでは変わらない**ので、`scroll` は契機に要らない。
 */
const overflowObserver = new ResizeObserver(updateTabOverflow)

/** 監視の張り直し。`observe` は監視を始めた時点で 1 回呼ばれるので、再計算も兼ねる。 */
function watchTabSizes() {
  // 全部外してから張り直す。消えたタブを個別に外す必要が無くなる。
  overflowObserver.disconnect()
  for (const box of [tabsScrollRef.value, tabsPinnedRef.value]) {
    if (!box) continue
    overflowObserver.observe(box)
    for (const el of box.children) overflowObserver.observe(el)
  }
}

// **ピン留めの数も契機にする（#305）。** 付け外しは枚数を変えないが、タブは 2 つの列の
// あいだで別の要素として作り直されるので、移った 1 枚が個別監視から外れる。そのタブだけ
// 「中身の幅が増えた」を拾えなくなり、次に開閉するまで `▾` が出ないまま溢れる。
watch([() => pinnedTabs.value.length, () => unpinnedTabs.value.length], async () => {
  await nextTick()
  watchTabSizes()
})

onMounted(watchTabSizes)
onUnmounted(() => overflowObserver.disconnect())

const isWindows = computed(() =>
  projectStore.currentProject ? isWindowsShell(projectStore.currentProject.shell) : false,
)

// シェルの決め方（グローバルモードの `globalShell` / プロジェクトの既定）は
// `useAppActions` の `openTerminal` が持つ（#254）。`Ctrl+T` と macOS の
// File ▸ New Terminal と同じ 1 本を通す。
const { openTerminal, toggleSplit } = useAppActions()

// Shell dropdown: Windows projects offer the Windows shells; global-mode
// windows additionally offer every detected WSL distro. Order and visibility
// come from the shell profile list managed in Settings (#129).
const showShellMenu = ref(false)

function loadWslDistros() {
  if (distrosRequested) return
  distrosRequested = true
  detectWslDistros()
    .then((d) => settings.syncShellProfiles(d))
    .catch(() => {})
}

/** Default shell for this window — highlighted in the dropdown. */
const defaultShellId = computed(() => {
  const shell = globalMode.value ? settings.globalShell : projectStore.currentProject?.shell
  return shell ? shellId(shell) : null
})

const shellMenuItems = computed<{ key: string; shell: ShellType; label: string; isDefault: boolean }[]>(() =>
  settings.shellProfiles
    // Keep the current default shell listed even if hidden, so the highlighted
    // default is always openable and "+" and "▾" never disagree about it.
    .filter((p) => (!p.hidden || p.id === defaultShellId.value) && (globalMode.value || p.shell.kind !== 'wsl'))
    .map((p) => ({
      key: p.id,
      shell: p.shell,
      label: shellProfileLabel(p.shell),
      isDefault: p.id === defaultShellId.value,
    })),
)

// Global windows have no sidebar (no gear menu) — surface its essentials
// (shortcuts / settings / manual) from this dropdown instead.
const shortcutsModal = useShortcutsModal()

function menuOpenShortcuts() {
  closeShellMenu()
  shortcutsModal.toggle()
}

function menuOpenSettings() {
  closeShellMenu()
  tabStore.addSettingsTab()
}

function menuOpenManual() {
  closeShellMenu()
  tabStore.addManualTab()
}

function toggleShellMenu() {
  if (showShellMenu.value) {
    closeShellMenu()
    return
  }
  if (globalMode.value) loadWslDistros()
  showShellMenu.value = true
  nextTick(() => {
    window.addEventListener('mousedown', closeShellMenu, { once: true })
  })
}

function closeShellMenu() {
  window.removeEventListener('mousedown', closeShellMenu)
  showShellMenu.value = false
}

function addTabWithShell(shell: ShellType) {
  openTerminal(shell)
  closeShellMenu()
}

// "Open as administrator" (#138): right-click a Windows-shell row in the "▾"
// menu. Available in any window (project or global) except an already-elevated
// one; WSL rows are excluded (WSL elevation is out of scope).
const adminMenu = ref<{ shell: ShellType } | null>(null)
const {
  style: adminMenuStyle,
  placeAt: placeAdminMenu,
  reset: resetAdminMenu,
} = useAnchoredPopup(useTemplateRef<HTMLElement>('adminMenuEl'))

async function onShellRowContext(e: MouseEvent, shell: ShellType) {
  // Suppress the default context menu on every shell row; only Windows shells
  // (and only when not already elevated) offer the admin action.
  e.preventDefault()
  if (elevated.value || !isWindowsShell(shell)) return
  // The "▾" sits at the top-right, so a menu anchored at the cursor would spill
  // off-screen. Measure it and clamp into the viewport (#204) — this used to
  // guess the menu's size, which a longer translation or a UI zoom outgrows.
  resetAdminMenu()
  adminMenu.value = { shell }
  await placeAdminMenu({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', closeAdminMenu, { once: true })
}

function closeAdminMenu() {
  window.removeEventListener('mousedown', closeAdminMenu)
  adminMenu.value = null
  resetAdminMenu()
}

async function openAsAdmin(shell: ShellType) {
  const project = projectStore.currentProject
  closeAdminMenu()
  closeShellMenu()
  try {
    // Inherit the current mode: a project window reopens the same project in
    // normal mode; a global window opens a global admin terminal.
    if (project && !globalMode.value) {
      await openElevatedTerminal(shell.kind, { projectId: project.id })
    } else {
      await openElevatedTerminal(shell.kind)
    }
  } catch {
    // UAC cancelled or failed — nothing to restore; the request is a no-op.
  }
}

// Drag-and-drop reordering. **状態は 2 本のバーで共有する**（#308。`useTabDrag` の
// doc が理由の正本）。
const { dragId: dragTabId, dragOverTarget: dragOverTabId, dragSide, startDrag: onDragStart, resetDrag } = useTabDrag()

/** 掴んでいるタブ。`dragover` は実質 mousemove ごとに来るので、そこで引き直さない。 */
const draggedTab = computed(() => tabStore.tabs.find((t) => t.id === dragTabId.value) ?? null)

/**
 * ドロップの印を出してよいか。**またげない組では出さない**（#305）ので、動かない
 * ドロップを試させずに済む。断る規則そのものは `types/tab.ts` の `canReorderTabs` で、
 * 実際に動かす `tabStore.reorderTab` も同じ述語を読む。
 */
function canDropOn(tab: Tab): boolean {
  const from = draggedTab.value
  return !!from && from.id !== tab.id && canReorderTabs(from, tab)
}

function onDragOver(e: DragEvent, tab: Tab) {
  if (!canDropOn(tab)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const midX = rect.left + rect.width / 2
  dragSide.value = e.clientX < midX ? 'left' : 'right'
  dragOverTabId.value = tab.id
}

function onDragLeave() {
  dragOverTabId.value = null
}

function onDrop(e: DragEvent, tab: Tab) {
  e.preventDefault()
  // バー側の drop（＝このペインの末尾へ移す）まで上げない。
  e.stopPropagation()
  if (dragTabId.value) tabStore.reorderTab(dragTabId.value, tab.id, dragSide.value)
  resetDrag()
}

const onDragEnd = resetDrag

/**
 * `TabItem` 1 枚ぶんの束縛。**2 つの列で同じものを渡す**ので、テンプレートに 2 度書くと
 * props やハンドラを足したときに片方だけ直す事故が起きる（`TabItem` を切り出した理由が
 * そのすぐ外側で再発する）。
 *
 * `on…` のキーはテンプレートの `@…` と同じものにコンパイルされる。drag 系は `TabItem` が
 * emit を持たないので、そのままルート要素の native リスナになる。
 */
function tabBind(tab: Tab) {
  return {
    tab,
    active: tab.id === activeId.value,
    dragging: tab.id === dragTabId.value,
    dropSide: tab.id === dragOverTabId.value ? dragSide.value : null,
    onSelect: () => tabStore.setActiveTab(tab.id),
    onClose: () => tabStore.closeTab(tab.id),
    onContextmenu: (e: MouseEvent) => {
      e.stopPropagation()
      onTabContextMenu(e, tab.id)
    },
    onDragstart: (e: DragEvent) => onDragStart(e, tab.id),
    onDragover: (e: DragEvent) => onDragOver(e, tab),
    onDragleave: onDragLeave,
    onDrop: (e: DragEvent) => onDrop(e, tab),
    onDragend: onDragEnd,
  }
}

// External file drop on the tab bar (VS Code-like): drop a file from
// Explorer → open it in the matching tab kind; drop a directory → open a
// terminal tab with that directory as cwd. Enabled only for Windows projects
// and global-mode windows — WSL projects would need Windows→WSL path
// conversion for both the editor shell I/O and the terminal cwd.
const externalDropEnabled = computed(() => {
  if (!canResolveDroppedPaths()) return false
  if (globalMode.value) return true
  const project = projectStore.currentProject
  return project != null && project.shell.kind !== 'wsl'
})

function isExternalFileDrag(e: DragEvent): boolean {
  return !dragTabId.value && (e.dataTransfer?.types.includes('Files') ?? false)
}

/**
 * Shell for a dropped-directory terminal. Dropped paths are Windows paths,
 * so a WSL global default (which ignores a Windows cwd and starts at the
 * Linux home) would defeat the point — fall back to the default Windows
 * shell in that case.
 */
function dropTerminalShell(): ShellType {
  if (!globalMode.value) return projectStore.shellForIO
  const shell = settings.globalShell
  if (shell.kind !== 'wsl') return shell
  return { kind: settings.defaultWindowsShellKind() }
}

function onBarDragOver(e: DragEvent) {
  // タブを空きエリアへ引いてきた（＝このペインへ移す）。タブの上では `TabItem` 側が
  // 先に受けるが、そちらも同じ `move` なので二重でも害はない。
  if (dragTabId.value) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    return
  }
  if (!externalDropEnabled.value || !isExternalFileDrag(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

async function onBarDrop(e: DragEvent) {
  // タブをこのペインへ移す（#308）。タブの上に落としたぶんは `onDrop` が止めている。
  if (dragTabId.value) {
    e.preventDefault()
    tabStore.moveTabToPane(dragTabId.value, props.pane)
    resetDrag()
    return
  }
  if (!externalDropEnabled.value || !isExternalFileDrag(e)) return
  e.preventDefault()
  const files = e.dataTransfer?.files
  if (!files?.length) return
  tabStore.focusPane(props.pane)
  // Sequential await keeps the tab order matching the dropped order
  for (const entry of await resolveDroppedPaths(files)) {
    if (entry.isDir) {
      tabStore.addTerminalTab({ cwd: entry.path, shell: dropTerminalShell() })
    } else {
      await openFileTarget({ path: entry.path, line: null })
    }
  }
}

// Context menu (tabId is null for tab-bar empty area)
const contextMenu = ref<{ tabId: string | null } | null>(null)
const {
  style: contextMenuStyle,
  placeAt: placeContextMenu,
  reset: resetContextMenu,
} = useAnchoredPopup(useTemplateRef<HTMLElement>('contextMenuEl'))
const contextTab = computed(() =>
  contextMenu.value?.tabId ? (tabStore.tabs.find((t) => t.id === contextMenu.value!.tabId) ?? null) : null,
)

const contextTabPath = computed(() => {
  const tab = contextTab.value
  if (!tab) return null
  switch (tab.kind) {
    case 'editor':
    case 'preview':
    case 'pdf':
      return tab.path
    case 'diff':
    case 'history':
      return tab.filePath
    default:
      return null
  }
})

async function onTabContextMenu(e: MouseEvent, tabId: string | null) {
  e.preventDefault()
  window.removeEventListener('mousedown', closeContextMenu)
  resetContextMenu()
  contextMenu.value = { tabId }
  await placeContextMenu({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', closeContextMenu, { once: true })
}

function onTabBarDblClick(e: MouseEvent) {
  // Only trigger on the empty area (not on a tab or button)。**プロジェクトバー（#298）も
  // 除く**: あれは押すたびに開閉するトグルなので、開いてすぐ閉じるという普通の操作が
  // dblclick になって、ここまで上がると無題のタブが増える。
  const target = e.target as HTMLElement
  if (target.closest('.tab') || target.closest('.tab-add-group') || target.closest('.project-select')) return
  tabStore.addBlankEditorTab()
}

function closeContextMenu() {
  contextMenu.value = null
  resetContextMenu()
}

async function copyPath() {
  if (!contextTabPath.value) return
  await navigator.clipboard.writeText(contextTabPath.value)
  closeContextMenu()
}

function openGitHistory() {
  const tab = contextTab.value
  if (tab?.kind !== 'editor') return
  tabStore.addHistoryTab({ filePath: tab.path })
  closeContextMenu()
}

/** 反対のペインへ送る（#308）。分割していなければ、送ることが分割の入口になる。 */
function moveToOtherPane(id: string) {
  tabStore.moveTabToOtherPane(id)
  closeContextMenu()
}

onUnmounted(() => {
  window.removeEventListener('mousedown', closeShellMenu)
  window.removeEventListener('mousedown', closeTabMenu)
  window.removeEventListener('mousedown', closeContextMenu)
  window.removeEventListener('mousedown', closeAdminMenu)
})
</script>

<template>
  <div
    class="tab-bar ui-zoom"
    :class="{ 'pane-focused': focused && tabStore.split }"
    @dblclick="onTabBarDblClick"
    @contextmenu="onTabContextMenu($event, null)"
    @dragover="onBarDragOver"
    @drop="onBarDrop"
  >
    <!--
      プロジェクトの表示と切替（#298）。**サイドバーのパネルを閉じているときだけここに
      出す**: 開いていればサイドバーの最上部が定位置で、そちらのほうがタブの幅を食わない。
      畳んだサイドバーは 48px しかなく名前が読めないので、そのぶんをここが引き受ける。
      グローバルモードのウィンドウはプロジェクトを持たないので、部品側の `v-if` で消える。

      幅はサイドバーのパネルと同じにする。開閉のたびにバーの幅が変わると名前の省略位置が
      動くし、プルダウンの幅もここに合うので「プロジェクトを開く…」が折り返さない。

      **左のバーにしか出さない**（#308）。ウィンドウに 1 つの概念なので、分割して 2 つ
      並ぶと「どちらのプロジェクトか」を聞かれているように見える。
    -->
    <ProjectSelect
      v-if="!sidebar.isPanelOpen && pane === 'left'"
      class="tabbar-project"
      :style="{ width: sidebar.panelWidth + 'px' }"
    />

    <!--
      固定タブは左端に置き、スクロールの外に出す（#305）。ブラウザの固定タブと同じで、
      タブが増えても居場所が変わらない。並び自体は `visibleTabs` がピン留めを先頭へ
      寄せているので、ここは切れ目で 2 つに分けるだけ。
    -->
    <div v-if="pinnedTabs.length > 0" ref="tabsPinnedRef" class="tabs-pinned">
      <TabItem v-for="tab in pinnedTabs" :key="tab.id" v-bind="tabBind(tab)" />
    </div>
    <!-- 残りは溢れたら横スクロールする（#281）。 -->
    <div ref="tabsScrollRef" class="tabs-scroll" @wheel="onTabsWheel">
      <TabItem v-for="tab in unpinnedTabs" :key="tab.id" v-bind="tabBind(tab)" />
    </div>
    <div class="tab-add-group">
      <!-- 溢れているときだけ出すタブの一覧（#281）。`+` の左に置く。 -->
      <button
        v-if="tabsOverflow"
        class="tab-add-arrow"
        :title="t('tabs.showAll')"
        @click.stop="toggleTabMenu"
      ><ChevronDown :size="12" :stroke-width="2" /></button>
      <button class="tab-add" :title="t('tabs.newTerminal', { key: actionChord('newTerminal') })" @click="openTerminal()"><Plus :size="16" :stroke-width="2" /></button>
      <button
        v-if="isWindows || globalMode"
        class="tab-add-arrow"
        data-testid="tab-add-arrow"
        :title="t('tabs.openWithShell')"
        @click.stop="toggleShellMenu"
      ><ChevronDown :size="12" :stroke-width="2" /></button>
      <!-- 作業領域の分割（#308）。分割中は解除になる。 -->
      <button
        class="tab-add-arrow tab-split"
        :class="{ 'split-on': tabStore.split }"
        data-testid="tab-split"
        :title="tabStore.split ? t('tabs.unsplit', { key: actionChord('toggleSplit') }) : t('tabs.splitRight', { key: actionChord('toggleSplit') })"
        @click.stop="toggleSplit"
      ><Columns2 :size="13" :stroke-width="2" /></button>
      <!-- Global windows have no sidebar — give them a manual entry point -->
      <HelpButton v-if="globalMode && pane === 'left'" page="global-mode.md" :size="15" />
    </div>
    <!-- 溢れたタブの一覧（#281）。並びはタブバーと同じ順で、今のタブに印を付ける。 -->
    <div v-if="showTabMenu" class="shell-menu tab-menu popup-surface" data-testid="tab-menu" @mousedown.stop>
      <button
        v-for="tab in paneTabs"
        :key="tab.id"
        :class="{ 'default-shell': tab.id === activeId }"
        @click="pickTab(tab.id)"
      >
        <span v-if="tabFileIconSvg(tab)" class="row-icon row-icon-svg shell-menu-icon" v-html="tabFileIconSvg(tab)" />
        <component
          :is="TAB_KIND_ICONS[tab.kind]"
          v-else-if="TAB_KIND_ICONS[tab.kind]"
          :size="14"
          :stroke-width="1.5"
          class="shell-menu-icon"
        />
        <span class="tab-menu-title">{{ tabDisplayTitle(tab) }}</span>
        <Check v-if="tab.id === activeId" :size="12" :stroke-width="2.5" class="shell-default-check" />
      </button>
    </div>
    <!-- Shell dropdown -->
    <div v-if="showShellMenu" class="shell-menu popup-surface" data-testid="shell-menu" @mousedown.stop>
      <button
        v-for="s in shellMenuItems"
        :key="s.key"
        :class="{ 'default-shell': s.isDefault }"
        :title="isWindowsShell(s.shell) && !elevated ? t('tabs.openAsAdminHint') : undefined"
        @click="addTabWithShell(s.shell)"
        @contextmenu.stop="onShellRowContext($event, s.shell)"
      >
        <component :is="SHELL_KIND_ICONS[s.shell.kind]" :size="14" :stroke-width="1.5" class="shell-menu-icon" />
        <span>{{ s.label }}</span>
        <Check v-if="s.isDefault" :size="12" :stroke-width="2.5" class="shell-default-check" />
      </button>
      <template v-if="globalMode">
        <div class="shell-menu-divider" />
        <button @click="menuOpenShortcuts">
          <span>{{ t('sidebar.keyboardShortcuts') }}</span>
          <span class="ctx-key">{{ actionChord('shortcuts') }}</span>
        </button>
        <button @click="menuOpenSettings">
          <span>{{ t('sidebar.settings') }}</span>
          <span class="ctx-key">{{ actionChord('settings') }}</span>
        </button>
        <button @click="menuOpenManual">
          <span>{{ t('sidebar.manual') }}</span>
          <span class="ctx-key">F1</span>
        </button>
      </template>
    </div>
  </div>

  <!-- "Open as administrator" menu (#138). Kept outside .tab-bar.ui-zoom so
       its position: fixed uses real viewport coords (zoom would offset it). -->
  <div
    v-if="adminMenu"
    ref="adminMenuEl"
    class="shell-admin-menu popup-surface"
    :style="adminMenuStyle"
    @mousedown.stop
  >
    <button @click="openAsAdmin(adminMenu.shell)">
      <ShieldPlus :size="14" :stroke-width="1.5" class="shell-menu-icon" />
      <span>{{ t('tabs.openAsAdmin') }}</span>
    </button>
  </div>

  <!-- Context Menu (on a tab) -->
  <div
    v-if="contextMenu && contextTab"
    ref="contextMenuEl"
    class="context-menu popup-surface"
    :style="contextMenuStyle"
    @mousedown.stop
  >
    <button @click="tabStore.togglePin(contextMenu!.tabId!); closeContextMenu()">
      {{ contextTab.pinned ? t('tabs.unpin') : t('tabs.pin') }}
    </button>
    <button
      v-if="!contextTab.pinned"
      @click="tabStore.closeTab(contextMenu!.tabId!); closeContextMenu()"
    >
      <span>{{ t('tabs.closeTab') }}</span><span class="ctx-key">{{ actionChord('closeTab') }}</span>
    </button>
    <div class="context-menu-separator" />
    <button @click="moveToOtherPane(contextMenu!.tabId!)">
      <span>{{ pane === 'left' ? t('tabs.moveToRightPane') : t('tabs.moveToLeftPane') }}</span>
      <span class="ctx-key">{{ actionChord('moveTabToOtherPane') }}</span>
    </button>
    <div class="context-menu-separator" />
    <button @click="tabStore.closeOtherTabs(contextMenu!.tabId!); closeContextMenu()">
      {{ t('tabs.closeOthers') }}
    </button>
    <button @click="tabStore.closeTabsToRight(contextMenu!.tabId!); closeContextMenu()">
      {{ t('tabs.closeToRight') }}
    </button>
    <button @click="tabStore.closeSavedTabs(pane); closeContextMenu()">
      {{ t('tabs.closeSaved') }}
    </button>
    <button @click="tabStore.closeAllTabs(pane); closeContextMenu()">
      {{ t('tabs.closeAll') }}
    </button>
    <template v-if="contextTabPath">
      <div class="context-menu-separator" />
      <button @click="copyPath()">
        {{ t('tabs.copyPath') }}
      </button>
      <button
        v-if="contextTab.kind === 'editor'"
        @click="openGitHistory()"
      >
        <span>{{ t('tabs.gitHistory') }}</span><span class="ctx-key">{{ actionChord('gitHistory') }}</span>
      </button>
    </template>
  </div>
  <!-- Context Menu (on tab bar empty area) -->
  <div
    v-else-if="contextMenu && !contextMenu.tabId"
    ref="contextMenuEl"
    class="context-menu popup-surface"
    :style="contextMenuStyle"
    @mousedown.stop
  >
    <button @click="tabStore.addBlankEditorTab(); closeContextMenu()">
      <span>{{ t('tabs.newEditor') }}</span><span class="ctx-key">{{ actionChord('newFile') }}</span>
    </button>
    <button @click="openTerminal(); closeContextMenu()">
      <span>{{ t('tabs.newTerminalShort') }}</span><span class="ctx-key">{{ actionChord('newTerminal') }}</span>
    </button>
    <template v-if="paneTabs.length > 0">
      <div class="context-menu-separator" />
      <button @click="tabStore.closeSavedTabs(pane); closeContextMenu()">
        {{ t('tabs.closeSaved') }}
      </button>
      <button @click="tabStore.closeAllTabs(pane); closeContextMenu()">
        {{ t('tabs.closeAll') }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  height: var(--tabbar-height);
  min-height: var(--tabbar-height);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  user-select: none;
  position: relative;
}

/* 分割しているあいだ、打鍵の行き先になっているペインのバーだけ下線をアクセント色にする
   （#308）。タブの強調は両方のバーに出る（どちらも「そのペインで見ているもの」を指して
   いるので消せない）ため、フォーカスの所在はこの線で示す。

   **地の色は変えない。** `--bg-secondary` と `--bg-tertiary` の明暗はダークとライトで
   逆（ダークは tertiary が明るく、ライトは secondary が明るい）なので、地の差で示すと
   「明るいほうが対象」がテーマによって嘘になる。 */
.tab-bar.pane-focused {
  border-bottom-color: var(--accent);
}

/* サイドバーを畳んでいるあいだのプロジェクト表示（#298）。タブバーの左端に固定で置く
   （幅は上の `:style` がサイドバーのパネルに合わせる）。**上限を切る**: パネルの幅は
   600px まで広げられるので、そのまま明け渡すと狭いウィンドウでタブの取り分がほとんど
   残らない。パネル用に調整した値がタブバーの取り分を決めてしまわないようにする。 */
.tabbar-project {
  max-width: min(280px, 30%);
  border-right: 1px solid var(--border);
  flex-shrink: 0;
}

/* 固定タブの列（#305）。**スクロールの外側**なので、右のタブをいくらスクロールしても
   居場所が変わらない。`flex-shrink: 0` で、タブが増えても縮まない。
   `max-width` は保険で、固定タブばかりになったときに右のスクロール領域が消えないようにする
   （その状態では固定タブ自身が `.tab` の `max-width` まで縮み、さらに溢れたぶんは隠れる）。 */
/* **区切り線は足さない。** タブが各自 `border-right` を持っているので、ここにも引くと
   同じ色の 1px が 2 本並ぶだけで、境目としては読めない。 */
.tabs-pinned {
  display: flex;
  flex-shrink: 0;
  max-width: 60%;
  overflow: hidden;
}

/* **`auto` ではなく `scroll`。** Chromium の `::-webkit-scrollbar` は領域を占有するので、
   `auto` だとタブが溢れた瞬間にタブの高さがバーのぶんだけ縮む。常に確保すれば高さは一定で、
   タブが収まっているあいだは thumb が出ないので見た目も変わらない（VSCode もタブとエディタの
   あいだにスクロールバーを出す。あちらは Monaco の自前オーバーレイ）。
   `min-width: 0` が無いと、flex アイテムは中身の最小幅より縮まないので、タブが増えたときに
   右の「+」を押し出す。 */
.tabs-scroll {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: scroll;
  overflow-y: hidden;
}

.tabs-scroll::-webkit-scrollbar {
  height: 4px;
}

/* タブ 1 枚ぶんの見た目は `TabItem.vue` が持つ（#305）。**scoped CSS は子コンポーネントの
   ルート要素までしか届かない**ので、ここに置いたままだとアイコンもタイトルも ✕ も素の
   見た目に戻る（切り出した直後に実際にそうなった）。アイコンの枠だけは、下のタブ一覧
   メニューや他のパネルと共有するので `theme.css` の `.row-icon` にある。 */

.tab-add-group {
  display: flex;
  flex-shrink: 0;
}

.tab-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--tabbar-height);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
}

.tab-add:hover {
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.tab-add-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-left: 1px solid var(--border);
}

.tab-add-arrow:hover {
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.tab-split {
  width: 24px;
}

.tab-split.split-on {
  color: var(--accent);
}

.shell-menu {
  position: absolute;
  right: 0;
  top: var(--tabbar-height);
  z-index: 1000;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 160px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.shell-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.shell-menu-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}

/* タブの一覧（#281）。**このボタンが出るのはタブが多いときだけ**＝一覧がいちばん長いときなので、
   借りている `.shell-menu`（数個で収まるシェル用に高さ無制限）に上限を足す。タイトルも
   長くなりうるので幅を決めて省略する。 */
.tab-menu {
  max-width: 320px;
  max-height: 60vh;
  overflow-y: auto;
}

.tab-menu-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shell-menu button:hover .shell-menu-icon {
  color: var(--text-active);
}

.shell-menu button.default-shell {
  font-weight: 600;
}

.shell-default-check {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--accent);
}

.shell-menu button:hover .shell-default-check {
  color: var(--text-active);
}

.shell-menu-divider {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

.shell-menu .ctx-key {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 11px;
}

.shell-menu button:hover .ctx-key {
  color: var(--text-active);
}

.shell-menu button:hover {
  background: var(--accent);
  color: var(--text-active);
}

/* "Open as administrator" context menu (fixed at the cursor) */
.shell-admin-menu {
  position: fixed;
  z-index: 1001;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 160px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.shell-admin-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.shell-admin-menu button:hover {
  background: var(--accent);
  color: var(--text-active);
}

.shell-admin-menu button:hover .shell-menu-icon {
  color: var(--text-active);
}

.context-menu {
  position: fixed;
  z-index: 1000;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 140px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.context-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  gap: 16px;
}

.context-menu button:hover {
  background: var(--accent);
  color: var(--text-active);
}

.context-menu button:hover .ctx-key {
  color: rgba(255, 255, 255, 0.7);
}

.context-menu-separator {
  height: 1px;
  margin: 4px 8px;
  background: var(--border);
}
</style>
