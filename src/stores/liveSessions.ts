import { emit, listen } from '@tauri-apps/api/event'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { confirmDialog } from '../composables/useConfirmDialog'
import { useFocusPolling } from '../composables/useFocusPolling'
import { t } from '../i18n'
import { agentById } from '../lib/agents'
import { deepestContaining, groupLiveSessions, liveSessionLabel, projectForCwd } from '../lib/liveSessions'
import { relativeTime } from '../lib/paths'
import { rootKey } from '../lib/projectPaths'
import {
  agentLiveSessionResumeDir,
  agentLiveSessions,
  focusProjectWindow,
  gitWorktreeList,
  projectWindowList,
  windowRestore,
} from '../lib/tauri'
import type { GitWorktree } from '../types/git'
import type { LiveSession } from '../types/liveSession'
import type { ProjectConfig } from '../types/project'
import { type ShellType, shellToPlatform } from '../types/tab'
import { useProjectStore } from './project'
import { useSidebarStore } from './sidebar'
import { useStatusMessageStore } from './statusMessage'
import { useTabStore } from './tabs'
import { useWorktreeStore } from './worktree'

/**
 * パネルかタブで一覧を見ているあいだの間隔。状態は秒単位で変わるので短くする。読むのは
 * 設定ディレクトリの小さな JSON と `/proc` で、ふつうはプロセスを起こさない（`live.rs` の doc。
 * WSL で `/proc` が UNC から見えない環境だけ `wsl.exe` を起こす）。どちらの間隔も、ウィンドウが
 * 前に出ているあいだだけ回る（`useFocusPolling`）。
 */
const VIEWING_POLL_MS = 5_000
/** 見ていないあいだの間隔。サイドバーのアイコンの「返答待ち」の件数を保つためだけに取る。 */
const IDLE_POLL_MS = 30_000

/**
 * セッションへ飛んだあと、そのプロジェクトを見せているウィンドウに「このセッションを前へ」と
 * 頼む知らせ。**全ウィンドウへ送り、受け手が自分で判断する**（そのプロジェクトを見せている
 * ウィンドウだけが動く）。飛んだ先がどのウィンドウかを送り側は知らない（`focusOrSwitch` は
 * 既にあるウィンドウを前に出すか、自分のウィンドウを切り替えるかを Rust が決める）。
 */
const REVEAL_EVENT = 'pike://live-session-reveal'
/**
 * 知らせが切り替えより先に着いたときに待つ長さ。プロジェクトを保持しているだけのウィンドウへ
 * 飛ぶと、Rust はそのウィンドウに切り替えを頼むだけで返る（`focus_project_window_anywhere`）ので、
 * 知らせのほうが先に着きうる。
 */
const REVEAL_WAIT_MS = 15_000

interface RevealPayload {
  projectId: string
  sessionId: string
  cwd: string
  /** 確認の文面と、開くタブの名前に使う。 */
  name: string
  /** 着いたウィンドウですること。セッションを前に出すか、そのディレクトリでシェルを開くか。 */
  action: 'session' | 'terminal'
}

/** 一覧の 1 行。セッションに、Pike の側で分かることを足したもの。 */
export interface LiveSessionRow extends LiveSession {
  /** `cwd` を含む登録済みのプロジェクト。無ければ null（飛ぶとそのディレクトリを開く）。 */
  project: ProjectConfig | null
  /** このウィンドウのターミナルのタブで動いていれば、その id。 */
  tabId: string | null
  /** 今見ているプロジェクトのセッションか。 */
  here: boolean
}

/**
 * 今動いている Claude Code のセッションの一覧（#625）。サイドバーのセッションのパネル
 * （`AgentSessionsPanel.vue`）と、詳細のタブ（`AgentSessionsTab.vue`）が読む。
 *
 * **読むのは今のプロジェクトのアカウントのぶんだけ**（利用者の判断。Rust の
 * `agent_live_sessions` が `config::resolve` で決める）。
 *
 * **このストアはサイドバーのアイコンの件数が作る**（`SideBar.vue`）。飛んだ先のウィンドウで
 * タブを前に出す知らせ（`REVEAL_EVENT`）の受け口もここにあるので、プロジェクトを見せる
 * ウィンドウでは必ず生きている。
 */
export const useLiveSessionsStore = defineStore('liveSessions', () => {
  const projectStore = useProjectStore()
  const tabStore = useTabStore()
  const sidebar = useSidebarStore()

  const sessions = ref<LiveSession[]>([])
  /** 前回の答え（JSON）。同じなら `sessions` を差し替えない（行の組み直しと描き直しを省く）。 */
  let lastJson = ''
  const configDir = ref<string | null>(null)
  const account = ref<string | null>(null)
  const loading = ref(false)
  /** 一覧をどこで読んだか（`scope`）。切り替え直後に前のアカウントの一覧を出さない。 */
  const loadedFor = ref<string | null>(null)
  /**
   * 最後に取り直した時刻。**相対時刻の表示はこれに依存させる**（`since`）: 中身が同じなら
   * `sessions` を差し替えないので、これが無いと「2 分前」が描き直されないまま残る。
   */
  const checkedAt = ref(0)
  let seq = 0

  /** パネルか詳細のタブ（シングルトン）が見えているか。 */
  const viewing = computed(() => {
    if (sidebar.activePanel === 'sessions') return true
    const tab = tabStore.tabs.find((t) => t.kind === 'agent-sessions')
    return !!tab && tabStore.isTabVisible(tab.id)
  })

  /**
   * 一覧を読む場所の鍵（プロジェクトと、参照している worktree）。**アカウントは `activeRoot` で
   * 解決する**（使用量の表示と同じ。worktree ごとに `CLAUDE_CONFIG_DIR` を変える構成で、選んだ
   * worktree のアカウントになる）。これが変わったら一覧を捨てて読み直す。
   */
  const scope = computed(() => {
    const project = projectStore.currentProject
    return project ? `${project.id}\n${projectStore.activeRoot}` : null
  })

  async function refresh() {
    const project = projectStore.currentProject
    const key = scope.value
    if (!project || !key) return
    const mine = ++seq
    loading.value = true
    try {
      const list = await agentLiveSessions(project.shell, projectStore.activeRoot)
      if (mine !== seq || scope.value !== key) return
      const json = JSON.stringify(list.sessions)
      if (json !== lastJson || loadedFor.value !== key) {
        lastJson = json
        sessions.value = list.sessions
      }
      configDir.value = list.configDir
      account.value = list.account
      loadedFor.value = key
      checkedAt.value = Date.now()
    } catch {
      // Rust は失敗を空の一覧で返すので、ここへ来るのは IPC そのものの失敗だけ。前の一覧を残す。
    } finally {
      if (mine === seq) loading.value = false
    }
  }

  /**
   * ポーリングの 1 回。**前の取得が返っていなければ飛ばす**: `refresh` は呼ぶたびに `seq` を
   * 進めて前の答えを捨てるので、取得が間隔より長くかかる環境（`wsl.exe` に落ちる冷えた
   * distro）で重ねると、どの答えも採られないまま問い合わせだけが積み上がる。
   */
  function poll() {
    if (!loading.value) void refresh()
  }

  // 間隔ごとに 1 本ずつ持つ。**遅いほうはプロジェクトがあるあいだ常に回し**（見ているかの
  // 切り替えで張り直すと、30 秒より短い間隔で切り替えるたびに数え直しになって、アイコンの件数が
  // 古いまま残る）、速いほうは見ているあいだだけ足す。1 本のまま tick の中で空振りさせないのは、
  // `useFocusPolling` がウィンドウへ戻ったとき先頭の間隔だけを撃つため。
  const fastPolling = useFocusPolling([{ every: VIEWING_POLL_MS, tick: poll }])
  const slowPolling = useFocusPolling([{ every: IDLE_POLL_MS, tick: poll }])

  watch(
    scope,
    (key) => {
      seq++
      sessions.value = []
      lastJson = ''
      loadedFor.value = null
      loading.value = false
      if (key === null) {
        slowPolling.stop()
        return
      }
      slowPolling.start()
      void refresh()
    },
    { immediate: true },
  )

  watch(
    [scope, viewing],
    ([id, v], old) => {
      if (id === null || !v) {
        fastPolling.stop()
        return
      }
      fastPolling.start()
      // 見始めたときは待たずに取る（最長 30 秒前の一覧のまま開かない）。プロジェクトが変わった
      // ときは上の watch が取っている。
      if (old && old[0] === id && !old[1]) poll()
    },
    { immediate: true },
  )

  /**
   * セッション id → このウィンドウのターミナルのタブ。保持中の他のプロジェクトのタブも含む。
   *
   * **出所は 2 つで、今動いている報告を優先する。** `agentRun` は同梱の mod が知らせる今の
   * セッションで、`agentSession` はそのタブで最後に動いていたセッション（保存に載り、復元で
   * `--resume` する相手）。後者だけを持つタブは、mod が動いていないか、復元の直後でまだ報告が
   * 来ていないもの。**今は別のセッションを動かしているタブの `agentSession` は使わない**
   * （古いセッションへ飛ぼうとして、別の会話のタブを選ぶことになる）。
   */
  const tabBySession = computed(() => {
    const map = new Map<string, string>()
    for (const tab of tabStore.tabs) {
      if (tab.kind !== 'terminal' || !tab.agentSession || map.has(tab.agentSession.id)) continue
      const running = tab.agentRun?.sessionId
      if (running && running !== tab.agentSession.id) continue
      map.set(tab.agentSession.id, tab.id)
    }
    for (const tab of tabStore.tabs) {
      if (tab.kind === 'terminal' && tab.agentRun?.sessionId) map.set(tab.agentRun.sessionId, tab.id)
    }
    return map
  })

  /**
   * セッションの居場所と突き合わせるプロジェクト。**今のプロジェクトは必ず入れる**: 登録せずに
   * 開いているディレクトリ（#230）は `projects` に居ない。一覧の行と、飛ぶときの main worktree
   * からの引き直しが同じものを読む。
   */
  const candidates = computed(() => {
    const project = projectStore.currentProject
    const list = [...projectStore.projects]
    if (project && !list.some((p) => p.id === project.id)) list.push(project)
    return list
  })

  const rows = computed<LiveSessionRow[]>(() => {
    const project = projectStore.currentProject
    if (!project || loadedFor.value !== scope.value) return []
    return sessions.value.map((s) => {
      const owner = projectForCwd(s.cwd, project.shell, candidates.value)
      return {
        ...s,
        project: owner,
        tabId: tabBySession.value.get(s.sessionId) ?? null,
        here: owner?.id === project.id,
      }
    })
  })

  const groups = computed(() => groupLiveSessions(rows.value))
  const waitingCount = computed(() => rows.value.filter((r) => r.status === 'waiting').length)
  /** 一覧が空のときに出す文言（i18n のキー）。最初の取得が返るまでは「読み込み中」。 */
  const emptyKey = computed(() => (loading.value && loadedFor.value === null ? 'common.loading' : 'liveSessions.empty'))

  /**
   * セッションの居る場所へ飛ぶ。行き先は 3 段に落ちる:
   *
   * 1. **このウィンドウのターミナルで動いているなら、そのタブ**（保持中の別プロジェクトなら
   *    そこへ切り替えてから）。
   * 2. **`cwd` を含む登録済みのプロジェクト**。`cwd` を直に含むものが無ければ、git の main
   *    worktree から引き直す（利用者の判断。リポジトリの外に作った worktree で動いている
   *    セッションも、元のプロジェクトへ寄せる）。そのプロジェクトを見せているウィンドウで
   *    `reveal` が動く（このウィンドウなら直に呼び、別のウィンドウなら `REVEAL_EVENT` で頼む）。
   * 3. **どれでもなければ、そのディレクトリを開く**（`openDirectory`。登録するかは設定に従う）。
   */
  async function jump(row: LiveSessionRow) {
    if (!projectStore.currentProject) return
    if (row.tabId && (await focusSessionTab(row.tabId))) return
    await goTo(row, 'session')
  }

  /**
   * このウィンドウのセッションのタブを選ぶ。**タブが保持中の別のプロジェクトのものなら、
   * そこへ切り替えてから**（`tabBySession` は保持中のぶんも含むので、そのまま選ぶと見えていない
   * プロジェクトのタブを選ぶことになる）。選べたら `true`。
   */
  async function focusSessionTab(tabId: string): Promise<boolean> {
    const tab = tabStore.tabs.find((t) => t.id === tabId)
    if (!tab) return false
    if (tab.projectId && tab.projectId !== projectStore.currentProject?.id) {
      await projectStore.openProject(tab.projectId, 'switch')
      // **切り替わったかを確かめてから選ぶ**（root が無いと確認を出して戻る。
      // `useAgentNotice.ts` の `handleActivated` と同じ理由）。
      if (projectStore.currentProject?.id !== tab.projectId) return false
    }
    tabStore.focusTerminal(tab.id)
    return true
  }

  /**
   * セッションのディレクトリでシェルだけを開く（右クリックの「そこでターミナルを開く」）。
   * 行き先の決め方は `jump` の 2 段目以降と同じで、着いたウィンドウでタブを足す。
   */
  async function openTerminalAt(row: LiveSessionRow) {
    await goTo(row, 'terminal')
  }

  /**
   * セッションのプロジェクトへ行き、そのプロジェクトを見せているウィンドウで `action` をさせる。
   * プロジェクトが無ければディレクトリを開く（登録するかは設定に従う）。
   */
  async function goTo(row: LiveSessionRow, action: RevealPayload['action']) {
    const project = projectStore.currentProject
    if (!project) return
    const owner = row.project ?? (await projectFromMainWorktree(row.cwd, project.shell))
    if (!owner) {
      // シェルを開くだけならプロジェクトは要らない。今のウィンドウでそのディレクトリに開く。
      if (action === 'terminal') tabStore.addTerminalTab({ cwd: row.cwd, shell: project.shell })
      else await projectStore.openDirectory(row.cwd)
      return
    }
    const payload: RevealPayload = {
      projectId: owner.id,
      sessionId: row.sessionId,
      cwd: row.cwd,
      name: row.name ?? liveSessionLabel(row),
      action,
    }
    if (owner.id !== project.id) {
      // **このウィンドウが保持しているなら、ここで切り替えて待つ。** `focusOrSwitch` は保持している
      // ウィンドウ（自分を含む）に切り替えを頼むだけで返るので、待てない。
      // それ以外は、見せているか保持しているウィンドウを Rust に前へ出させる（`focusProjectWindow`
      // が真）。**その答えで送り先の有無を決める**: 着いたウィンドウが知らせを受けて動く。
      // どこにも無ければ、このウィンドウで開く（`switch`。root が無ければ clone を勧める）。
      const local = projectStore.parkedProjectIds.includes(owner.id)
      if (!local && (await focusProjectWindow(owner.id).catch(() => false))) {
        void emit(REVEAL_EVENT, payload)
        return
      }
      await projectStore.openProject(owner.id, 'switch')
    }
    // 切り替えが断られた（root が無く clone も断った、など）なら何もしない。
    if (projectStore.currentProject?.id === owner.id) await reveal(payload)
  }

  /**
   * セッションのプロジェクトを新しいウィンドウで開く（今のウィンドウは切り替えない）。既に
   * どこかのウィンドウが開いていれば、Rust がそちらを前に出す（`placeProject` の `window`）。
   */
  async function openInNewWindow(row: LiveSessionRow) {
    const project = projectStore.currentProject
    if (!project) return
    const owner = row.project ?? (await projectFromMainWorktree(row.cwd, project.shell))
    if (owner) await projectStore.openProject(owner.id, 'window')
    else await projectStore.openDirectory(row.cwd, 'window')
  }

  /** クリップボードへ写し、ステータスバーで知らせる。 */
  async function copy(text: string) {
    const status = useStatusMessageStore()
    try {
      await navigator.clipboard.writeText(text)
      status.show({ text: t('common.copied'), durationMs: 2000 })
    } catch (e) {
      status.show({ text: String(e), variant: 'error', durationMs: 6000 })
    }
  }

  /** 右クリックのコピー 3 つ。何を写すかの正本（パネルとタブが同じものを呼ぶ）。 */
  const copySessionId = (row: LiveSessionRow) => copy(row.sessionId)
  const copyResumeCommand = (row: LiveSessionRow) => {
    const resume = agentById('claude')?.resume
    if (resume) void copy(resume(row.sessionId))
  }
  const copyCwd = (row: LiveSessionRow) => copy(row.cwd)

  /** `cwd` の git の main worktree を root に持つ（または含む）登録済みのプロジェクト。 */
  async function projectFromMainWorktree(cwd: string, shell: ShellType): Promise<ProjectConfig | null> {
    let list: GitWorktree[]
    try {
      list = await gitWorktreeList(cwd, shell)
    } catch {
      return null
    }
    const main = list.find((w) => w.isMain)
    if (!main || rootKey(main.path) === rootKey(cwd)) return null
    return projectForCwd(main.path, shell, candidates.value)
  }

  /**
   * 今の状態になってからの時間（「2 分前」）。**取り直すたびに描き直させる**（`checkedAt` を
   * 読んで依存を張る）。中身が同じなら `sessions` を差し替えないので、`relativeTime` を素で
   * 呼ぶと最初に描いた値のまま残る。
   */
  function since(ms: number | null): string | null {
    void checkedAt.value
    return ms ? relativeTime(ms) : null
  }

  /** 切り替えを待っている知らせ（`REVEAL_WAIT_MS` まで）。 */
  let pending: { payload: RevealPayload; until: number } | null = null

  /**
   * セッションを前に出す（`jump` と `REVEAL_EVENT` の受け手）。**そのプロジェクトを見せている
   * ウィンドウだけが動く。** まだ切り替わっていなければ、切り替わるまで待つ。
   *
   * - **そのセッションのタブがあれば選ぶ**（`tabBySession`）
   * - **無ければ、セッションのディレクトリで `claude --resume <id>` のタブを開く**（利用者の
   *   判断）。そのディレクトリを含む worktree へも切り替える（パネルが同じ場所を見るように）。
   *   **開く前に確認する**: 一覧に出ている時点でそのセッションはどこかで動いているので、
   *   再開すると同じ会話を 2 つのプロセスが持つことになる
   */
  async function reveal(payload: RevealPayload) {
    const project = projectStore.currentProject
    if (!project || project.id !== payload.projectId) {
      // このウィンドウが保持しているプロジェクトなら、Rust が切り替えを頼んでいる途中かもしれない。
      // **ほかのウィンドウが見せているなら待たない**（そちらが処理する。待つと、あとで利用者が
      // 自分で切り替えたときに、頼まれていない確認やタブが出る）。
      if (!projectStore.parkedProjectIds.includes(payload.projectId)) return
      const shownElsewhere = await projectWindowList()
        .then((list) => list.some((w) => w.shown === payload.projectId))
        .catch(() => false)
      if (shownElsewhere) return
      // **問い合わせのあいだに切り替わっていたら、待たずに今やる**（切り替えの watch はもう
      // 済んでいるので、待つと拾われない）。
      if (projectStore.currentProject?.id === payload.projectId) await reveal(payload)
      else pending = { payload, until: Date.now() + REVEAL_WAIT_MS }
      return
    }
    pending = null
    await windowRestore().catch(() => {})
    if (payload.action === 'terminal') {
      tabStore.addTerminalTab({ cwd: payload.cwd, shell: project.shell })
      return
    }
    const tabId = tabBySession.value.get(payload.sessionId)
    if (tabId) {
      await focusSessionTab(tabId)
      return
    }
    const resume = agentById('claude')?.resume
    if (!resume) return
    if (!(await confirmDialog(t('liveSessions.confirmResume', { name: payload.name })))) return
    // **待つたびに、まだそのプロジェクトに居るかを確かめる。** 別のプロジェクトへ移っていたら、
    // worktree の切り替えもタブも、そのプロジェクトのものに付いてしまう。
    const stillHere = () => projectStore.currentProject?.id === payload.projectId
    if (!stillHere()) return
    // **再開する場所は記録の書かれた場所**（途中で worktree へ移ったセッションは移動先でしか
    // `--resume` が通らない。`agent_live_session_resume_dir` の doc）。分からなければ起動した場所。
    const dir =
      (await agentLiveSessionResumeDir(project.shell, projectStore.activeRoot, payload.cwd, payload.sessionId).catch(
        () => null,
      )) ?? payload.cwd
    const worktreeStore = useWorktreeStore()
    await worktreeStore.loadWorktrees()
    if (!stillHere()) return
    const platform = shellToPlatform(project.shell)
    const target = deepestContaining(
      worktreeStore.worktrees.filter((w) => !w.isBare),
      dir,
      (w) => w.path,
      () => platform,
    )
    if (target && !worktreeStore.isActive(target)) await worktreeStore.setActiveWorktree(target)
    if (!stillHere()) return
    // **確認のあいだにタブが見つかったら、そちらを選ぶ**（復元の直後は mod の報告が遅れて届く）。
    // 再開すると、確認が避けようとしている「同じ会話を 2 つのプロセスが持つ」になる。
    const appeared = tabBySession.value.get(payload.sessionId)
    if (appeared) {
      await focusSessionTab(appeared)
      return
    }
    tabStore.addTerminalTab({
      cwd: dir,
      shell: project.shell,
      autoStart: resume(payload.sessionId),
      title: payload.name,
    })
  }

  watch(
    () => projectStore.currentProject?.id,
    (id) => {
      if (!pending) return
      if (Date.now() > pending.until) pending = null
      else if (id === pending.payload.projectId) void reveal(pending.payload)
    },
  )

  // 受け口はストアの寿命に合わせて外す（開発中のホットリロードで作り直されたときに、
  // 1 つの知らせで reveal が何度も走らないように）。
  const unlisten = listen<RevealPayload>(REVEAL_EVENT, (event) => void reveal(event.payload))
  onScopeDispose(() => void unlisten.then((f) => f()))

  return {
    configDir,
    account,
    loading,
    rows,
    groups,
    waitingCount,
    emptyKey,
    checkedAt,
    since,
    refresh,
    jump,
    openTerminalAt,
    openInNewWindow,
    copySessionId,
    copyResumeCommand,
    copyCwd,
  }
})
