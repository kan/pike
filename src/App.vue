<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { nextTick, onMounted, watch } from 'vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import KeyboardShortcuts from './components/KeyboardShortcuts.vue'
import SideBar from './components/layout/SideBar.vue'
import StatusBar from './components/layout/StatusBar.vue'
import TabPane from './components/layout/TabPane.vue'
import ProjectSwitcher from './components/ProjectSwitcher.vue'
import QuickOpen from './components/QuickOpen.vue'
import { offerAgentHook } from './composables/useAgentHookPrompt'
import { useAppMenu } from './composables/useAppMenu'
import { confirmAndExit, confirmBusyExit } from './composables/useBusyExit'
import { initCliOpen, peekInitialCliAction } from './composables/useCliOpen'
import { dockerLogRouter } from './composables/useDockerLogRouter'
import { type FsChangeEntry, fsWatcher, isRecentlySaved } from './composables/useFsWatcher'
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts'
import { ptyRouter } from './composables/usePtyRouter'
import { useI18n } from './i18n'
import { AGENTS } from './lib/agents'
import { clearAliasCache } from './lib/jumpTo/resolveImport'
import { clearGlobalComponentsCache } from './lib/jumpTo/vueComponent'
import { resolveNotifier } from './lib/notify'
import { normalizeSep } from './lib/paths'
import { isElevated, projectForWindow, traySetCloseToTray, windowCloseQuitsApp, windowSetBackdrop } from './lib/tauri'
import { elevated, ephemeralWindow, globalMode, isGlobalWindow, isMainWindow } from './lib/window'
import { useAgentUsageStore } from './stores/agentUsage'
import { useDiagnosticsStore } from './stores/diagnostics'
import { useGitStore } from './stores/git'
import { useProjectStore } from './stores/project'
import { useSettingsStore } from './stores/settings'
import { useTabStore } from './stores/tabs'
import { useWorktreeStore } from './stores/worktree'
import type { ProjectConfig } from './types/project'

const { t } = useI18n()

const projectStore = useProjectStore()
const tabStore = useTabStore()
const gitStore = useGitStore()
const worktreeStore = useWorktreeStore()
/** 使用量のポーリングは**表 1 行につき 1 本**（#263）。増やしてもここは触らない。 */
const agentUsageStores = AGENTS.map((a) => useAgentUsageStore(a.id))
const diagStore = useDiagnosticsStore()
const settingsStore = useSettingsStore()

useKeyboardShortcuts()
// macOS のメニューバーからの操作（#254）。他の OS ではメニューが無いので発火しない。
useAppMenu()

// Keep the Rust close-to-tray flag (#161) in sync with the setting. Only the
// main window owns the sync (one process-global atomic); a toggle in any other
// window broadcasts to the main store via the cross-window settings sync, so
// main's watch still fires. Matches the isMainWindow gate on the tray tooltip.
if (isMainWindow()) {
  watch(
    () => settingsStore.closeToTray,
    (v) => traySetCloseToTray(v).catch(() => {}),
    { immediate: true },
  )
}

// Window background transparency (issue #162). Every window applies the native
// backdrop to itself and mirrors the surface alpha into a CSS variable, so
// panels/terminal/editor go translucent together. Runs in all windows (unlike
// close-to-tray) because the backdrop is per-window.
//
// The native call also carries the theme's opaque base color, so it re-runs on a
// light/dark switch — but only in the opaque mode, which is the only one that
// uses that color. The opacity slider deliberately does NOT trigger it either:
// only CSS consumes the alpha, and dragging would fire an IPC call per frame.
watch(
  [() => settingsStore.windowBackdrop, () => settingsStore.darkMode],
  async ([kind], prev) => {
    if (kind !== 'none' && prev?.[0] === kind) return
    // Read --bg-primary-rgb after the data-theme swap has landed, so the native
    // background matches what CSS paints (theme.css stays the single source).
    await nextTick()
    const baseRgb = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary-rgb')
    void windowSetBackdrop(kind, baseRgb).catch(() => {})
  },
  { immediate: true },
)
watch(
  () => settingsStore.surfaceAlpha,
  (alpha) => {
    // This single variable makes every --bg-* surface translucent at once.
    // Popups stay opaque but tint themselves from this alpha too (--popup-lift in
    // theme.css), so nothing else has to be pushed from here. The value itself
    // (opaque mode, slider, the unfocused-acrylic lift of #277) is the store's
    // job — the terminal reads the same one.
    document.documentElement.style.setProperty('--surface-alpha', String(alpha))
  },
  { immediate: true },
)

const isDebug = import.meta.env.DEV

// プロジェクトカラー（#121）はサイドバーのアイコン列が面で塗る（#298）。ここにあった
// ウィンドウ左端の 3px の線は、同じ色の面がちょうどその位置に来て見えなくなるので落とした。

/**
 * タイトルは**今見せているプロジェクトだけ**にする（#305）。#264 でうしろに保持中のものを
 * 並べていたが、抱えるほど長くなってタスクバーで煩かった。保持しているものは
 * `ProjectSelect` のプルダウンとプロジェクトパネルの「保持中」で分かる。
 */
watch(
  [() => projectStore.currentProject?.name, () => projectStore.isTransient, elevated],
  ([name, isTransient, isAdmin]) => {
    // A directory opened without registering it (#230) is titled apart from a
    // project: several windows sit side by side in the taskbar, and the one
    // whose tabs are not being saved should say so where they are compared.
    const key = isTransient ? 'app.titleWithDirectory' : 'app.titleWithProject'
    let base = name ? t(key, { name }) : t('app.title')
    if (isAdmin) base = `${t('app.adminTitlePrefix')} ${base}`
    const title = isDebug ? `[DEBUG] ${base}` : base
    getCurrentWindow().setTitle(title)
  },
  { immediate: true },
)

// Centralized git polling lifecycle
watch(
  () => projectStore.currentProject?.id,
  (id) => {
    if (id) {
      gitStore.startPolling()
      worktreeStore.startPolling()
      for (const s of agentUsageStores) s.startPolling()
    } else {
      gitStore.stopPolling()
      worktreeStore.stopPolling()
      worktreeStore.reset()
      for (const s of agentUsageStores) s.stopPolling()
    }
  },
)

// File watcher lifecycle — keyed on the active root so it follows worktree
// switches (not just project switches) from a single owner.
watch(
  () => projectStore.activeRoot,
  async (root) => {
    // Drop jumpTo caches when the root changes so resolved paths don't bleed
    // across projects or worktrees (which may have different config).
    clearAliasCache()
    clearGlobalComponentsCache()
    const project = projectStore.currentProject
    if (project && root) {
      await fsWatcher.start(project.shell, root)
    } else {
      await fsWatcher.stop()
    }
  },
)

const ALIAS_CONFIG_NAMES = /[\\/](?:tsconfig|jsconfig)\.json$|[\\/]vite\.config\.(?:[mc]?js|ts)$/
const MAIN_FILE_NAMES = /[\\/]main\.(?:[mc]?js|ts)$/

fsWatcher.onFileChange((files: FsChangeEntry[]) => {
  let aliasInvalidated = false
  let globalsInvalidated = false
  for (const change of files) {
    if (!aliasInvalidated && ALIAS_CONFIG_NAMES.test(change.path)) {
      clearAliasCache()
      aliasInvalidated = true
    }
    if (!globalsInvalidated && MAIN_FILE_NAMES.test(change.path)) {
      clearGlobalComponentsCache()
      globalsInvalidated = true
    }
    if (isRecentlySaved(change.path)) continue
    // Separator-insensitive compare: tab paths can mix `/` and `\` on Windows
    // (git emits `/`), while the native watcher always emits `\`.
    const changedPath = normalizeSep(change.path)
    // 監視しているのは `activeRoot` だけなので、変更は今のプロジェクトのタブにしか当たらない。
    for (const tab of tabStore.visibleTabs) {
      if (tab.kind === 'editor' && tab.path && normalizeSep(tab.path) === changedPath) {
        tab.externalChange = change.kind === 'delete' ? 'deleted' : 'modified'
      }
    }
  }
  // Re-check diagnostics on source changes (throttled; no-op until the user has
  // opened the Problems panel at least once).
  diagStore.triggerAutoRun()
})

// Global-mode windows exist only for their tabs: closing the last one closes
// the window (Windows Terminal-like lifecycle). --wait windows usually close
// via the wait signal first; this also covers plain file/terminal windows.
watch(
  () => tabStore.tabs.length,
  (len, prev) => {
    if (globalMode.value && prev > 0 && len === 0) {
      getCurrentWindow().close()
    }
  },
)

onMounted(async () => {
  // Swallow OS file drops that no component handled: with Tauri's native
  // drag-drop disabled, the webview's default action for an unhandled drop is
  // navigating to the file — which replaces the app (all PTY sessions die).
  // These bubble-phase listeners run after component handlers, so handled
  // drops (terminal, chat, tab bar) are unaffected.
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => e.preventDefault())

  // Elevation is static per process; resolve once so the shield indicator and
  // window title reflect an admin instance (#138).
  isElevated()
    .then((v) => {
      elevated.value = v
    })
    .catch(() => {})

  await Promise.all([ptyRouter.init(), dockerLogRouter.init(), fsWatcher.init()])

  // Which project this window shows comes from the backend window_projects map
  // (seeded at build), not the opaque label. null for main/global windows.
  // 見せているプロジェクトと、前回保持していたもの（#264）を 1 回で受け取る。
  const windowSession = await projectForWindow()
  if (windowSession) {
    await projectStore.loadProjects()
    // Handed the project (jump list, tray, another window), so it can be one the
    // sync file brought in and nobody cloned here yet (#212).
    await projectStore.adoptProject(windowSession.shown)
    // 復元で開かれたウィンドウは、前回保持していたものを引き継ぐ（#264）。他の経路
    // （ジャンプリスト等）では空なので、何もしないのと同じ。
    projectStore.setHeldProjects(windowSession.held)
  } else if (isGlobalWindow()) {
    // Global window: no project context; initCliOpen opens the requested tabs.
  } else {
    // Cold start with real-file args ("Open with", drag onto pike.exe,
    // `pike file.rs`): open a lean global-mode editor instead of restoring
    // projects. last_project.txt stays untouched for the next plain launch.
    const initial = await peekInitialCliAction()
    if (initial.action === 'openFiles' || initial.action === 'openTerminal') {
      globalMode.value = true
    } else if (initial.action === 'openProject') {
      // Elevated admin relaunch from a project window (#138): open the project
      // in normal mode (initCliOpen switches + adds the terminal). Mark the
      // window ephemeral so it never persists its lean session over the real one.
      ephemeralWindow.value = true
    } else {
      await projectStore.restoreLastProject()
    }
  }

  await initCliOpen()

  // Claude Code の hook を入れるか、起動時に 1 度だけ聞く（#299）。プロジェクトが
  // 決まってからでないと候補のシェルが決まらないので、復元の後に置く。**await しない**:
  // 起動の続き（クロスウィンドウの listener・beforeunload・トレイ周り）をダイアログの
  // 答えで止めない（`adoptProject` が登録を聞くのと同じ理由）。
  offerAgentHook().catch(() => {})

  // Broadcast + self-filter (PTY/Docker と同方式): keep every window's
  // in-memory project copies fresh so stale full-object writes (flushSession /
  // switchProject) can't clobber edits made in another window.
  const ownLabel = getCurrentWindow().label
  listen<{ sourceLabel: string; config: ProjectConfig }>('project_updated', (event) => {
    if (event.payload.sourceLabel === ownLabel) return
    projectStore.applyExternalUpdate(event.payload.config)
  })
  // Same for the group list, which lives in its own file and would otherwise
  // only be current in the window that changed it.
  listen<{ sourceLabel: string; groups: string[] }>('project_groups_updated', (event) => {
    if (event.payload.sourceLabel === ownLabel) return
    projectStore.applyExternalGroups(event.payload.groups)
  })

  tabStore.$subscribe(() => projectStore.saveSessionDebounced())
  // 開いているウィンドウの記録（`last_project.txt`）はここで触らない（#264）。あれは
  // 生きているウィンドウからの全量書き直しなので、まだ生きているこのウィンドウを
  // 消してもらうことはできない。実際の削除は Rust の `Destroyed` が行う。
  window.addEventListener('beforeunload', () => projectStore.saveSessionNow())

  // Main window: close-to-tray (#161). Main hides instead of closing and Pike
  // stays resident in the tray. Keep polling alive so the tray usage tooltip
  // stays fresh and restore is instant; just checkpoint the session. Show a
  // one-time hint the first time so the window "vanishing" isn't confusing.
  if (isMainWindow()) {
    listen('main-minimized-to-tray', async () => {
      await projectStore.saveSessionNow()
      if (!localStorage.getItem('pike:tray-hint-shown')) {
        localStorage.setItem('pike:tray-hint-shown', '1')
        const notify = await resolveNotifier()
        notify?.(t('tray.hintTitle'), t('tray.hintBody'), () => {
          const w = getCurrentWindow()
          w.show()
          w.setFocus()
        })
      }
    })
    // Tray "Open Project…" → open the switcher in the (now shown) main window.
    listen('tray-open-switcher', () => {
      projectStore.showSwitcher = true
    })
    // closeToTray off with other windows open: main only hides (#202), so it
    // keeps nothing but its session checkpoint — no tray hint, since the setting
    // says Pike is not living in the tray.
    getCurrentWindow().listen('main-window-hidden', () => projectStore.saveSessionNow())
    // closeToTray off and main is the last window: closing it quits Pike and
    // kills every window's PTYs, so Rust hands the decision here first (#178).
    getCurrentWindow().listen('main-exit-requested', () => void confirmAndExit())
  } else {
    // Child windows (project / global): closing one kills its own PTYs, and no
    // Rust handler intercepts it, so confirm here and veto if declined (#178).
    // When it is the last one, the close quits Pike (#202) — then the whole
    // app's terminals are at stake, not just this window's tabs.
    getCurrentWindow().onCloseRequested(async (event) => {
      const ok = (await windowCloseQuitsApp().catch(() => false))
        ? await confirmBusyExit()
        : await tabStore.confirmBusyTerminals(tabStore.tabs)
      if (!ok) event.preventDefault()
    })
  }
})
</script>

<template>
  <div class="app">
    <div class="app-main">
      <SideBar v-if="!globalMode" />
      <TabPane />
    </div>
    <StatusBar />
    <!-- Global mode keeps the switcher: Ctrl+Shift+P opens the picked project
         in its own window (this window stays project-less). -->
    <ProjectSwitcher />
    <QuickOpen v-if="!globalMode" />
    <ConfirmDialog />
    <KeyboardShortcuts />
  </div>
</template>

<style scoped>
.app {
  position: relative;
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-main {
  flex: 1;
  display: flex;
  min-height: 0;
}
</style>
