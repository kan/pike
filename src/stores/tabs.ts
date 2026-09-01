import { getCurrentWindow } from '@tauri-apps/api/window'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { confirmDialog } from '../composables/useConfirmDialog'
import { ptyRouter } from '../composables/usePtyRouter'
import { t } from '../i18n'
import { formatLineRange } from '../lib/format'
import { MANUAL_INDEX } from '../lib/manual'
import { basename, normalizeSep } from '../lib/paths'
import { ptyIsBusy, ptyKill, waitSignalByPath } from '../lib/tauri'
import type { LastSession, SessionTabDef } from '../types/project'
import type {
  AgentStatusTab,
  DiffTab,
  DockerLogsTab,
  EditorTab,
  HistoryTab,
  ManualTab,
  PdfTab,
  PreviewTab,
  SettingsTab,
  ShellType,
  Tab,
  TerminalTab,
} from '../types/tab'
import { isSingletonTab } from '../types/tab'

let counter = 0

function genId(): string {
  return `tab-${Date.now()}-${++counter}`
}

export const useTabStore = defineStore('tabs', () => {
  /**
   * このウィンドウが持つ**全プロジェクトぶん**のタブ（#264）。プロジェクトを切り替えても
   * 捨てず、`ownerProjectId` で出し分ける。id から 1 つ引く用途はこちらを見る（タブの
   * コンポーネントは自分の id で引くので、パーク中でも中身は生きたまま動く）。
   */
  const tabs = ref<Tab[]>([])
  const activeTabId = ref<string | null>(null)
  // Most recently activated terminal tab — the default target for "send to
  // terminal" actions triggered from non-terminal tabs (editor, diagnostics).
  const lastTerminalId = ref<string | null>(null)

  /** 今このウィンドウが見せているプロジェクト。空文字はグローバルモード。 */
  const ownerProjectId = ref('')
  /** プロジェクトごとの最後のアクティブタブ。切り替えて戻ったとき同じタブに戻す。 */
  const activeByProject = new Map<string, string>()

  /**
   * タブバーとナビゲーションが見る一覧（#264）。**中身の描画はここを使わない**:
   * `TabPane` は `tabs` 全部をマウントしたまま `v-show` で出し分けているので、パークした
   * タブは「タブバーに出ない非アクティブタブ」になる。だから xterm もスクロールバックも
   * エージェントのセッションも、切り替えているあいだ生き続ける。
   */
  const visibleTabs = computed(() =>
    tabs.value.filter((t) => t.projectId == null || t.projectId === ownerProjectId.value),
  )

  /**
   * タブを持っているプロジェクトの id。**並びは最初のタブができた順**（＝`tabs` の並び）で、
   * 今どれを見せているかでは変わらない。切替チップの並びがこれなので、選ぶたびに順が
   * 入れ替わると狙って押せなくなる。
   */
  const projectIdsWithTabs = computed(() => [
    ...new Set(tabs.value.map((t) => t.projectId).filter((id): id is string => !!id)),
  ])

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)

  /**
   * タブを足す唯一の入口。**所有プロジェクトはここで付ける**（#264）: 作る側 12 箇所に
   * 書かせると、種別を増やしたときの付け忘れが「切り替えても消えないタブ」として出る。
   * シングルトン（設定・エージェント状態・マニュアル）はウィンドウに 1 つなので
   * プロジェクトに属させない（属させると「プロジェクトごとに 1 つ」になる）。
   */
  function pushTab(tab: Tab) {
    tabs.value.push({ ...tab, projectId: isSingletonTab(tab.kind) ? null : ownerProjectId.value })
  }

  /** そのプロジェクトのタブを既に持っているか（＝切り替えても復元が要らない）。 */
  function hasTabsFor(id: string): boolean {
    return tabs.value.some((t) => t.projectId === id)
  }

  /**
   * 見せるプロジェクトを差し替える（#264）。タブは消さない。
   *
   * **復元の要否はここから返さない**: 返すと「先に切り替えないと分からない」ことになり、
   * あとから問い直せない。呼び出し側は `hasTabsFor` で先に決める。
   */
  function setOwnerProject(id: string) {
    if (activeTabId.value) activeByProject.set(ownerProjectId.value, activeTabId.value)
    ownerProjectId.value = id
    const remembered = activeByProject.get(id)
    activeTabId.value = visibleTabs.value.some((t) => t.id === remembered)
      ? (remembered ?? null)
      : (visibleTabs.value[visibleTabs.value.length - 1]?.id ?? null)
  }

  function addTerminalTab(options?: {
    id?: string
    title?: string
    pinned?: boolean
    autoStart?: string
    closeOnExit?: boolean
    keepOnError?: boolean
    cwd?: string
    shell?: ShellType
  }): string {
    const id = options?.id ?? genId()
    pushTab({
      id,
      kind: 'terminal',
      title: options?.title ?? 'Shell',
      pinned: options?.pinned ?? false,
      ptyId: null,
      autoStart: options?.autoStart,
      closeOnExit: options?.closeOnExit,
      keepOnError: options?.keepOnError,
      cwd: options?.cwd,
      shell: options?.shell,
    })
    activeTabId.value = id
    return id
  }

  // Completion callbacks registered by runCommandTab, keyed by tab id. Fired
  // (once) by reportExit so callers never have to know how a terminal tab
  // records its exit.
  const exitHandlers = new Map<string, (code: number) => void>()

  /** Run a one-off command in a terminal tab: title == command by default, the
   *  shell exits when the command does, and the tab closes with it. The shared
   *  "run this command" contract for the task runner, docker compose and project
   *  clone. `keepOnError` holds the tab open when the command fails, so the
   *  error stays readable. `onExit` fires with the command's exit code, or with
   *  -1 if the tab is closed first. */
  function runCommandTab(
    command: string,
    cwd: string | undefined,
    shell: ShellType,
    opts?: { title?: string; keepOnError?: boolean; onExit?: (code: number) => void },
  ): string {
    const id = addTerminalTab({
      title: opts?.title ?? command,
      autoStart: command,
      closeOnExit: true,
      keepOnError: opts?.keepOnError,
      cwd,
      shell,
    })
    if (opts?.onExit) exitHandlers.set(id, opts.onExit)
    return id
  }

  /** Record a terminal's exit code (-1 = spawn failure) and notify any waiter. */
  function reportExit(id: string, code: number) {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab?.kind === 'terminal') tab.exitCode = code
    const handler = exitHandlers.get(id)
    if (handler) {
      exitHandlers.delete(id)
      handler(code)
    }
  }

  /**
   * Terminals in `list` that still have a process other than the shell running.
   * Tabs whose shell already exited are skipped, and a failing probe reports
   * "not busy" so a broken check never blocks closing (see `pty_is_busy`).
   */
  async function busyTerminals(list: Tab[]): Promise<TerminalTab[]> {
    const candidates = list.filter(
      (t): t is TerminalTab & { ptyId: string } => t.kind === 'terminal' && !!t.ptyId && t.exitCode == null,
    )
    const flags = await Promise.all(candidates.map((t) => ptyIsBusy(t.ptyId).catch(() => false)))
    return candidates.filter((_, i) => flags[i])
  }

  /**
   * Ask before killing terminals that are still running something (#178).
   * Returns false only when the user declines. Shared by every path that tears
   * terminals down: closing a tab, closing many, and closing the window.
   *
   * プロジェクトの切り替えはもう聞かない（#264。タブを閉じないので、聞くことが無い）。
   */
  async function confirmBusyTerminals(list: Tab[]): Promise<boolean> {
    const busy = await busyTerminals(list)
    if (busy.length === 0) return true
    const names = busy.map((t) => t.title).join(', ')
    const msg =
      busy.length === 1
        ? t('confirm.terminalBusyClose', { name: names })
        : t('confirm.terminalBusyCloseMulti', { count: busy.length, names })
    return confirmDialog(msg)
  }

  async function closeTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx === -1) return
    // 次にどれを出すかは**見えている並びの中の位置**で決める（#264）。`tabs` の位置は
    // 他プロジェクトのタブを含むので、そのまま使うと隣ではないタブに飛ぶ。
    const visibleIdx = visibleTabs.value.findIndex((t) => t.id === id)
    if (tabs.value[idx].pinned) return

    // Confirm close if editor tab has unsaved changes (title ends with *)
    const tab = tabs.value[idx]
    if (tab.kind === 'editor' && tab.title.endsWith(' *')) {
      if (!(await confirmDialog(t('confirm.unsavedClose', { name: tab.title.slice(0, -2) })))) {
        return
      }
    }

    // Confirm close if a command is still running in the terminal (#178)
    if (!(await confirmBusyTerminals([tab]))) return

    // Kill PTY session before removing tab to prevent wsl.exe process leaks
    if (tab.kind === 'terminal' && tab.ptyId) {
      ptyRouter.unregister(tab.ptyId)
      await ptyKill(tab.ptyId).catch(() => {})
    }

    tabs.value.splice(idx, 1)
    untitledContent.delete(id)
    // Closing before the command finished still resolves the waiter (-1, the
    // same code a failed spawn reports) so nothing waits on a gone tab.
    reportExit(id, -1)

    if (tab.kind === 'editor') {
      await signalWaitAndCloseWindow(tab.path)
    }

    if (activeTabId.value === id) {
      // **見えているタブから選ぶ**（#264）。全体から拾うと、パーク中の別プロジェクトの
      // タブがアクティブになり、タブバーは空なのに中身だけ出ている状態になる。
      const list = visibleTabs.value
      activeTabId.value = list[Math.min(visibleIdx, list.length - 1)]?.id ?? null
    }
  }

  async function clearAllTabs() {
    const kills = tabs.value
      .filter((t): t is TerminalTab & { ptyId: string } => t.kind === 'terminal' && !!t.ptyId)
      .map((t) => {
        ptyRouter.unregister(t.ptyId)
        return ptyKill(t.ptyId).catch(() => {})
      })
    await Promise.allSettled(kills)
    untitledContent.clear()
    tabs.value = []
    activeTabId.value = null
  }

  // Clear activity indicator whenever any tab becomes active,
  // regardless of which code path changed activeTabId (setActiveTab, cycleTab, closeTab, etc.)
  watch(activeTabId, (newId) => {
    if (newId) {
      const tab = tabs.value.find((t) => t.id === newId)
      if (tab?.kind === 'terminal') {
        tab.hasActivity = false
        lastTerminalId.value = newId
      }
    }
  })

  function setActiveTab(id: string) {
    if (tabs.value.some((t) => t.id === id)) {
      activeTabId.value = id
    }
  }

  function setPtyId(tabId: string, ptyId: string) {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (tab && tab.kind === 'terminal') {
      tab.ptyId = ptyId
    }
  }

  function markTabActivity(tabId: string) {
    if (activeTabId.value === tabId) return
    const tab = tabs.value.find((t) => t.id === tabId)
    if (tab?.kind !== 'terminal') return
    if (tab.hasActivity) return
    tab.hasActivity = true
  }

  function addEditorTab(options: {
    path: string
    readOnly?: boolean
    initialContent?: string
    titleSuffix?: string
    initialLine?: number
    initialViewMode?: EditorTab['initialViewMode']
    reload?: boolean
  }): string {
    if (!options.initialContent) {
      // Separator-insensitive dedup: the same file can be requested with `/`
      // (git output) and `\` (file tree) on Windows — never open it twice.
      const wanted = normalizeSep(options.path)
      const existing = tabs.value.find(
        (t): t is EditorTab => t.kind === 'editor' && normalizeSep(t.path) === wanted && !t.readOnly,
      )
      if (existing) {
        if (options.initialLine) {
          existing.initialLine = options.initialLine
        }
        if (options.reload) {
          existing.reloadRequested = Date.now()
        }
        activeTabId.value = existing.id
        return existing.id
      }
    }
    const id = genId()
    const fileName = basename(options.path) + (options.titleSuffix ?? '')
    pushTab({
      id,
      kind: 'editor',
      title: fileName,
      pinned: false,
      path: options.path,
      readOnly: options.readOnly,
      initialContent: options.initialContent,
      initialLine: options.initialLine,
      initialViewMode: options.initialViewMode,
    })
    activeTabId.value = id
    return id
  }

  /** Non-reactive storage for untitled tab content to avoid $subscribe churn on every keystroke. */
  const untitledContent = new Map<string, string>()

  let untitledCounter = 0

  function addBlankEditorTab(options?: { title?: string; content?: string }): string {
    untitledCounter++
    const title =
      options?.title ?? (untitledCounter === 1 ? t('editor.untitled') : t('editor.untitledN', { n: untitledCounter }))
    const content = options?.content ?? ''
    const id = genId()
    pushTab({
      id,
      kind: 'editor',
      title,
      pinned: false,
      path: '',
      initialContent: content,
    })
    activeTabId.value = id
    return id
  }

  function addPreviewTab(options: { path: string; dataUrl: string; revision?: string }): string {
    const existing = tabs.value.find(
      (t): t is PreviewTab => t.kind === 'preview' && t.path === options.path && t.revision === options.revision,
    )
    if (existing) {
      existing.dataUrl = options.dataUrl
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    pushTab({
      id,
      kind: 'preview',
      title: revisionTitle(options.path, options.revision),
      pinned: false,
      path: options.path,
      dataUrl: options.dataUrl,
      revision: options.revision,
    })
    activeTabId.value = id
    return id
  }

  /** Tab title for a path, marked with the commit when it is a revision. */
  function revisionTitle(path: string, revision?: string): string {
    return revision ? `${basename(path)} (${revision})` : basename(path)
  }

  function addDockerLogsTab(options: { containerId: string; containerName: string }): string {
    const existing = tabs.value.find(
      (t): t is DockerLogsTab => t.kind === 'docker-logs' && t.containerId === options.containerId,
    )
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    pushTab({
      id,
      kind: 'docker-logs',
      title: `${options.containerName} logs`,
      pinned: false,
      containerId: options.containerId,
      containerName: options.containerName,
    })
    activeTabId.value = id
    return id
  }

  function addHistoryTab(options: { filePath: string; lineRange?: { start: number; end: number } }): string {
    const range = options.lineRange
    const existing = tabs.value.find(
      (t): t is HistoryTab =>
        t.kind === 'history' &&
        t.filePath === options.filePath &&
        t.lineRange?.start === range?.start &&
        t.lineRange?.end === range?.end,
    )
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    const suffix = range ? `(${formatLineRange(range)})` : '(history)'
    pushTab({
      id,
      kind: 'history',
      title: `${basename(options.filePath)} ${suffix}`,
      pinned: false,
      filePath: options.filePath,
      lineRange: range,
    })
    activeTabId.value = id
    return id
  }

  function addSettingsTab(): string {
    const existing = tabs.value.find((t): t is SettingsTab => t.kind === 'settings')
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    pushTab({ id, kind: 'settings', title: 'Settings', pinned: false })
    activeTabId.value = id
    return id
  }

  function addAgentStatusTab(): string {
    const existing = tabs.value.find((t): t is AgentStatusTab => t.kind === 'agent-status')
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    // 他のシングルトン（Settings / Manual）と同じく英語リテラルを置く。表示名は
    // `tabDisplayTitle` が kind から i18n を引くので、ここの値はフォールバック。
    pushTab({ id, kind: 'agent-status', title: 'Agent Status', pinned: false })
    activeTabId.value = id
    return id
  }

  /** Open (or focus) the singleton manual viewer, navigating it to `page`. */
  function addManualTab(page: string = MANUAL_INDEX): string {
    const existing = tabs.value.find((t): t is ManualTab => t.kind === 'manual')
    if (existing) {
      existing.page = page
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    pushTab({ id, kind: 'manual', title: 'Manual', pinned: false, page })
    activeTabId.value = id
    return id
  }

  function addPdfTab(options: { path: string; revision?: string; dataUrl?: string }): string {
    const existing = tabs.value.find(
      (t): t is PdfTab => t.kind === 'pdf' && t.path === options.path && t.revision === options.revision,
    )
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    pushTab({
      id,
      kind: 'pdf',
      title: revisionTitle(options.path, options.revision),
      pinned: false,
      path: options.path,
      revision: options.revision,
      dataUrl: options.dataUrl,
    })
    activeTabId.value = id
    return id
  }

  function addDiffTab(options: { filePath: string; diff: string; commitHash?: string; staged?: boolean }): string {
    // Reuse existing diff tab for the same file+context
    const existing = tabs.value.find(
      (t): t is DiffTab =>
        t.kind === 'diff' &&
        t.filePath === options.filePath &&
        t.commitHash === options.commitHash &&
        t.staged === options.staged,
    )
    if (existing) {
      existing.diff = options.diff
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    const fileName = basename(options.filePath)
    const title = options.commitHash ? `${fileName} (${options.commitHash.slice(0, 7)})` : `${fileName} (diff)`
    pushTab({
      id,
      kind: 'diff',
      title,
      pinned: false,
      filePath: options.filePath,
      diff: options.diff,
      commitHash: options.commitHash,
      staged: options.staged,
    })
    activeTabId.value = id
    return id
  }

  function setTabTitle(id: string, title: string) {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab && tab.title !== title) {
      tab.title = title
    }
  }

  function togglePin(id: string) {
    const tab = tabs.value.find((t) => t.id === id)
    if (tab) {
      tab.pinned = !tab.pinned
    }
  }

  function moveTab(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= tabs.value.length) return
    if (toIndex < 0 || toIndex >= tabs.value.length) return
    const [moved] = tabs.value.splice(fromIndex, 1)
    tabs.value.splice(toIndex, 0, moved)
  }

  /**
   * 渡されたタブを閉じる。**固定タブを除くのは呼び出し側の方針**なので、ここではしない
   * （一括クローズは除き、プロジェクトごと手放すときは含める）。
   *
   * 戻り値は「全部閉じたか」。確認（未保存のエディタ・実行中のターミナル）で断られた
   * ことを、呼び出し側が結果を数え直して推測しなくて済むようにするため。
   */
  async function closeTabs(ids: string[]): Promise<boolean> {
    const toClose = tabs.value.filter((t) => ids.includes(t.id))
    if (toClose.length === 0) return true

    const dirtyEditors = toClose.filter((t) => t.kind === 'editor' && t.title.endsWith(' *'))
    if (dirtyEditors.length > 0) {
      const names = dirtyEditors.map((t) => t.title.slice(0, -2)).join(', ')
      const msg =
        dirtyEditors.length === 1
          ? t('confirm.unsavedClose', { name: names })
          : t('confirm.unsavedCloseMulti', { count: dirtyEditors.length, names })
      if (!(await confirmDialog(msg))) return false
    }

    // Same for terminals still running a command (#178)
    if (!(await confirmBusyTerminals(toClose))) return false

    // Kill PTY sessions before removing tabs to prevent wsl.exe process leaks
    const ptyKills = toClose
      .filter((t): t is TerminalTab & { ptyId: string } => t.kind === 'terminal' && !!t.ptyId)
      .map((t) => {
        ptyRouter.unregister(t.ptyId)
        return ptyKill(t.ptyId).catch(() => {})
      })
    await Promise.allSettled(ptyKills)

    // Signal all --wait processes, then close window if any were signaled
    let shouldClose = false
    for (const tab of toClose) {
      if (tab.kind === 'editor') {
        const signaled = await waitSignalByPath(tab.path).catch(() => false)
        if (signaled) shouldClose = true
      }
    }

    const idsToClose = new Set(toClose.map((t) => t.id))
    tabs.value = tabs.value.filter((t) => !idsToClose.has(t.id))

    if (!tabs.value.some((t) => t.id === activeTabId.value)) {
      activeTabId.value = visibleTabs.value[visibleTabs.value.length - 1]?.id ?? null
    }

    if (shouldClose) {
      await getCurrentWindow()
        .close()
        .catch(() => {})
    }
    return true
  }

  /** Signal --wait processes for a file path; close window if any were waiting. */
  async function signalWaitAndCloseWindow(path: string) {
    const signaled = await waitSignalByPath(path).catch(() => false)
    if (signaled) {
      await getCurrentWindow()
        .close()
        .catch(() => {})
    }
  }

  // ここから下の一括操作とナビゲーションは、**見えているタブだけ**を対象にする（#264）。
  // パークしたタブは別のプロジェクトのものなので、「他を閉じる」「右側を閉じる」で
  // 巻き込んではいけない。
  /** 固定タブは残す（一括クローズの方針）。 */
  const unpinned = (list: Tab[]) => list.filter((t) => !t.pinned).map((t) => t.id)

  async function closeOtherTabs(keepId: string) {
    await closeTabs(unpinned(visibleTabs.value.filter((t) => t.id !== keepId)))
  }

  async function closeTabsToRight(id: string) {
    const idx = visibleTabs.value.findIndex((t) => t.id === id)
    if (idx === -1) return
    await closeTabs(unpinned(visibleTabs.value.slice(idx + 1)))
  }

  async function closeSavedTabs() {
    const ids = visibleTabs.value
      .filter((t) => !t.pinned && !(t.kind === 'editor' && t.title.endsWith(' *')))
      .map((t) => t.id)
    await closeTabs(ids)
  }

  async function closeAllTabs() {
    await closeTabs(unpinned(visibleTabs.value))
  }

  /**
   * タブの持ち主を付け替える（#264）。一時プロジェクト（#230）を登録すると id が変わるので、
   * 付け替えないとそのウィンドウのタブが誰のものでもなくなり、二度と表示されない。
   */
  function renameProjectOwner(from: string, to: string) {
    for (const tab of tabs.value) {
      if (tab.projectId === from) tab.projectId = to
    }
    const active = activeByProject.get(from)
    if (active !== undefined) {
      activeByProject.delete(from)
      activeByProject.set(to, active)
    }
    if (ownerProjectId.value === from) ownerProjectId.value = to
  }

  /** あるプロジェクトのタブを丸ごと閉じる（パークの解放。プロジェクト一覧から呼ぶ）。 */
  async function closeProjectTabs(projectId: string): Promise<boolean> {
    // 固定タブも含める。残すとそのプロジェクトのプロセスが動いたままになる。
    const ids = tabs.value.filter((t) => t.projectId === projectId).map((t) => t.id)
    const closed = await closeTabs(ids)
    if (closed) activeByProject.delete(projectId)
    return closed
  }

  function cycleTab(direction: 'next' | 'prev') {
    const list = visibleTabs.value
    if (list.length <= 1) return
    const idx = list.findIndex((t) => t.id === activeTabId.value)
    if (idx === -1) return

    const nextIdx = direction === 'next' ? (idx + 1) % list.length : (idx - 1 + list.length) % list.length
    activeTabId.value = list[nextIdx].id
  }

  function snapshotSession(): LastSession {
    // 見えているタブだけ（#264）。パーク中の別プロジェクトのタブを、今のプロジェクトの
    // セッションとして書き出さない。
    const sessionTabs: SessionTabDef[] = visibleTabs.value
      .filter((t) => t.kind === 'terminal' || t.kind === 'editor')
      .map((t) => {
        const base = { id: t.id, kind: t.kind, title: t.title, pinned: t.pinned }
        if (t.kind === 'terminal') {
          return { ...base, autoStart: t.autoStart }
        }
        if (t.kind === 'editor') {
          if (!t.path) {
            return { ...base, path: '', content: untitledContent.get(t.id) ?? '' }
          }
          return { ...base, path: t.path }
        }
        return base
      })
    return { tabs: sessionTabs, activeTabId: activeTabId.value }
  }

  return {
    tabs,
    visibleTabs,
    projectIdsWithTabs,
    hasTabsFor,
    setOwnerProject,
    renameProjectOwner,
    closeProjectTabs,
    activeTabId,
    activeTab,
    lastTerminalId,
    addTerminalTab,
    runCommandTab,
    reportExit,
    addEditorTab,
    addBlankEditorTab,
    untitledContent,
    addPreviewTab,
    addHistoryTab,
    addDockerLogsTab,
    addSettingsTab,
    addAgentStatusTab,
    addManualTab,
    addDiffTab,
    addPdfTab,
    closeTab,
    clearAllTabs,
    confirmBusyTerminals,
    closeOtherTabs,
    closeTabsToRight,
    closeSavedTabs,
    closeAllTabs,
    moveTab,
    setActiveTab,
    setPtyId,
    setTabTitle,
    togglePin,
    cycleTab,
    markTabActivity,
    snapshotSession,
  }
})
