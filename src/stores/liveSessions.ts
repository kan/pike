import { emit, listen } from '@tauri-apps/api/event'
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { confirmDialog } from '../composables/useConfirmDialog'
import { useFocusPolling } from '../composables/useFocusPolling'
import { t } from '../i18n'
import { type AgentId, agentById } from '../lib/agents'
import {
  deepestContaining,
  groupLiveSessions,
  liveListKey,
  liveListTitle,
  livePlaceKey,
  liveSessionLabel,
  liveSessionTabKey,
  projectForCwd,
} from '../lib/liveSessions'
import { openablePathForShell, relativeTime } from '../lib/paths'
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
import type { LiveSession, LiveSessionList, LiveStatus } from '../types/liveSession'
import type { ProjectConfig } from '../types/project'
import { type ShellType, shellToPlatform, type TabOwner, type TerminalTab, withEnv } from '../types/tab'
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

/** 一覧の 1 行。セッションに、どのアカウントのものかと、Pike の側で分かることを足したもの。 */
export interface LiveSessionRow extends LiveSession {
  agent: AgentId
  /** 記録を書いた環境のシェル（`LiveSessionList.shell`）。 */
  shell: ShellType
  configDir: string
  /** 再開するときにエージェントの `configEnv` へ渡す値（`LiveSessionList.configOverride`）。 */
  configOverride: string | null
  /** `cwd` を含む登録済みのプロジェクト。無ければ null（飛ぶとそのディレクトリを開く）。 */
  project: ProjectConfig | null
  /** このウィンドウのターミナルのタブで動いていれば、その id。 */
  tabId: string | null
  /**
   * タブのターミナルをチラ見してよいか（#631 / #633）。**同じ会話の行が 2 つ以上あるときは偽**: 同じ会話を
   * `--resume` で別のプロセスが開いていると、タブはどちらの行にも当たり、そのターミナルで動いているのが
   * どちらのプロセスかを Pike は知らない（タブは Claude の pid を持たない）。覗くと別のプロセスの画面を
   * 見せうるので、印は出すが覗かせない（タブへ移るのは同じ会話なので残す）。
   */
  peekable: boolean
  /** 今見ているプロジェクトのセッションか。 */
  here: boolean
}

/** 着いたウィンドウへ渡すもの。行のうち、再開に要る欄をそのまま運ぶ。 */
type RevealPayload = Pick<
  LiveSessionRow,
  'sessionId' | 'cwd' | 'agent' | 'status' | 'shell' | 'configDir' | 'configOverride'
> & {
  projectId: string
  /** 確認の文面と、開くタブの名前に使う。 */
  name: string
  /** 着いたウィンドウですること。セッションを前に出すか、そのディレクトリでシェルを開くか。 */
  action: 'session' | 'terminal'
}

/** アカウントの見出し 1 つと、その下の状態のグループ（#633）。 */
export interface LiveSessionSection {
  key: string
  title: string
  configDir: string
  groups: { status: LiveStatus; sessions: LiveSessionRow[] }[]
  /** セッションの数（折り畳んだ見出しにも出す）。 */
  total: number
  /** そのうち返答待ちの数。 */
  waiting: number
}

/**
 * 再開のコマンド。**別のアカウントには、エージェントの `configEnv`（Claude なら `CLAUDE_CONFIG_DIR`）を
 * 付ける**（付けないと、開いたターミナルが見ているアカウントで `--resume` を探して見つからない）。
 * 既定の `~/.claude` のアカウントには付けない（`configOverride` が無い。付けると `.claude.json` の
 * 置き場が変わる）。
 */
function resumeLine(
  row: Pick<RevealPayload, 'agent' | 'sessionId' | 'configOverride'>,
  shell: ShellType,
): string | null {
  const def = agentById(row.agent)
  if (!def) return null
  const line = def.resume(row.sessionId)
  return def.configEnv && row.configOverride ? withEnv(shell, def.configEnv, row.configOverride, line) : line
}

/**
 * 今動いているエージェントのセッションの一覧（#625 / #633）。サイドバーのセッションのパネル
 * （`AgentSessionsPanel.vue`）と、詳細のタブ（`AgentSessionsTab.vue`）が読む。
 *
 * **一覧はアカウント（エージェント × 環境 × 設定ディレクトリ）ごとに分かれて届く**（どれを読むかは
 * Rust の `agent_live.rs` の doc が正本）。先頭は今のプロジェクトのアカウントで、ほかはセッションが
 * あるものだけ。**1 つしか無ければ見出しを出さない**（`showHeadings`。アカウントが 1 つで Codex を
 * 使っていなければ、#625 のころと同じ見た目）。
 *
 * **行は自分の環境のシェルを持つ**（`LiveSessionRow.shell`）。プロジェクトとの照合も、開く
 * ターミナルのシェルも、再開のディレクトリの問い合わせも、そのシェルで行う（Windows のプロジェクトを
 * 開いていても、WSL のセッションは WSL で再開する）。
 *
 * **このストアはサイドバーのアイコンの件数が作る**（`SideBar.vue`）。飛んだ先のウィンドウで
 * タブを前に出す知らせ（`REVEAL_EVENT`）の受け口もここにあるので、プロジェクトを見せる
 * ウィンドウでは必ず生きている。
 */
export const useLiveSessionsStore = defineStore('liveSessions', () => {
  const projectStore = useProjectStore()
  const tabStore = useTabStore()
  const sidebar = useSidebarStore()

  const lists = ref<LiveSessionList[]>([])
  /** 前回の答え（JSON）。同じなら `lists` を差し替えない（行の組み直しと描き直しを省く）。 */
  let lastJson = ''
  /** 今のプロジェクトのアカウント（見出しを出さないときに、パネルの上に名前を出す）。 */
  const currentList = computed(() => lists.value.find((l) => l.current) ?? null)
  const configDir = computed(() => currentList.value?.configDir ?? null)
  const account = computed(() => currentList.value?.account ?? null)
  const loading = ref(false)
  /** 一覧をどこで読んだか（`scope`）。切り替え直後に前のアカウントの一覧を出さない。 */
  const loadedFor = ref<string | null>(null)
  /**
   * 最後に取り直した時刻。**相対時刻の表示はこれに依存させる**（`since`）: 中身が同じなら
   * `lists` を差し替えないので、これが無いと「2 分前」が描き直されないまま残る。
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
      const found = await agentLiveSessions(project.shell, projectStore.activeRoot)
      if (mine !== seq || scope.value !== key) return
      const json = JSON.stringify(found)
      if (json !== lastJson || loadedFor.value !== key) {
        lastJson = json
        lists.value = found
      }
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
      lists.value = []
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
   * セッションの鍵（`liveSessionTabKey`。理由は `tabForSession` の doc）→ このウィンドウのターミナルの
   * タブ。保持中の他のプロジェクトのタブも含む。
   *
   * **出所は 2 つで、今動いている報告を優先する。** `agentRun` は同梱の mod が知らせる今の
   * セッションで、`agentSession` はそのタブで最後に動いていたセッション（保存に載り、復元で
   * `--resume` する相手）。後者だけを持つタブは、mod が動いていないか、復元の直後でまだ報告が
   * 来ていないもの。**今は別のセッションを動かしているタブの `agentSession` は使わない**
   * （古いセッションへ飛ぼうとして、別の会話のタブを選ぶことになる）。
   */
  const tabBySession = computed(() => {
    const map = new Map<string, string>()
    // タブの鍵。シェルを指定していないタブは、そのプロジェクトのシェルで開いている（保持中の別の
    // プロジェクトも、登録していないディレクトリも。`findProject`）。**プロジェクトを引けないタブは
    // 突き合わせない**（今のプロジェクトのシェルで代用すると、別の環境の鍵が付く）。
    const keyOf = (tab: TerminalTab & TabOwner, agent: AgentId, id: string): string | null => {
      const shell = tab.shell ?? (tab.projectId ? projectStore.findProject(tab.projectId)?.shell : undefined)
      return shell ? liveSessionTabKey(agent, shell, id) : null
    }
    for (const tab of tabStore.tabs) {
      if (tab.kind !== 'terminal' || !tab.agentSession) continue
      const running = tab.agentRun?.sessionId
      if (running && running !== tab.agentSession.id) continue
      const key = keyOf(tab, tab.agentSession.agent, tab.agentSession.id)
      if (key && !map.has(key)) map.set(key, tab.id)
    }
    for (const tab of tabStore.tabs) {
      if (tab.kind !== 'terminal' || !tab.agentRun?.sessionId) continue
      const key = keyOf(tab, tab.agentRun.agent, tab.agentRun.sessionId)
      if (key) map.set(key, tab.id)
    }
    return map
  })

  /**
   * セッションを動かしているこのウィンドウのタブ。行の `tabId` と同じ答えを、その時点のタブから引く
   * （チラ見の取り直しが使う。#631。ホバーを始めたときに掴んだ行のオブジェクトは、一覧が組み直されても
   * 差し替わらないので、その `tabId` を読み続けると閉じたタブを指したままになる）。
   *
   * **突き合わせはエージェント・環境・セッション id の組で行う**（#633。理由は `liveSessionTabKey` の doc）。
   */
  function tabForSession(row: Pick<LiveSessionRow, 'agent' | 'shell' | 'sessionId'>): string | null {
    return tabBySession.value.get(liveSessionTabKey(row.agent, row.shell, row.sessionId)) ?? null
  }

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

  /** 一覧ごとの行。**照合は一覧の環境のシェルで行う**（WSL のセッションを Windows のプロジェクトと取り違えない）。 */
  const listRows = computed(() => {
    const project = projectStore.currentProject
    if (!project || loadedFor.value !== scope.value) return []
    // 同じ鍵の行の数（同じ会話を `--resume` で 2 つ目のプロセスが開いたとき 2 以上になる）。
    const sameKey = new Map<string, number>()
    for (const list of lists.value) {
      for (const s of list.sessions) {
        const key = liveSessionTabKey(list.agent, list.shell, s.sessionId)
        sameKey.set(key, (sameKey.get(key) ?? 0) + 1)
      }
    }
    return lists.value.map((list) => ({
      list,
      rows: list.sessions.map((s: LiveSession): LiveSessionRow => {
        const owner = projectForCwd(s.cwd, list.shell, candidates.value)
        const tabId = tabForSession({ agent: list.agent, shell: list.shell, sessionId: s.sessionId })
        return {
          ...s,
          agent: list.agent,
          shell: list.shell,
          configDir: list.configDir,
          configOverride: list.configOverride,
          project: owner,
          tabId,
          peekable: !!tabId && sameKey.get(liveSessionTabKey(list.agent, list.shell, s.sessionId)) === 1,
          here: owner?.id === project.id,
        }
      }),
    }))
  })

  const rows = computed(() => listRows.value.flatMap((l) => l.rows))

  /**
   * アカウントの見出しごとのグループ。見出しに環境（`WSL: Ubuntu`）を足すのは、一覧が 2 つ以上の
   * 環境にまたがるときだけ。
   */
  const sections = computed<LiveSessionSection[]>(() => {
    const places = new Set(listRows.value.map(({ list }) => livePlaceKey(list.shell)))
    return listRows.value.map(({ list, rows }) => ({
      key: liveListKey(list),
      title: liveListTitle(list, places.size > 1),
      configDir: list.configDir,
      groups: groupLiveSessions(rows),
      total: rows.length,
      waiting: rows.filter((r) => r.status === 'waiting').length,
    }))
  })
  /** 見出しを出すか。一覧が 1 つなら出さない（#625 のころと同じ見た目）。 */
  const showHeadings = computed(() => sections.value.length > 1)
  /** サイドバーのアイコンの件数。**全アカウントの合計**（Codex は返答待ちを持たない）。 */
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
    const owner = row.project ?? (await projectFromMainWorktree(row.cwd, row.shell))
    if (!owner) {
      // シェルを開くだけならプロジェクトは要らない。今のウィンドウでそのディレクトリに開く
      // （シェルはセッションの環境のもの）。
      if (action === 'terminal') tabStore.addTerminalTab({ cwd: row.cwd, shell: row.shell })
      else await projectStore.openDirectory(openablePathForShell(row.shell, row.cwd))
      return
    }
    const payload: RevealPayload = {
      projectId: owner.id,
      sessionId: row.sessionId,
      cwd: row.cwd,
      name: row.name ?? liveSessionLabel(row),
      action,
      agent: row.agent,
      status: row.status,
      shell: row.shell,
      configDir: row.configDir,
      configOverride: row.configOverride,
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
    const owner = row.project ?? (await projectFromMainWorktree(row.cwd, row.shell))
    if (owner) await projectStore.openProject(owner.id, 'window')
    else await projectStore.openDirectory(openablePathForShell(row.shell, row.cwd), 'window')
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
    const line = resumeLine(row, row.shell)
    if (line) void copy(line)
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
   * - **無ければ、セッションのディレクトリで再開のタブを開く**（利用者の判断。コマンドは表の
   *   `AgentDef.resume`。別のアカウントの Claude には `CLAUDE_CONFIG_DIR` を付ける＝`resumeLine`）。そのディレクトリを含む worktree へも切り替える（パネルが同じ場所を見るように）。
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
    // **シェルは、プロジェクトがセッションと同じ環境ならプロジェクトのもの**（利用者が選んだ
    // シェル。`projectForCwd` は同じ環境のプロジェクトしか返さないので、ふつうはこちら）。
    const shell = livePlaceKey(project.shell) === livePlaceKey(payload.shell) ? project.shell : payload.shell
    if (payload.action === 'terminal') {
      tabStore.addTerminalTab({ cwd: payload.cwd, shell })
      return
    }
    const tabId = tabForSession(payload)
    if (tabId) {
      await focusSessionTab(tabId)
      return
    }
    const autoStart = resumeLine(payload, shell)
    if (!autoStart) return
    // 「最近」（Codex の、動いているか分からないもの）は、動いている前提の文面で聞かない。
    const confirmKey = payload.status === 'recent' ? 'liveSessions.confirmResumeRecent' : 'liveSessions.confirmResume'
    const agentLabel = agentById(payload.agent)?.label ?? payload.agent
    if (!(await confirmDialog(t(confirmKey, { name: payload.name, agent: agentLabel })))) return
    // **待つたびに、まだそのプロジェクトに居るかを確かめる。** 別のプロジェクトへ移っていたら、
    // worktree の切り替えもタブも、そのプロジェクトのものに付いてしまう。
    const stillHere = () => projectStore.currentProject?.id === payload.projectId
    if (!stillHere()) return
    // **再開する場所は記録の書かれた場所**（途中で worktree へ移ったセッションは移動先でしか
    // `--resume` が通らない。`agent_live_session_resume_dir` の doc）。分からなければ起動した場所。
    // 移動先を探せるのは Claude だけで、Codex には Rust が null を返す（起動した場所で再開する）。
    const dir =
      (await agentLiveSessionResumeDir(payload.shell, payload.configDir, payload.cwd, payload.sessionId).catch(
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
    const appeared = tabForSession(payload)
    if (appeared) {
      await focusSessionTab(appeared)
      return
    }
    tabStore.addTerminalTab({ cwd: dir, shell, autoStart, title: payload.name })
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
    tabForSession,
    sections,
    showHeadings,
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
