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
import { windowFocused } from '../lib/window'
import type { LastSession, SessionTabDef } from '../types/project'
import type {
  AgentStatusTab,
  DiffTab,
  DockerLogsTab,
  EditorTab,
  HistoryTab,
  IssueTab,
  ManualTab,
  PaneId,
  PdfTab,
  PreviewTab,
  SettingsTab,
  ShellType,
  Tab,
  TabOwner,
  TerminalTab,
} from '../types/tab'
import { canReorderTabs, isSingletonTab, PANES } from '../types/tab'

let counter = 0

function genId(): string {
  return `tab-${Date.now()}-${++counter}`
}

/** ペインごとに選んでいるタブ（#308）。分割していないあいだ `right` は使わない。 */
type PaneSelection = Record<PaneId, string | null>

function emptySelection(): PaneSelection {
  return { left: null, right: null }
}

export const useTabStore = defineStore('tabs', () => {
  /**
   * このウィンドウが持つ**全プロジェクトぶん**のタブ（#264）。プロジェクトを切り替えても
   * 捨てず、`ownerProjectId` で出し分ける。id から 1 つ引く用途はこちらを見る（タブの
   * コンポーネントは自分の id で引くので、パーク中でも中身は生きたまま動く）。
   */
  const tabs = ref<Tab[]>([])
  // Most recently activated terminal tab — the default target for "send to
  // terminal" actions triggered from non-terminal tabs (editor, diagnostics).
  const lastTerminalId = ref<string | null>(null)

  /** 今このウィンドウが見せているプロジェクト。空文字はグローバルモード。 */
  const ownerProjectId = ref('')

  /** 右のペインを出しているか（#308）。既定は分割なし。 */
  const split = ref(false)
  /**
   * キーボードの操作が向かうペイン。新しく開いたタブもここに入る（VS Code と同じ）。
   * 分割していないあいだは常に `left`。
   */
  const focusedPane = ref<PaneId>('left')
  /**
   * ペインごとに選んでいるタブ。分割していないあいだ `right` は使わない。
   *
   * **読むときは `activeInPane` / `isTabVisible` / `isTabFocused` を通すこと。** これを
   * 公開しているのは Pinia の state に載せるためで、**外から読ませるためではない**:
   * setup store が state に載せるのは `return` に含めた ref だけ（computed は載らない）で、
   * `App.vue` のセッション保存はその deep watch（`$subscribe`）で発火する。ここを外すと、
   * タブを切り替えても保存が走らない状態に戻る（`activeTabId` は computed なので、
   * あちらだけでは観測できない）。
   */
  const activeByPane = ref<PaneSelection>({ left: null, right: null })
  /** プロジェクトごとの最後の選択（ペインごと）。切り替えて戻ったとき同じタブに戻す。 */
  const activeByProject = new Map<string, PaneSelection>()

  /**
   * そのタブが実際に描かれるペイン（#308）。**`tab.pane` を直に読まないこと**: 分割して
   * いないあいだは右に置いたままのタブも左に出るので、解釈はここ 1 箇所に置く。
   */
  function paneOf(tab: Tab | null | undefined): PaneId {
    return split.value && tab?.pane === 'right' ? 'right' : 'left'
  }

  function otherPane(pane: PaneId): PaneId {
    return pane === 'left' ? 'right' : 'left'
  }

  /**
   * そのペインの選択を選び直す（#308）。**望みのタブが今そのペインに居ればそれ、
   * 居なければ末尾**。タブが消えたり移ったりする経路（閉じる・移す・切り替える・
   * 復元する）が全部ここを通るので、落とし先の規則が 1 つで済む。
   *
   * **閉じたときだけは別**（`closeTab`）。あちらは「閉じた位置の隣」を選ぶので、
   * 末尾に落とすこの規則とは違う。
   */
  function reselect(pane: PaneId, wanted: string | null = activeByPane.value[pane]) {
    const list = tabsIn(pane)
    activeByPane.value[pane] = list.some((t) => t.id === wanted) ? wanted : (list[list.length - 1]?.id ?? null)
  }

  /**
   * 打鍵の行き先を空のペインに置いたままにしない（#308）。**選択を配り直した経路は
   * 必ず通すこと**（プロジェクトの切り替えとセッションの復元）: 空のペインにフォーカスが
   * 載ると `activeTabId` が null になり、`Ctrl+W` も `Ctrl+Tab` も `Ctrl+1`〜`9` も
   * 無反応になる（画面の半分が空表示のまま、キーボードからは何も起きない）。
   */
  function focusPaneWithTabs() {
    const other = otherPane(focusedPane.value)
    if (!activeByPane.value[focusedPane.value] && activeByPane.value[other]) {
      focusedPane.value = other
    }
  }

  /**
   * タブバーとナビゲーションが見る一覧（#264）。**中身の描画はここを使わない**:
   * `TabPane` は `tabs` 全部をマウントしたまま `v-show` で出し分けているので、パークした
   * タブは「タブバーに出ない非アクティブタブ」になる。だから xterm もスクロールバックも
   * エージェントのセッションも、切り替えているあいだ生き続ける。
   *
   * **固定タブを先頭へ寄せる（#305）。** ブラウザの固定タブと同じで、留めたものは左端に
   * 集まる。並べ替えはここ 1 箇所で、`tabs` の順（＝作った順）は動かさない。
   *
   * **表示の都合ではなく、この一覧の順そのものを変える。** タブバーだけ並べ替えると、
   * `Ctrl+1`〜`9` やタブ移動、溢れたタブの一覧、セッションの書き出しが別の順を見ることに
   * なり、「左から n 番目」が画面と食い違う。グループ内は元の順のままなので、ドラッグでの
   * 並べ替えはそのまま効く。
   *
   * **2 つに分けた側を先に作り、それを繋いで `visibleTabs` にする。** タブバーは同じ境目で
   * 2 つの列に分けて描くので、あちらで濾し直すと同じ述語が 2 箇所に出るうえ、「先頭が
   * ピン留め」という不変条件がコメントでしか支えられなくなる。
   */
  const groupedTabs = computed(() => {
    const empty = () => ({ pinned: [] as Tab[], unpinned: [] as Tab[] })
    const groups: Record<PaneId, { pinned: Tab[]; unpinned: Tab[] }> = { left: empty(), right: empty() }
    for (const t of tabs.value) {
      if (t.projectId != null && t.projectId !== ownerProjectId.value) continue
      const group = groups[paneOf(t)]
      ;(t.pinned ? group.pinned : group.unpinned).push(t)
    }
    return groups
  })

  /**
   * 1 つのペインが持つタブ（#308）。タブバーはこれを 2 つの列に分けて描く。
   *
   * 分割していないときの `left` は分割前の `visibleTabs` と同じもので、`right` は空。
   * ペインを意識しない読み手（セッションの書き出し、一括クローズの母集合）は
   * 従来どおり `visibleTabs` を見る。
   */
  function pinnedTabsIn(pane: PaneId): Tab[] {
    return groupedTabs.value[pane].pinned
  }
  function unpinnedTabsIn(pane: PaneId): Tab[] {
    return groupedTabs.value[pane].unpinned
  }
  function tabsIn(pane: PaneId): Tab[] {
    return [...groupedTabs.value[pane].pinned, ...groupedTabs.value[pane].unpinned]
  }

  /** このプロジェクトの見えているタブ全部（両ペイン）。左 → 右の順。 */
  const visibleTabs = computed(() => [...tabsIn('left'), ...tabsIn('right')])
  /** フォーカスのあるペインのタブ。ナビゲーション（`Ctrl+1`〜`9`・タブ移動）の母集合。 */
  const focusedTabs = computed(() => tabsIn(focusedPane.value))

  /**
   * タブを持っているプロジェクトの id。**並びは最初のタブができた順**（＝`tabs` の並び）で、
   * 今どれを見せているかでは変わらない。切替チップの並びがこれなので、選ぶたびに順が
   * 入れ替わると狙って押せなくなる。
   */
  const projectIdsWithTabs = computed(() => [
    ...new Set(tabs.value.map((t) => t.projectId).filter((id): id is string => !!id)),
  ])

  /**
   * フォーカスのあるペインで選んでいるタブ（#308 で意味が変わった名前）。
   *
   * **代入すると、そのタブのあるペインへフォーカスが移る。** タブを開く 12 経路が
   * ここへ書くので、「開いたタブが見えて、そこが操作対象になる」がそのまま保たれる。
   * ペインを指定して開きたいときは、先に `moveTabToPane` で置き場を決めてから選ぶ。
   */
  const activeTabId = computed<string | null>({
    get: () => activeByPane.value[focusedPane.value],
    set: (id) => {
      if (id == null) {
        activeByPane.value[focusedPane.value] = null
        return
      }
      const pane = paneOf(tabs.value.find((t) => t.id === id))
      focusedPane.value = pane
      activeByPane.value[pane] = id
    },
  })

  /**
   * どちらかのペインで表示されているか（#308）。**タブのコンポーネントが「自分は
   * 描かれているか」を聞くのはこちら**（xterm の fit、PTY のリサイズ、再描画）。
   * 分割すると「見えている」タブが 2 枚になるので、`activeTabId` との比較では
   * 隠れていないほうが 0×0 のまま測られる。
   */
  function isTabVisible(id: string): boolean {
    if (activeByPane.value.left === id) return true
    return split.value && activeByPane.value.right === id
  }

  /**
   * フォーカスのあるペインで選ばれているか（#308）。**キーボードと結び付くもの**
   * （初期フォーカス、IME の退避、StatusBar のカーソル情報、アウトラインの登録）は
   * こちらを見る。見えているタブは 2 枚あっても、打鍵の行き先は 1 つしかない。
   */
  function isTabFocused(id: string): boolean {
    return activeTabId.value === id
  }

  /**
   * そのペインで選んでいるタブ（#308）。タブバーの強調とスクロールの追従が読む。
   * **`activeTabId` を読まないこと**: フォーカスの無いペインのバーまで「選択なし」に
   * なり、そちらのタブがどれも強調されなくなる。
   */
  function activeInPane(pane: PaneId): string | null {
    return activeByPane.value[pane]
  }

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)

  /**
   * タブを足す唯一の入口。**所有プロジェクトはここで付ける**（#264）: 作る側 12 箇所に
   * 書かせると、種別を増やしたときの付け忘れが「切り替えても消えないタブ」として出る。
   * シングルトン（設定・エージェント状態・マニュアル）はウィンドウに 1 つなので
   * プロジェクトに属させない（属させると「プロジェクトごとに 1 つ」になる）。
   */
  function pushTab(tab: Tab) {
    tabs.value.push({
      ...tab,
      projectId: isSingletonTab(tab.kind) ? null : ownerProjectId.value,
      // 置き場も同じ理由でここで決める（#308）。開いたタブはフォーカスのあるペインに入る。
      pane: tab.pane ?? focusedPane.value,
    })
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
    activeByProject.set(ownerProjectId.value, { ...activeByPane.value })
    ownerProjectId.value = id
    const remembered = activeByProject.get(id) ?? emptySelection()
    // **ペインごとに選び直す**（#308）。片方だけタブを持つプロジェクトがあるので、
    // 覚えていた側が空でも、もう片方の選択を巻き込まない。
    for (const pane of PANES) reselect(pane, remembered[pane])
    focusPaneWithTabs()
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
    /** 置き場（#308）。省略＝フォーカスのあるペイン。セッションの復元が使う。 */
    pane?: PaneId
  }): string {
    const id = options?.id ?? genId()
    pushTab({
      id,
      pane: options?.pane,
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
    // 次にどれを出すかは**そのペインの並びの中の位置**で決める（#264 / #308）。`tabs` の
    // 位置は他プロジェクトのタブを含み、両ペインを合わせた並びは反対側へ飛びうる。
    const pane = paneOf(tabs.value[idx])
    const paneIdx = tabsIn(pane).findIndex((t) => t.id === id)
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

    if (activeByPane.value[pane] === id) {
      // **見えているタブから選ぶ**（#264）。全体から拾うと、パーク中の別プロジェクトの
      // タブがアクティブになり、タブバーは空なのに中身だけ出ている状態になる。
      //
      // **`activeTabId` ではなくペインの選択に書く**（#308）。フォーカスの無いペインの
      // タブを閉じただけで打鍵の行き先が動くと、閉じたのとは別の場所へ文字が入る。
      const list = tabsIn(pane)
      activeByPane.value[pane] = list[Math.min(paneIdx, list.length - 1)]?.id ?? null
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
    activeByPane.value = emptySelection()
  }

  /**
   * 見えるようになったターミナルの「気付いていない」印を下ろす（ベル由来の
   * `hasActivity` と、入力待ちの `awaitingInput` #265）。どちらも「まだ見ていない」
   * ことを言う印なので、そのタブを見た時点で役目が終わる。
   *
   * **キーはペインごとの選択で、`activeTabId` ではない。** 分割していると、フォーカスの
   * 無い側で選ばれたタブは `activeTabId` に現れないのに画面には出ている（タブバーの
   * 強調も `activeInPane` 基準）。あちらを契機にすると、ドットは `active` で隠れている
   * のに印が残り、あとでそのペインで別のタブを選んだ瞬間に古いドットが出る（#265 の
   * 印では、プロジェクト側のドットが消えないまま次の知らせまで抑止される）。
   */
  watch(
    () => PANES.map((p) => activeByPane.value[p]),
    (ids) => {
      for (const id of ids) if (id) clearTabMarks(id)
    },
  )

  /**
   * ウィンドウが前に出たときも下ろす（#265）。**選択が変わらないままフォーカスだけ
   * 戻る経路がある**（同じタブを見たまま alt-tab で戻る）ので、上の watcher だけだと
   * そこで印が残る。
   *
   * 残ると実害がある: 入力待ちの印は「もう知らせた」の意味も兼ねているので、立った
   * ままだと**同じターンの 2 回目以降の入力待ちが知らされない**（`Stop` はターンの
   * 終わりにしか来ない）。権限の確認が続けて出るのはこの機能の主目的なので、そこが
   * 黙るのはいちばん困る形。
   */
  watch(windowFocused, (focused) => {
    if (!focused) return
    for (const pane of PANES) {
      const id = activeByPane.value[pane]
      if (id) clearTabMarks(id)
    }
  })

  /** 「まだ見ていない」印を全部下ろす。**印を足すときはここにも 1 行。** */
  function clearTabMarks(tabId: string) {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (tab?.kind !== 'terminal') return
    tab.hasActivity = false
    tab.awaitingInput = false
  }

  /**
   * 入力待ちの印を全部下ろす（#265）。知らせを「オフ」にしたときの後始末で、印は
   * 立てた本人（`useAgentNotice`）が消す。**`hasActivity` は触らない**（あちらは
   * ベル由来で、この設定とは無関係）。
   */
  function clearAllAwaiting() {
    for (const tab of tabs.value) {
      if (tab.kind === 'terminal') tab.awaitingInput = false
    }
  }

  // 注入先（`lastTerminalId`）は「直近アクティブなターミナル」で、**本当にフォーカス
  // 基準の問い**なので、こちらは `activeTabId` のまま。
  watch(activeTabId, (newId) => {
    if (newId && tabs.value.find((t) => t.id === newId)?.kind === 'terminal') {
      lastTerminalId.value = newId
    }
  })

  function setActiveTab(id: string) {
    // 実在の確認とペインの解決で `tabs` を 2 度舐めない（#308。パーク中の他プロジェクトの
    // タブも含む配列なので、切り替えのたびに 2 周するのは無駄）。
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab) return
    focusedPane.value = paneOf(tab)
    activeByPane.value[focusedPane.value] = id
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

  /**
   * pty id からターミナルタブを引く（#265）。hook が知っているのは `PIKE_PTY_ID` だけで、
   * タブ id は Pike の中にしかない。
   *
   * **`tabs` を見る**（`visibleTabs` ではない）。#264 でタブは切り替えても生きているので、
   * 見えていないプロジェクトのエージェントも答えを待ちうる —— むしろそれが、プロジェクト
   * 単位の印（`awaitingProjectIds`）が要る理由。
   */
  function terminalByPty(ptyId: string): (TerminalTab & TabOwner) | null {
    return tabs.value.find((t): t is TerminalTab & TabOwner => t.kind === 'terminal' && t.ptyId === ptyId) ?? null
  }

  /** エージェントの入力待ちの印を立てる / 下ろす（#265）。 */
  function markTabAwaiting(tabId: string, awaiting: boolean) {
    const tab = tabs.value.find((t) => t.id === tabId)
    if (tab?.kind !== 'terminal') return
    tab.awaitingInput = awaiting
  }

  /**
   * 入力待ちのタブを持つプロジェクト（#265）。`ProjectSelect` の緑のドットはこれを読む。
   *
   * **印はタブが持ち、これは集約**なので、「消す」処理を別に持たない（タブを見れば
   * 下りる）。消え残りが出ないのはそのため。
   */
  const awaitingProjectIds = computed(() => {
    const ids = new Set<string>()
    for (const t of tabs.value) {
      if (t.kind === 'terminal' && t.awaitingInput && t.projectId) ids.add(t.projectId)
    }
    return ids
  })

  function addEditorTab(options: {
    path: string
    readOnly?: boolean
    initialContent?: string
    titleSuffix?: string
    initialLine?: number
    initialViewMode?: EditorTab['initialViewMode']
    reload?: boolean
    /** 置き場（#308）。省略＝フォーカスのあるペイン。既にあるタブの置き場は動かさない。 */
    pane?: PaneId
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
      pane: options.pane,
    })
    activeTabId.value = id
    return id
  }

  /** Non-reactive storage for untitled tab content to avoid $subscribe churn on every keystroke. */
  const untitledContent = new Map<string, string>()

  let untitledCounter = 0

  function addBlankEditorTab(options?: { title?: string; content?: string; pane?: PaneId }): string {
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
      pane: options?.pane,
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

  /**
   * issue を 1 件開く（#278）。**番号ごとに 1 枚**なので、既に開いていればそれを見せる。
   * 題名は取ってきてから `IssueTab` が入れる（開く時点では番号しか分からない）。
   *
   * **同じ番号でもプロジェクトが違えば別のタブ。** issue の番号はリポジトリごとに 1 から
   * 振られるので、このストアで唯一**衝突しうる dedupe キー**になっている（他はパスや
   * コンテナ id で、プロジェクトをまたいで一意）。所有者を見ないと、A で #12 を開いた
   * まま B に切り替えて B の #12 を押したとき、パーク中の A のタブが activeTabId に
   * なり、タブバーには何も出ないのに中身だけ A の #12 が見える。
   */
  function addIssueTab(number: number): string {
    const existing = tabs.value.find(
      (t): t is IssueTab => t.kind === 'issue' && t.number === number && t.projectId === ownerProjectId.value,
    )
    if (existing) {
      activeTabId.value = existing.id
      return existing.id
    }
    const id = genId()
    pushTab({ id, kind: 'issue', title: `#${number}`, pinned: false, number })
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

  /**
   * `fromId` を `toId` の左右どちらかへ動かす（ドラッグでの並べ替え）。
   *
   * **id で受けて、断るかどうかもここで決める（#305）。** index で受けていたころは、
   * 固定タブと普通のタブをまたぐ組でも受け取って `tabs` を黙って並べ替えていた（表示は
   * `visibleTabs` が寄せたあとの順なので、画面上は何も起きない）。並べ替えの入口が
   * もう 1 つできたとき、そちらが同じガードを書き写すか、無言で効かないかのどちらかになる。
   */
  function reorderTab(fromId: string, toId: string, side: 'left' | 'right') {
    if (fromId === toId) return
    const from = tabs.value.find((t) => t.id === fromId)
    const to = tabs.value.find((t) => t.id === toId)
    if (!from || !to || !canReorderTabs(from, to)) return

    // ペインをまたぐドラッグは移動も兼ねる（#308）。置き場を先に変えてから並べ替える。
    if (paneOf(from) !== paneOf(to)) moveTabToPane(fromId, paneOf(to))

    const fromIndex = tabs.value.indexOf(from)
    let toIndex = tabs.value.indexOf(to)
    if (side === 'right') toIndex++
    // 先に抜くぶん、右へ動かすときは 1 つ手前になる。
    if (fromIndex < toIndex) toIndex--
    if (fromIndex === toIndex) return

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

    // 選択が消えたペインだけ選び直す（#308。生きていれば `reselect` が据え置く）。
    for (const pane of PANES) reselect(pane)

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
  //
  // **さらにペインの中だけを見る（#308）。** どれも 1 本のタブバーから出る操作なので、
  // 反対のペインのタブまで閉じるのは押した人の意図から外れる（VS Code のタブグループと
  // 同じ扱い）。母集合を `visibleTabs` に戻さないこと。
  /** 固定タブは残す（一括クローズの方針）。 */
  const unpinned = (list: Tab[]) => list.filter((t) => !t.pinned).map((t) => t.id)

  /** そのタブが今いるペイン。閉じる操作はここを母集合にする。 */
  function paneOfTab(id: string): PaneId {
    return paneOf(tabs.value.find((t) => t.id === id))
  }

  async function closeOtherTabs(keepId: string) {
    await closeTabs(unpinned(tabsIn(paneOfTab(keepId)).filter((t) => t.id !== keepId)))
  }

  async function closeTabsToRight(id: string) {
    const list = tabsIn(paneOfTab(id))
    const idx = list.findIndex((t) => t.id === id)
    if (idx === -1) return
    await closeTabs(unpinned(list.slice(idx + 1)))
  }

  // **対象のペインは呼び出し側が渡す**（既定値を置かない）。どれも 1 本のタブバーから
  // 出る操作なので、押されたバーが自分のペインを知っている。
  async function closeSavedTabs(pane: PaneId) {
    const ids = tabsIn(pane)
      .filter((t) => !t.pinned && !(t.kind === 'editor' && t.title.endsWith(' *')))
      .map((t) => t.id)
    await closeTabs(ids)
  }

  async function closeAllTabs(pane: PaneId) {
    await closeTabs(unpinned(tabsIn(pane)))
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
    // フォーカスのあるペインの中だけを回る（#308）。反対側へ渡るのは `focusOtherPane`。
    const list = focusedTabs.value
    if (list.length <= 1) return
    const idx = list.findIndex((t) => t.id === activeTabId.value)
    if (idx === -1) return

    const nextIdx = direction === 'next' ? (idx + 1) % list.length : (idx - 1 + list.length) % list.length
    activeTabId.value = list[nextIdx].id
  }

  /**
   * 右のペインを開く／閉じる（#308）。
   *
   * **閉じるときに `tab.pane` は書き換えない。** 分割していないあいだは右に置いたままの
   * タブも左に出る（`paneOf`）ので、どこにも出ないタブは生まれず、開き直せば元の側へ
   * 戻る。**`tabs` を舐めて書き換えないこと**: あそこにはパーク中の別プロジェクトのタブも
   * 入っている（#264）ので、B で解除した操作が A の置き場まで消す。
   *
   * 見ていたタブは選択ごと左へ引き継ぐので、閉じても画面の中身は変わらない。
   */
  function toggleSplit() {
    if (split.value) {
      const keep = activeTabId.value
      split.value = false
      focusedPane.value = 'left'
      activeByPane.value.right = null
      reselect('left', keep)
      return
    }
    split.value = true
    // 右に置いたままのタブがあれば拾い直す（解除では置き場を消していない）。
    reselect('right')
    // **開いたら中身まで決める。** 空のペインだけ出しても、そこから何を出すかを
    // もう一度選ばせることになる。入口を足す人が同じ後追いを書き写さずに済むよう、
    // 「送る」までをこの 1 本に入れてある。
    const send = activeByPane.value.right ? null : activeByPane.value.left
    if (send) moveTabToPane(send, 'right')
    else focusedPane.value = 'right'
  }

  /**
   * タブを指定のペインへ移す（#308）。右を指定すると、閉じていれば分割を開く。
   * 移した先を選んでフォーカスも移す（押した人が見たいのは移したタブなので）。
   */
  function moveTabToPane(id: string, pane: PaneId) {
    const tab = tabs.value.find((t) => t.id === id)
    if (!tab) return
    if (pane === 'right') split.value = true
    const from = paneOf(tab)
    if (from !== pane) {
      tab.pane = pane
      // 元のペインは選び直す（移したタブはもう居ないので末尾に落ちる）。
      reselect(from)
    }
    focusedPane.value = pane
    activeByPane.value[pane] = id
  }

  /**
   * 見ているタブ（または指定のタブ）を反対のペインへ送る（#308）。**行き先の反転を
   * 呼び出し側に書かせない**ため、`focusOtherPane` と対でここに置く。
   */
  function moveTabToOtherPane(id: string | null = activeTabId.value) {
    if (!id) return
    moveTabToPane(id, otherPane(paneOf(tabs.value.find((t) => t.id === id))))
  }

  /** 打鍵の行き先を反対のペインへ渡す（#308）。分割していなければ何もしない。 */
  function focusOtherPane() {
    if (!split.value) return
    focusedPane.value = otherPane(focusedPane.value)
  }

  function focusPane(pane: PaneId) {
    if (pane === 'right' && !split.value) return
    focusedPane.value = pane
  }

  function snapshotSession(): LastSession {
    // 見えているタブだけ（#264）。パーク中の別プロジェクトのタブを、今のプロジェクトの
    // セッションとして書き出さない。
    const sessionTabs: SessionTabDef[] = visibleTabs.value
      .filter((t) => t.kind === 'terminal' || t.kind === 'editor')
      .map((t) => {
        const base = { id: t.id, kind: t.kind, title: t.title, pinned: t.pinned, pane: t.pane }
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
    return {
      tabs: sessionTabs,
      activeTabId: activeTabId.value,
      // 分割していないあいだは書かない（#308）。古い Pike はこの節を知らないので、
      // 無ければ従来どおり `activeTabId` の 1 つだけを復元する。**節の有無が分割の有無**
      // なので、中に `split: true` のような常に真のフィールドは持たせない。
      panes: split.value ? { focused: focusedPane.value, active: { ...activeByPane.value } } : undefined,
    }
  }

  /**
   * セッションのぶんのタブを作る前に、分割だけ先に立てる（#308）。**タブの置き場は
   * `def.pane` を `add*Tab` にそのまま渡せばよい**ので、作る手順そのものは
   * `stores/project.ts` に残る（あちらが cwd もシェルも resume の解決も持っている）。
   *
   * **分割は立てることはあっても落とさない。** 分割はウィンドウの見た目で、別の
   * プロジェクトを開いたことを理由に畳むと、そちらのタブが左へ寄って戻ってこない
   * （`tab.pane` は残るので、開き直せば右に戻る）。
   */
  function beginSessionRestore(session: LastSession) {
    if (session.panes) split.value = true
  }

  /** 作り終わったところで選択とフォーカスを戻す（#308）。 */
  function applySessionPanes(session: LastSession) {
    const panes = session.panes
    // 選択は**実在するタブだけ**採る（セッションのタブは一部しか復元されない）。
    for (const pane of PANES) {
      reselect(pane, panes ? panes.active[pane] : pane === 'left' ? session.activeTabId : null)
    }
    focusedPane.value = split.value && panes?.focused === 'right' ? 'right' : 'left'
    // セッションに残るのは terminal / editor だけなので、右に diff タブしか置いていない
    // 状態で終了すると「右が空・フォーカスは右」で戻ってくる。
    focusPaneWithTabs()
  }

  return {
    tabs,
    visibleTabs,
    focusedTabs,
    pinnedTabsIn,
    unpinnedTabsIn,
    tabsIn,
    split,
    focusedPane,
    // 読み手向けではなく、セッション保存の `$subscribe` に観測させるため（宣言の doc）。
    activeByPane,
    paneOf,
    isTabVisible,
    isTabFocused,
    activeInPane,
    toggleSplit,
    moveTabToPane,
    moveTabToOtherPane,
    focusOtherPane,
    focusPane,
    beginSessionRestore,
    applySessionPanes,
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
    addIssueTab,
    addDiffTab,
    addPdfTab,
    closeTab,
    clearAllTabs,
    confirmBusyTerminals,
    closeOtherTabs,
    closeTabsToRight,
    closeSavedTabs,
    closeAllTabs,
    reorderTab,
    setActiveTab,
    setPtyId,
    setTabTitle,
    togglePin,
    cycleTab,
    markTabActivity,
    terminalByPty,
    markTabAwaiting,
    clearAllAwaiting,
    awaitingProjectIds,
    snapshotSession,
  }
})
