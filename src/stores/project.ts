import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { confirmDialog, confirmWithOption, infoDialog } from '../composables/useConfirmDialog'
import { locale, t } from '../i18n'
import { resumeCommandFor } from '../lib/agents'
import { normalizeRemoteUrl } from '../lib/gitRemote'
import { hostDefaultShell, isMacHost } from '../lib/host'
import { stripTrailingSep, wslNativeToUnc } from '../lib/paths'
import {
  baseForPlatform,
  isProjectPlatform,
  joinBase,
  type ProjectBase,
  relativeToBase,
  rootKey,
} from '../lib/projectPaths'
import { menuActions } from '../lib/shortcuts'
import { loadJson, pushRecent } from '../lib/storage'
import { stableKey } from '../lib/syncMerge'
import {
  focusProjectWindow,
  fsDirsExist,
  gitRemoteUrls,
  menusRefresh,
  openProjectWindow,
  projectAddOpen,
  projectCreate,
  projectDelete,
  projectGet,
  projectGetLast,
  projectGroupsList,
  projectGroupsSave,
  projectList,
  projectSetParked,
  projectTransientBind,
  projectTransientCreate,
  projectTransientDrop,
  projectTransientGet,
  projectUpdate,
  type WindowSession,
  windowRestore,
} from '../lib/tauri'
import { ephemeralWindow, globalMode } from '../lib/window'
import type { ProjectConfig, SyncedProject } from '../types/project'
import { buildShell, quoteArg, type ShellType, shellId, shellToPlatform } from '../types/tab'
import { useDiagnosticsStore } from './diagnostics'
import { useIssuesStore } from './issues'
import { useSearchStore } from './search'
import { useSettingsStore } from './settings'
import { useStatusMessageStore } from './statusMessage'
import { useTabStore } from './tabs'
import { useTaskStore } from './tasks'

/** How `openProject` places a project. */
type OpenMode = 'switch' | 'window' | 'focusOrSwitch'

/** 同期の結果を手元に反映したときに何が起きたか（#403。設定画面の報告に使う）。 */
export interface SyncApplyResult {
  created: number
  updated: number
  /** 他のマシンで消されたので、ここでも消したもの。 */
  removed: number
  /** このマシンでは作れない（基準のディレクトリや WSL の distro が無い）もの。 */
  unresolvable: number
}

/** 同期で結果の値にそろえるプロジェクトのフィールド（置き場所の platform / path は含めない）。 */
const SYNCED_FIELDS = [
  'name',
  'color',
  'icon',
  'group',
  'remoteUrl',
  'golangciCommand',
  'order',
] as const satisfies readonly (keyof ProjectConfig)[]

/**
 * 固定タブの `autoStart` を「続きから」に読み替える。対応は `lib/agents.ts` の表が持つ
 * （#275。ここに第 2 の表を置くと、エージェントを増やすたびに両方を揃えることになる）。
 */
function resolveResumeCommand(autoStart?: string): string | undefined {
  if (!autoStart) return undefined
  return resumeCommandFor(autoStart) ?? autoStart
}

export const useProjectStore = defineStore('project', () => {
  const projects = ref<ProjectConfig[]>([])
  const groups = ref<string[]>([])
  const currentProject = ref<ProjectConfig | null>(null)
  const showSwitcher = ref(false)
  const showQuickOpen = ref(false)

  // The directory this window opened without registering it (#230). Deliberately
  // kept out of `projects`, which is the registered list and drives the panel,
  // the switcher, the jump list and the sync push — leaving it out is what makes
  // all of those skip it, rather than each of them testing a flag.
  const transientProject = ref<ProjectConfig | null>(null)
  const isTransient = computed(() => !!transientProject.value && currentProject.value?.id === transientProject.value.id)

  /** A project by id, registered or transient. */
  function findProject(id: string): ProjectConfig | null {
    return (
      projects.value.find((p) => p.id === id) ?? (transientProject.value?.id === id ? transientProject.value : null)
    )
  }

  // The git worktree the file tree / git / search / tasks / docker / editor
  // surfaces currently reference. `null` means the project's main root. Reset
  // whenever the project changes; switching worktrees is window-scoped and not
  // persisted.
  const activeWorktreeRoot = ref<string | null>(null)
  // Single source of truth for "which root do root-relative operations use".
  // Always a string (empty only when no project is open), so callers never need
  // their own `?? project.root` fallback — any remaining `project.root` read for
  // a root-relative operation is a bug that forgot to follow the worktree.
  // 末尾の区切りはここで落とす（#303）。root は `/home/kan/proj/` の形で登録されている
  // ことがあり、そのままだと `root + sep + name` で作ったパスと OS 由来のパスが一致せず、
  // ファイルツリーの自動更新が root 直下だけ効かなかった。理由は `stripTrailingSep`。
  const activeRoot = computed<string>(() =>
    stripTrailingSep(activeWorktreeRoot.value ?? currentProject.value?.root ?? ''),
  )

  /**
   * このウィンドウが持っているプロジェクトの id（#264）。**並びはここで決まり、以後
   * 変わらない**: 開いた順に足し、手放すまで残す。タブバーのチップがこの順なので、
   * 切り替えるたびに並びが動くと狙って押せなくなる。
   *
   * **タブを 1 つも持たないものも入る。** 前回の保持を復元しただけのものと、開いたまま
   * タブを作らなかった・全部閉じたもの（#301）。**起動時にタブまで作らない**のは、
   * タブの中身が常にマウントされる＝作った瞬間にその数だけシェルが立ち上がるため。
   * 切り替えたときに通常のセッション復元が走る（`switchProject` は「タブが無ければ
   * 復元する」なので、そのまま乗る）。
   *
   * **手放す入口は ✕（`releaseProject`）だけに保つこと（#301）。** ウィンドウを閉じると
   * Rust 側の `Destroyed` がそのウィンドウの `window_projects` を drain し、ここにある
   * ぶんが `last_project.txt` ごと消える。登録せずに開いたディレクトリ（#230）なら一覧にも
   * 残らないので戻る手段が無い。だから**タブが尽きたことを理由にウィンドウを閉じない**
   * （`Mod+W` が最後の 1 枚の次の打鍵で閉じていたのが #301 の症状）。閉じてよいかを
   * 決めるのは `App.vue` の `tabs.length` の watcher 1 箇所で、ウィンドウを閉じる操作
   * （✕ / `Mod+Shift+W` / トレイ）で保持が終わるのは仕様どおり。
   */
  const heldIds = ref<string[]>([])

  // タブを持ったものと、**いま見せているもの**を末尾に足す。**消すのは手放したときだけ**
  // （`forgetHeld`）で、タブが 0 になっても並びは保つ。
  //
  // 見せているものを足すのは、**タブを 1 つも持たないプロジェクトも保持するため**（#301）。
  // `switchProject` は `lastSession` も `pinnedTabs` も空ならタブを作らないので、タブを
  // 持ったものだけを見ていると、そこから別のプロジェクトへ移った時点で保持から外れる。
  //
  // **一時プロジェクト（#230）は入れない。** あれは切り替えると破棄されるので、
  // 「戻ってきたらそのままある」ものだけを並べる一覧とは意味が合わない
  // （出るのに戻れない、という食い違いになる）。
  watch(
    () => [...useTabStore().projectIdsWithTabs, currentProject.value?.id],
    (ids) => {
      for (const id of ids) {
        if (id && id !== transientProject.value?.id && !heldIds.value.includes(id)) {
          heldIds.value.push(id)
        }
      }
    },
    { immediate: true },
  )

  function forgetHeld(id: string) {
    heldIds.value = heldIds.value.filter((held) => held !== id)
  }

  /**
   * 保持しているプロジェクトを手放す（#264）。プロジェクトパネルの電源ボタンと、
   * タブバーのチップの ✕ が共有する。
   *
   * **タブがあるときだけ確認する。** 復元待ち（起動時に覚えただけで、まだタブを作って
   * いない）のものは動いているものが無いので、「実行中のプロセスも終了します」と聞くのは
   * 嘘になる。その場合は覚えているのをやめるだけ。
   */
  async function releaseProject(id: string): Promise<void> {
    const tabStore = useTabStore()
    if (tabStore.hasTabsFor(id)) {
      const name = findProject(id)?.name ?? id
      if (!(await confirmDialog(t('project.confirmRelease', { name })))) return
      if (!(await tabStore.closeProjectTabs(id))) return
    }
    forgetHeld(id)
  }

  /**
   * 復元した保持一覧を入れる（#264）。今見せているものを先頭に、記録の順で続ける。
   *
   * 先頭に置くのは**並びのため**で、載せる仕事ではない（現在地は上の watch が入れる）。
   */
  function setHeldProjects(ids: string[]) {
    const current = currentProject.value?.id
    heldIds.value = [...new Set([...(current ? [current] : []), ...ids])]
  }

  /**
   * このウィンドウが持っているプロジェクト（#264）。タブがあるものと、復元待ちのもの。
   * 並びはタブを持ち始めた順 → 復元待ち。引けない id（削除済みなど）は落とす。
   * 切替のプルダウンと Rust への通知が共有する。
   */
  const heldProjects = computed<ProjectConfig[]>(() => heldIds.value.flatMap((id) => findProject(id) ?? []))

  /** 保持中（＝今は見せていない）プロジェクト。一覧とスイッチャーのバッジが使う。 */
  const parkedProjects = computed<ProjectConfig[]>(() =>
    heldProjects.value.filter((p) => p.id !== currentProject.value?.id),
  )

  const parkedProjectIds = computed(() => parkedProjects.value.map((p) => p.id))

  /**
   * Shell to route file I/O through — the project's, or this host's default when
   * there is no project (a global window opened by `pike <file>`).
   *
   * **`{ kind: 'powershell' }` を各所に直書きしないこと。** この値は I/O の振り分けだけ
   * でなく `pathSep` にも渡るので、macOS では区切りが `\` になり
   * `/Users/me/notes\img.png` のような名前のファイルを作りに行く。以前は EditorTab /
   * PdfTab / openFile / TabPane の 4 箇所に同じリテラルが散っていて、そのうち 1 つだけが
   * 直された状態だった（PdfTab のコメントは「EditorTab と同じ」と言ったまま食い違った）。
   */
  const shellForIO = computed<ShellType>(() => currentProject.value?.shell ?? hostDefaultShell())

  // Project ids whose `root` is not a directory on this machine (#164): the
  // repository was registered on another machine, moved, or deleted. Populated
  // by `checkRoots`, which the project panel runs when it opens — ids absent
  // from the set are treated as present, so an unchecked list looks normal.
  const missingRoots = ref<Set<string>>(new Set())
  // Each WSL distro in the list costs a `wsl.exe` launch, so a re-check this
  // soon after the last one reuses the previous answer.
  const ROOT_CHECK_TTL_MS = 10_000
  let lastRootCheck = 0
  let rootCheck: Promise<void> | null = null

  let saveTimer: ReturnType<typeof setTimeout> | null = null

  async function loadProjects() {
    projects.value = await projectList()
  }

  /** Group projects by what a batched shell probe can answer in one call: one
   *  bucket per WSL distro, one for every host shell (native probes run in
   *  this process and never look at the shell). */
  function byProbeShell(list: ProjectConfig[]): ProjectConfig[][] {
    const buckets = new Map<string, ProjectConfig[]>()
    for (const p of list) {
      const key = p.shell.kind === 'wsl' ? shellId(p.shell) : 'host'
      const bucket = buckets.get(key)
      if (bucket) bucket.push(p)
      else buckets.set(key, [p])
    }
    return [...buckets.values()]
  }

  /** Refresh which roots exist, then fill in any origin URL still unknown.
   *  Each WSL distro costs a `wsl.exe` launch per probe, so repeat calls within
   *  `ROOT_CHECK_TTL_MS` reuse the last result unless forced.
   *
   *  A caller that arrives while a probe runs waits for that one instead of
   *  reading a set that is about to be replaced: the list watcher below starts a
   *  probe the moment projects load, which is exactly when a window checks the
   *  root it was handed (#212). A forced call always re-probes — `cloneProject`
   *  needs an answer that postdates the clone. */
  function checkRoots(force = false): Promise<void> {
    if (!force && (rootCheck || Date.now() - lastRootCheck < ROOT_CHECK_TTL_MS)) {
      return rootCheck ?? Promise.resolve()
    }
    lastRootCheck = Date.now()
    const run = probeRoots().finally(() => {
      if (rootCheck === run) rootCheck = null
    })
    rootCheck = run
    return run
  }

  async function probeRoots() {
    const missing = new Set<string>()
    await Promise.all(
      byProbeShell(projects.value).map(async (group) => {
        const flags = await fsDirsExist(
          group[0].shell,
          group.map((p) => p.root),
        ).catch(() => null)
        // A failed probe says nothing about the roots — leave them as present.
        if (!flags) return
        group.forEach((p, i) => {
          if (!flags[i]) missing.add(p.id)
        })
      }),
    )
    missingRoots.value = missing
    // Not awaited: it only reads origins of roots that are present, so it can
    // change neither this set nor the URL of a project waiting to be cloned.
    // Whoever is blocked on the answer above should not also wait on git.
    backfillRemotes().catch(() => {})
  }

  /** Read `origin` for every present project that has no stored URL yet, and
   *  save what comes back. Projects registered before Pike started recording
   *  the remote (#164) would otherwise only get one the next time they are
   *  opened, which never happens for the ones already gone from this machine. */
  async function backfillRemotes() {
    const targets = projects.value.filter((p) => !p.remoteUrl && !missingRoots.value.has(p.id))
    if (targets.length === 0) return
    await Promise.all(
      byProbeShell(targets).map(async (group) => {
        const urls = await gitRemoteUrls(
          group[0].shell,
          group.map((p) => p.root),
        ).catch(() => null)
        if (!urls) return
        await Promise.all(
          group.map((p, i) => (urls[i] ? saveProject({ ...p, remoteUrl: urls[i] }).catch(() => {}) : null)),
        )
      }),
    )
  }

  /** Clone a missing project back into place from its stored origin URL. The
   *  clone runs in a terminal tab (like task / compose runs) so credential and
   *  passphrase prompts work, and the tab is kept open on exit so failures stay
   *  readable. When it succeeds `onCloned` runs — the caller already knows what
   *  the user asked for; without one, offer to switch to the project. */
  function cloneProject(id: string, onCloned?: () => void | Promise<void>) {
    const project = projects.value.find((p) => p.id === id)
    if (!project?.remoteUrl) return
    // `git clone` creates the leading directories, so an absolute destination
    // needs no cwd — the terminal starts wherever the shell defaults to.
    const command = `git clone ${quoteArg(project.shell, project.remoteUrl)} ${quoteArg(project.shell, project.root)}`
    useTabStore().runCommandTab(command, undefined, project.shell, {
      title: `clone ${project.name}`,
      keepOnError: true,
      onExit: async (code) => {
        await checkRoots(true).catch(() => {})
        if (code !== 0 || missingRoots.value.has(id)) return
        if (onCloned) {
          await onCloned()
          return
        }
        if (currentProject.value?.id === id) return
        if (await confirmDialog(t('project.cloneDoneSwitch', { name: project.name }))) {
          await switchProject(id)
        }
      },
    })
  }

  /**
   * Put a project in a window, with no questions asked:
   *
   * - `switch`: take over this window.
   * - `window`: give it its own window (the backend focuses one already on it).
   *
   * **`focusOrSwitch` はここには来ない**（`openProject` が自分で解決してから、残りの 2 つに
   * 潰して呼ぶ）。あのモードの意味は `openProject` が持つ 1 箇所だけにしてある: 両方が
   * 解釈を持っていたころは、こちらの分岐が誰からも通らないまま「前に出さない版」の定義として
   * 残り、`placeProject` を直に使う人に #340 を再現させる形になっていた。
   *
   * `openProject` runs this after its check. Calling it directly skips that, so
   * the only caller allowed to is project creation: the root the user just typed
   * may not exist yet and a new project has no origin, which would leave the
   * check refusing to open what was asked for.
   */
  async function placeProject(id: string, mode: Exclude<OpenMode, 'focusOrSwitch'>): Promise<void> {
    if (mode === 'window') {
      await openProjectWindow(id)
      return
    }
    await switchProject(id)
  }

  /** Open a project the user picked from a list. The one entry point for that,
   *  so a root that is not on this machine is offered for cloning (#212)
   *  wherever a project can be chosen. */
  async function openProject(id: string, mode: OpenMode): Promise<void> {
    // A window already showing it proves the root is there, and jumping to it is
    // the whole point of that mode — settle it before checking anything. What is
    // left afterwards is this window, unless a dedicated one was asked for.
    if (mode === 'focusOrSwitch' && (await focusProjectWindow(id))) return
    const open = () => placeProject(id, mode === 'window' ? 'window' : 'switch')
    if (!(await ensureRootPresent(id, open))) return
    // **今いるプロジェクトへは切り替えない（#354）。** `switchProject` は離れる側の後始末を
    // 無条件に行うので、走らせると worktree の選択が main に戻り、検索・問題・タスク・issue の
    // キャッシュも落ちる。**置き場はここ**: 一覧から選ぶ経路（スイッチャー・切替のプルダウン・
    // パネル）が全部ここを通るので、呼び出し側それぞれに写しを置かずに済む。
    //
    // **`switchProject` 側に置けない**: `adoptProject` と clone 後の張り直し（すぐ上の
    // `ensureRootPresent` の `onCloned`）が、**現在地と同じ id で意図的に**呼ぶ。
    // **関数の先頭にも置けない**: `ensureRootPresent` ごと飛ばすと、今いるプロジェクトの
    // root が消えたときに clone を提案できなくなる。
    if (mode === 'switch' && id === currentProject.value?.id) return
    await open()
    // ここまで来た `focusOrSwitch` は「他にウィンドウが無いので**このウィンドウが引き受けた**」
    // （見つかっていれば上の行で return している）。**前に出すところまでがモードの意味**で、
    // 埋めないと「他のウィンドウなら前に出すが、自分のウィンドウなら出さない」という非対称が
    // 残る。#340（通知からのコールドスタートで、あとから出てきた子ウィンドウにフォーカスを
    // 奪われる）は、その穴が表に出た場面。
    //
    // **`open` の中に入れないこと。** あれは clone の完了後（`ensureRootPresent` の
    // `onCloned`）にも走る。clone はターミナルで数分かかりうるので、そこで前に出すと、
    // 別のアプリを使っている利用者からフォーカスを奪う。
    //
    // **このモードはフォーカスを奪うようになった。** 通知由来の経路（`useAgentNotice` は今
    // `'switch'`）が乗り換えると、「見えているものには何もしない」という #265 の方針を
    // 黙って破る。
    if (mode === 'focusOrSwitch') await windowRestore().catch(() => {})
  }

  /** Open a project this window was handed rather than picked: the startup
   *  restore, and the windows the backend opens for the jump list, the tray or a
   *  CLI launch. The offer to clone can only come after the window is showing
   *  the project, so a successful clone reopens it (#212). Kept as one call so
   *  no caller can do the first half and forget the second. */
  async function adoptProject(id: string, opts?: { restoreSession?: boolean }): Promise<void> {
    // An id the registered list doesn't have is either a transient project (#230)
    // the backend made for this window, or a project that vanished. Resolve the
    // former before switching; the root of a directory just opened is there by
    // definition, so the clone offer below doesn't apply to it.
    if (!projects.value.some((p) => p.id === id)) {
      const transient = await projectTransientGet(id).catch(() => null)
      if (transient) {
        // 一時プロジェクトの据え付けと `projectTransientBind` は `switchProject` の持ち物。
        await switchProject(id, { ...opts, transient })
        // Not awaited, for the same reason the clone offer below isn't: the
        // caller's startup sequence must not park on a dialog waiting for a
        // human. Kept in here rather than in the caller so a future adopt path
        // cannot open a directory and silently never ask about it.
        offerToRegisterDirectory().catch(() => {})
        return
      }
      // 一時でもないなら、このウィンドウの一覧が古い（#352）。Rust はディスクから読むので、
      // 別のウィンドウが登録した / 同期で入ったプロジェクトを渡されうる。`applyExternalUpdate`
      // は既にある id しか差し替えないため、足さないと下の `switchProject` が黙って戻る。
      // **全件ではなく 1 件だけ読む**: 一覧の読み直しは `project.json` を全部開くので、
      // 「渡された id が無い」を直すには高すぎる。
      const fresh = await projectGet(id).catch(() => null)
      if (fresh) projects.value = [...projects.value, fresh]
    }
    await switchProject(id, opts)
    ensureRootPresent(id, () => void switchProject(id, opts)).catch(() => {})
  }

  /**
   * Decide whether the directory this window opened should become a project
   * (#230, 設定は #286)。
   *
   * 粒度が 2 段ある。**素の「いいえ」はそのディレクトリだけ**を記録して二度と聞かない
   * （switcher の「ディレクトリを開く」も開いた時点で同じ記録をするので、あの経路は
   * ここに来ない）。**「今後は確認しない」を付けたときだけ設定そのもの**を切り替える。
   */
  async function offerToRegisterDirectory(): Promise<void> {
    const project = transientProject.value
    if (!project || !isTransient.value) return
    const settings = useSettingsStore()
    if (settings.registerDirectory === 'never') return
    if (settings.registerDirectory === 'auto') {
      await registerTransientProject()
      return
    }
    if (settings.skipsRegisterPrompt(project.root)) return
    const { ok, checked } = await confirmWithOption(
      t('project.registerDirectoryConfirm', { root: project.root }),
      t('project.registerDirectoryRemember'),
    )
    if (checked) settings.registerDirectory = ok ? 'auto' : 'never'
    if (ok) await registerTransientProject()
    else settings.rememberTransientRoot(project.root)
  }

  /**
   * 最近開いたディレクトリ（#271）。**マシン全体**で持つ（`localStorage`）: ファイルの
   * 履歴と違い、「どのプロジェクトからでも同じ場所に戻りたい」ものなので、プロジェクトで
   * 分けると用を成さない。同期の対象にもしない（パスはマシンごと）。
   */
  const RECENT_DIRS_KEY = 'pike:recent-dirs'
  const MAX_RECENT_DIRS = 10
  const recentDirs = ref<string[]>(loadJson<string[]>(RECENT_DIRS_KEY, []))

  /**
   * フォルダ選択ダイアログの初期位置（#271）。WSL プロジェクトでは
   * `wsl.localhost` の UNC にして、そのまま WSL の中から選べるようにする。
   * プロジェクトが無ければ既定（＝ダイアログ任せ）。
   */
  function pickerStartDir(): string | undefined {
    const project = currentProject.value
    if (!project) return undefined
    const root = project.root
    if (project.shell.kind === 'wsl' && root.startsWith('/')) {
      return wslNativeToUnc(project.shell.distro, root)
    }
    return root
  }

  function trackRecentDir(path: string) {
    recentDirs.value = pushRecent(recentDirs.value, path, RECENT_DIRS_KEY, MAX_RECENT_DIRS)
  }

  /**
   * 最近開いたファイル（#271）。**プロジェクトごとに分ける**（上のディレクトリとは逆）:
   * 他プロジェクトのファイルが混ざると、パレットで上位に出す意味が無くなる。
   *
   * ディレクトリの履歴と同じくストアが持つ。プロジェクト id を見て読み直す仕掛けは
   * `fileTree` の `expanded` や `tasks` の折り畳みと同じもので、コンポーネント側に
   * 書くと「最近開いたファイル」を読みたい画面が増えるたびに写しが増える。
   */
  const MAX_RECENT_FILES = 20
  const recentFiles = ref<string[]>([])

  function recentFilesKey(): string | null {
    const id = currentProject.value?.id
    return id ? `pike:recent-files:${id}` : null
  }

  watch(
    () => currentProject.value?.id,
    () => {
      const key = recentFilesKey()
      recentFiles.value = key ? loadJson<string[]>(key, []) : []
    },
    { immediate: true },
  )

  function trackRecentFile(path: string) {
    const key = recentFilesKey()
    if (!key) return
    recentFiles.value = pushRecent(recentFiles.value, path, key, MAX_RECENT_FILES)
  }

  /**
   * Open a directory without registering it (#230): the window behaves like a
   * project window, but nothing is written to disk and the config dies with it.
   *
   * **登録するかは設定に従う（#286）。** 以前は「この操作を選ぶこと自体が答え」とみなして
   * 黙って一時プロジェクトにし、その root を二度と聞かない側へ記録していた。設定に
   * 「確認する」を置いた以上そちらが優先で、実際「確認するのに聞かれない」という形で出た。
   *
   * `alreadyChose` は、呼び出し側が既に登録するかを選ばせている場合（`EditorTab` の
   * ディレクトリ用の 2 択）。そこで聞き直すと、同じことを続けて 2 回聞くことになる。
   */
  async function openDirectory(
    path: string,
    mode?: 'switch' | 'window',
    opts?: { alreadyChose?: boolean },
  ): Promise<void> {
    trackRecentDir(path)
    // 既定は「ここで開く」。ただしプロジェクトを持たないウィンドウは自分がその
    // ディレクトリの入れ物になれないので新しいウィンドウへ。この判断を呼び出し側に
    // 置くと入口ごとに書き写すことになる（実際 1 箇所が `.value` を落として
    // 常に新しいウィンドウを開いていた）。
    const settings = useSettingsStore()
    const target = mode ?? (globalMode.value ? 'window' : 'switch')
    const decided = opts?.alreadyChose === true
    if (!decided && settings.registerDirectory === 'auto') {
      await openDirectoryAsProject(path, target)
      return
    }
    const config = await projectTransientCreate(path, distroHintFor(path))
    // 呼び出し側で選んだ結果なら、そのディレクトリは以後聞かない側に倒す。
    if (decided) settings.rememberTransientRoot(config.root)
    if (target === 'window') {
      // 新しいウィンドウは自分で adopt して聞くので、ここでは聞かない。
      await openProjectWindow(config.id)
      return
    }
    // 据え付けも `projectTransientBind` も `switchProject` の持ち物（#352。自分で
    // `transientProject` を差し替えると、離れる側の後始末が飛ぶ）。
    if (!(await switchProject(config.id, { transient: config }))) return
    // 聞くかどうかの判断は `offerToRegisterDirectory` の 1 箇所に寄せてある（設定が
    // `never` なら黙って戻る）。**await しない**: CLI の adopt と同じ理由で、開く処理を
    // ダイアログの答えで止めない。
    if (!decided) offerToRegisterDirectory().catch(() => {})
  }

  /**
   * The distro to build a config for `path` under, or null for none.
   *
   * A native WSL path (`/home/...`) carries no distro of its own — the backend
   * can only read one out of a `\\wsl.localhost\<distro>\...` UNC path — so a
   * path that came from inside a WSL project (terminal output, a link) needs the
   * window's own distro passed alongside it. Without this the directory is built
   * as a Windows project and the new window looks for `/home/...` on the C:
   * drive. Windows and UNC paths must not get a hint: it would win over the path.
   */
  function distroHintFor(path: string, from?: ShellType): string | null {
    if (!path.startsWith('/')) return null
    // **渡されたシェルを優先する**（#373）。ターミナルの cwd から登録する経路は、その
    // タブのシェルを知っている。ウィンドウの今のプロジェクトを見るだけだと、グローバル
    // モードの WSL ターミナル（プロジェクトが無い）で distro を取りこぼす。
    const shell = from ?? currentProject.value?.shell
    return shell?.kind === 'wsl' ? shell.distro : null
  }

  /**
   * このウィンドウが登録せずに開いているディレクトリ（#230）の root か（#373）。
   *
   * **`projectForRoot` では引けない。** あちらが見る `projects` は登録済みの一覧で、
   * `transientProject` は意図的にそこから外してある（一覧・同期・ジャンプリストに
   * 出さないため）。ここを通さないと同じ root で 2 つ目の id が生まれ、`placeProject` の
   * 切り替えが「一時プロジェクトから離れる」枝に入って**今開いているタブを全部閉じる**
   * （右クリックしたターミナルごと消える）。`registerTransientProject` なら id を保った
   * まま登録し、タブの持ち主も付け替える。
   */
  function matchesTransient(root: string): boolean {
    const transient = transientProject.value
    return !!transient && isTransient.value && rootKey(transient.root) === rootKey(root)
  }

  /** The registered project whose root is this path, if there is one. */
  function projectForRoot(root: string): ProjectConfig | null {
    const key = rootKey(root)
    return projects.value.find((p) => rootKey(p.root) === key) ?? null
  }

  /**
   * Register a directory as a project and open it. The counterpart to
   * `openDirectory` for someone who already knows they want to keep it — the
   * directory actions an editor tab offers when a path turns out to be one.
   *
   * The config comes from the same backend inference the transient path uses
   * (platform / shell / WSL distro), so a path clicked in terminal output gets
   * the defaults a directory picked in the switcher would get. `placeProject`
   * is the creation entry point: the root was just probed, so there is nothing
   * for `openProject`'s clone check to do.
   *
   * **選んだパスがプロジェクトになるのはここだけ**（#373。そのウィンドウ自身が登録せずに
   * 開いているディレクトリは `registerTransientProject` が受ける。3 つ目の入口を足さない
   * こと）。以前あった「新規プロジェクト」のフォーム 2 つ（パネルとスイッチャー）は、
   * 同じことを 7 項目で聞いていたので落とした。プラットフォーム・シェル・distro は
   * root から推測できるもので、実際この経路が推測している。
   *
   * `from` は、パスの出どころのシェル（ターミナルの cwd から登録する経路）。
   */
  async function openDirectoryAsProject(path: string, mode: 'switch' | 'window', from?: ShellType): Promise<void> {
    const existing = projectForRoot(path)
    if (existing) {
      await openProject(existing.id, mode)
      return
    }
    // **このウィンドウが登録せずに開いているディレクトリなら、それを登録する**（#373。
    // 理由は `matchesTransient` の doc）。**生のパスで先に引く**ので、当たるうちは
    // `projectTransientCreate` の往復ごと省ける。
    if (matchesTransient(path)) {
      await registerTransientProject()
      return
    }
    const config = await projectTransientCreate(path, distroHintFor(path, from))
    // 比べるために作っただけの一時プロジェクトの後始末。**失敗は握り潰す**（もう
    // 無ければそれでよい）ので、その作法を 1 か所に残す。
    const dropConfig = () => projectTransientDrop(config.id).catch(() => {})
    // **正規化した root でもう一度引く。** `rootKey` は区切りと大小を揃えるだけなので、
    // WSL を UNC（`\\wsl.localhost\<distro>\home\…`）で選ぶと登録済みの native な root
    // （`/home/…`）と一致しない。バックエンドは UNC から distro を読んで native に直すので、
    // ここで引き直さないと同じディレクトリを指すエントリが 2 つ `project.json` に残る
    // （フォルダ選択ダイアログは WSL を UNC で返すため、普通の操作で踏む）。同じ理由で、
    // 一時プロジェクトとの突き合わせもここでやり直す。
    if (matchesTransient(config.root)) {
      await dropConfig()
      await registerTransientProject()
      return
    }
    const same = projectForRoot(config.root)
    if (same) {
      await dropConfig()
      await openProject(same.id, mode)
      return
    }
    const stored = { ...config, id: uniqueProjectId(config.id), lastOpened: new Date().toISOString() }
    await dropConfig()
    await addProject(stored)
    useSettingsStore().forgetTransientRoot(stored.root)
    await placeProject(stored.id, mode)
    // **登録したときだけ知らせる**（#373）。名前・色・アイコンを聞かなくなったぶん、
    // 何が起きたかを言わないと「開いただけ」と区別が付かない。既に登録済みだった枝は
    // 普通に開くだけなので出さない（一時プロジェクトの枝は向こうが出す）。
    notifyRegistered(stored.name)
  }

  /**
   * 登録したことの知らせ（#373）。**編集フォームは開かない**: 色やアイコンを付けない人に
   * 閉じる手間が増えるので、直したい人がプロジェクトパネルの鉛筆へ行く形にする。
   */
  function notifyRegistered(name: string) {
    useStatusMessageStore().show({
      text: t('project.registeredHint', { name }),
      variant: 'success',
      durationMs: 6000,
    })
  }

  /**
   * Turn the directory this window opened into a registered project.
   *
   * The backend kept the id unique against the registered and transient ones,
   * but it cannot see the hidden list (#164) — that lives in localStorage — so
   * the id is re-checked here before it is written. `projectAddOpen` then points
   * `window_projects` at whatever id won, which is also what keeps focus and CLI
   * routing on this window when the slug had to change.
   */
  async function registerTransientProject(): Promise<void> {
    const config = transientProject.value
    if (!config || !isTransient.value) return
    const stored = { ...config, id: uniqueProjectId(config.id), lastOpened: new Date().toISOString() }
    await addProject(stored)
    await projectTransientDrop(config.id).catch(() => {})
    transientProject.value = null
    // 登録で id が変わるので、開いているタブの持ち主も付け替える（#264）。
    useTabStore().renameProjectOwner(config.id, stored.id)
    currentProject.value = projects.value.find((p) => p.id === stored.id) ?? stored
    useSettingsStore().forgetTransientRoot(stored.root)
    await projectAddOpen(stored.id).catch(() => {})
    await flushSession()
    notifyRegistered(stored.name)
  }

  /**
   * Make sure a project's root is on this machine before it is opened (#212).
   * Projects the sync file brought in (#164) are not cloned here until someone
   * asks for them, so any list of projects can offer one that has no local copy.
   *
   * Returns whether the root is there now. `false` means the caller must not
   * open the project: either there is no origin URL to clone from, or a clone
   * just started and `onCloned` runs once it lands.
   */
  async function ensureRootPresent(id: string, onCloned: () => void | Promise<void>): Promise<boolean> {
    // Read the batched answer rather than probing this one root: every surface
    // that offers a project keeps it fresh (the panel and the switcher refresh
    // on open, the list watcher re-probes on any change), the batch costs one
    // `wsl.exe` launch per distro instead of one per project, and the badge in
    // those lists then cannot disagree with what happens on click.
    await checkRoots().catch(() => {})
    if (!missingRoots.value.has(id)) return true
    const project = projects.value.find((p) => p.id === id)
    if (!project) return false
    if (!project.remoteUrl) {
      await infoDialog(t('project.missingNoRemote', { name: project.name, root: project.root }))
      return false
    }
    if (await confirmDialog(t('project.cloneConfirm', { name: project.name, url: project.remoteUrl }))) {
      cloneProject(id, onCloned)
    }
    return false
  }

  // --- Project list sync (#164) -------------------------------------------
  // The list rides in the same file as the UI settings but under its own key,
  // because the whole section is not replaced wholesale: a machine publishes the
  // projects it has and leaves every other entry alone, so nobody's list is ever
  // dropped by a machine that has never seen it. What stays local: the real path
  // (only the base-relative part travels), shell, pinned tabs, session, recency,
  // and agent session ids.

  /** Projects visible on this machine — hidden ones (#164) are filtered out. */
  const visibleProjects = computed(() => projects.value.filter((p) => !useSettingsStore().isProjectHidden(p.id)))

  /**
   * 最近開いた順の並び（#354）。スイッチャーとプロジェクトパネルの「最近開いた順」が
   * **同じ規則を読む**ための比較関数。
   *
   * **バックエンドの並びに頼らないこと。** `project_list` は `lastOpened` の降順で返すが、
   * それは**読み込んだ時点の順**でしかない。`switchProject` は配列の中の `lastOpened` を
   * 書き換えるだけで並べ替えないので、そのままだと**セッション中どれだけ行き来しても
   * 並びが起動時のまま**になり、いま出てきたプロジェクトが上に来ない。
   *
   * 時刻は固定幅の ISO なので素の比較で足りる（`localeCompare` は要らない）。同じ時刻の
   * とき（同期で入ってきた直後など）は名前で決める: 並びが実行のたびに変わらないほうが、
   * 位置で覚えて押せる。
   */
  function byRecency(a: ProjectConfig, b: ProjectConfig): number {
    if (a.lastOpened !== b.lastOpened) return a.lastOpened < b.lastOpened ? 1 : -1
    return a.name.localeCompare(b.name)
  }

  const recentProjects = computed(() => [...visibleProjects.value].sort(byRecency))

  /** Portable form of a project, or null when it cannot be shared: no base set
   *  for its platform, or a root outside that base. */
  function toSynced(project: ProjectConfig, base: ProjectBase): SyncedProject | null {
    const platform = shellToPlatform(project.shell)
    const path = relativeToBase(baseForPlatform(base, platform), project.root, platform)
    if (path === null) return null
    return {
      id: project.id,
      name: project.name,
      platform,
      path,
      color: project.color,
      icon: project.icon,
      group: project.group,
      remoteUrl: project.remoteUrl,
      golangciCommand: project.golangciCommand,
      order: project.order,
    }
  }

  /** Projects that stay on this machine: no base set for their platform, or a
   *  root outside it. Surfaced in settings so the exclusion isn't silent. */
  const unsyncableProjects = computed(() => projects.value.filter((p) => !toSynced(p, useSettingsStore().projectBase)))

  /** 同期する形のプロジェクト（#403。基準のディレクトリの外にあるものは含めない）。 */
  function syncableProjects(): SyncedProject[] {
    const base = useSettingsStore().projectBase
    return projects.value.map((p) => toSynced(p, base)).filter((p): p is SyncedProject => p !== null)
  }

  /**
   * 同期のマージの結果（#403）を手元に反映する。**決めるのはマージの側**で、ここは言われた
   * 状態に合わせるだけ。
   *
   * **変えるのは、マージに使った手元（`before`）から結果が変わったところだけ。** 同期の
   * 最中（同期ファイルの読み込みを待つあいだ）に利用者が変えたものを、開始時点の値で
   * 巻き戻さないため。
   *
   * - `before` にあるもの（このマシンから出したもの）は、結果で変わったフィールドだけを
   *   そろえる。結果に無ければ、他のマシンで消されたのでここでも消す
   * - 手元にあるが `before` に無いもの（base の外にあって同期しない）には触らない
   * - 手元に無いものは、このマシンの基準のディレクトリの下に作る。作れない（基準が無い、
   *   WSL の distro が無い）ものと、同じリポジトリを別の id で既に持っているものは作らない。
   *   どちらもファイルには残る（同期の側がこのマシンの「追っていない」ものとして据え置く）
   * - このマシンで消したもの（非表示の記録）が結果にあるのは、削除を伝える記録
   *   （`shared`）なら衝突で「残す」を選んだときだけなので、記録を外して作り直す。#403 より
   *   前の記録（このマシンでだけ隠す）は作らない
   */
  async function applySyncedProjects(
    target: { projects: SyncedProject[]; groups: string[] },
    before: { projects: SyncedProject[]; groups: string[] },
  ): Promise<SyncApplyResult> {
    const result: SyncApplyResult = { created: 0, updated: 0, removed: 0, unresolvable: 0 }
    const settings = useSettingsStore()
    const base = settings.projectBase
    const entries = target.projects
    const published = new Map(before.projects.map((p) => [p.id, p]))
    // Re-read first: writing back a config this window loaded at startup would
    // roll back the session another window has been updating since.
    await loadProjects()
    const known = new Map(projects.value.map((p) => [p.id, p]))
    // What counts as "a project this machine already decided about", by every
    // key that survives the trip through the file. Ids do not: one repository
    // ends up with an id per machine that registered it separately, so an entry
    // is matched by where it lands and what it clones from as well.
    //
    // Kept together because the two readers below must agree — the dedup, so a
    // second copy is not created and then pushed back, and the deletion check,
    // so a sibling entry cannot recreate what was deleted here. Origins compare
    // normalized: the same repository reaches the file as
    // `git@host:owner/repo.git` from one machine and `https://host/owner/repo`
    // from another, and a raw comparison reads those as two projects.
    const compactSet = (values: (string | null | undefined)[]) => new Set(values.filter((v): v is string => !!v))
    const localRemotes = compactSet(projects.value.map((p) => normalizeRemoteUrl(p.remoteUrl)))
    const localRoots = compactSet(projects.value.map((p) => rootKey(p.root)))
    // Patches to known projects go out together at the end: a shared order (#203)
    // touches every project in a reordered group.
    const patched: ProjectConfig[] = []
    for (const entry of entries) {
      const local = known.get(entry.id)
      if (local) {
        const prev = published.get(entry.id)
        if (!prev) continue
        // 置き場所（platform / path）は作るときにだけ使う（`lib/syncFormat.ts` の
        // `CREATE_ONLY_FIELDS`）。残りは、結果で変わったフィールドだけをそろえる。
        const changed = SYNCED_FIELDS.filter((f) => entry[f] !== prev[f] && entry[f] !== local[f])
        if (changed.length > 0) patched.push({ ...local, ...Object.fromEntries(changed.map((f) => [f, entry[f]])) })
        continue
      }
      if (settings.isProjectHidden(entry.id)) {
        // #403 より前の記録（このマシンでだけ隠す）は作らない。
        if (!settings.isProjectDeletedForSync(entry.id)) continue
        // 衝突で「残す」を選んだ（手元で消していた）もの。記録を外して作り直す。
        settings.unhideProject(entry.id)
      }
      const baseDir = isProjectPlatform(entry.platform) ? baseForPlatform(base, entry.platform) : ''
      // Unresolvable here: an unknown platform, no base for it, or (for WSL) no
      // distro to resolve it in. The entry stays in the file for a machine that has one.
      if (!baseDir || (entry.platform === 'wsl' && !base.wslDistro)) {
        result.unresolvable++
        continue
      }
      const root = joinBase(baseDir, entry.path, entry.platform)
      const key = rootKey(root)
      if (localRoots.has(key)) continue
      const remote = normalizeRemoteUrl(entry.remoteUrl)
      if (remote && localRemotes.has(remote)) continue
      // A sibling entry for a repository deleted here (another machine's id for the
      // same checkout) is recognised by where it lands and what it clones from.
      // 読むのはここ（ループの前に集めない）: すぐ上で記録を外したものを数えないため。
      const deleted = settings.hiddenProjects.some(
        (h) => (h.root && rootKey(h.root) === key) || (remote && normalizeRemoteUrl(h.remoteUrl) === remote),
      )
      if (deleted) continue
      await addProject({
        id: entry.id,
        name: entry.name,
        root,
        // 同期ファイルはプラットフォームしか持たないので、シェルはこのマシンの
        // 流儀で決める（`unix` はローカルのログインシェル 1 つしかない）。
        shell: buildShell(entry.platform, base.wslDistro, settings.defaultWindowsShellKind()),
        pinnedTabs: [],
        lastOpened: new Date().toISOString(),
        color: entry.color,
        icon: entry.icon,
        group: entry.group,
        remoteUrl: entry.remoteUrl,
        golangciCommand: entry.golangciCommand,
        order: entry.order,
      }).catch(() => {})
      localRoots.add(key)
      if (remote) localRemotes.add(remote)
      result.created++
    }
    result.updated = patched.length
    await Promise.all(patched.map((config) => saveProject(config).catch(() => {})))
    // 他のマシンで消されたもの。タブの後始末で断られたら残る（次の同期でまた出て行く）。
    const kept = new Set(entries.map((e) => e.id))
    for (const p of [...projects.value]) {
      if (!published.has(p.id) || kept.has(p.id)) continue
      await removeProject(p.id).catch(() => {})
      if (!projects.value.some((q) => q.id === p.id)) result.removed++
    }
    // グループは結果の一覧と順にそろえる。プロジェクトが参照しているのに一覧に無いものは
    // 後ろへ足す（`loadGroups` と同じ扱い）。**同期の最中に手元で変えていたら触らない**
    // （開始時点の一覧で巻き戻さない。次の同期で手元の変更として出て行く）。
    const beforeGroups = stableKey(before.groups)
    if (stableKey(target.groups) !== beforeGroups && stableKey(groups.value) === beforeGroups) {
      const referenced = projects.value.map((p) => p.group?.trim()).filter((g): g is string => !!g)
      groups.value = [...new Set([...target.groups, ...referenced])]
      await persistGroups()
    }
    if (result.created > 0) await checkRoots(true)
    return result
  }

  // Keep `missingRoots` owned by the store rather than by whoever happens to
  // render the list: any change to the set of roots re-probes, so every entry
  // point (panel, switcher) sees the same answer. Keyed on id+root only, so
  // recency and session writes don't re-probe.
  watch(
    () => projects.value.map((p) => `${p.id} ${p.root}`).join('\n'),
    () => {
      checkRoots(true).catch(() => {})
    },
  )

  // Rebuild the taskbar jump list (#160) and system-tray menu (#161) whenever a
  // menu-relevant field changes: the project set, a name/root edit, recency
  // order, the UI locale (label language), or the visible shell list (#240 —
  // both menus offer a terminal per shell, and WSL entries only appear once
  // detection has run). Keyed on exactly those fields so ~1s-debounced
  // session-flush writes — which mutate `lastSession` on objects that also live
  // in `projects` — do NOT trigger a refresh: Vue's per-property tracking never
  // re-runs this getter for `lastSession`. Both are single per-process OS
  // resources (Rust dedups the jump list by signature), so refreshing from any
  // window is enough. Best-effort, Windows-only; each persists from the last
  // run so a failed refresh just goes slightly stale.
  watch(
    () =>
      JSON.stringify([
        locale.value,
        projects.value.map((p) => [p.id, p.name, p.root, p.lastOpened]),
        useSettingsStore().menuShells,
        // キーのプリセット（#261）。メニューのアクセラレータは割り当ての表から引くので、
        // 切り替えたら張り直さないと macOS のメニューだけ古いキーを出し続ける。
        useSettingsStore().shortcutPreset,
      ]),
    () => {
      menusRefresh(locale.value, useSettingsStore().menuShells, menuActions()).catch(() => {})
    },
    // **macOS では初回が要る（#254）。** あちらのメニューは起動時には空で、これが
    // 埋める唯一の経路。グローバルモードのウィンドウは `loadProjects()` を呼ばず、
    // locale もシェル一覧も localStorage から読み終わっているので、これが無いと
    // キーが 1 つも無いメニューバーのまま座り続ける。
    //
    // **mac 以外では走らせない。** あちらの `appmenu::refresh` は何もしないスタブなのに、
    // `menus_refresh` は毎回**全プロジェクトの `project.json` を読み直す**（このマシンは
    // 40 件）。復元するウィンドウの枚数だけ、起動直後のいちばん混む時間帯に空振りする。
    { immediate: isMacHost },
  )

  // 保持しているプロジェクトを backend に伝える（#264）。ジャンプリスト / トレイ /
  // `pike <dir>` の解決はあちらで行われるので、伝えないと保持中のプロジェクトを開く
  // たびに新しいウィンドウができ、同じリポジトリでエージェントが二重に動く。
  // 監視する値をそのまま使う（id は slug なので空白を含まない）。タブが動くたびに
  // `heldProjects` は新しい配列になるので、配列を直接 watch すると中身が同じでも発火する。
  watch(
    () => heldProjects.value.map((p) => p.id).join(' '),
    (key) => {
      // 復元待ちのぶんも含める。含めないと、`pike <そのパス>` が新しいウィンドウを開いて
      // しまい、このウィンドウが覚えている意味が無くなる。
      projectSetParked(key ? key.split(' ') : []).catch(() => {})
    },
  )

  async function loadGroups() {
    try {
      const stored = await projectGroupsList()
      const set = new Set(stored)
      let added = false
      for (const p of projects.value) {
        const g = p.group?.trim()
        if (g && !set.has(g)) {
          stored.push(g)
          set.add(g)
          added = true
        }
      }
      groups.value = stored
      if (added) await persistGroups()
    } catch {
      groups.value = []
    }
  }

  async function persistGroups() {
    try {
      await projectGroupsSave(groups.value)
    } catch {
      // best-effort
    }
  }

  async function addGroup(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    if (groups.value.includes(trimmed)) return
    groups.value = [...groups.value, trimmed]
    await persistGroups()
  }

  async function renameGroup(oldName: string, newName: string) {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) return
    if (groups.value.includes(trimmed)) {
      // merge into existing group
      groups.value = groups.value.filter((g) => g !== oldName)
    } else {
      groups.value = groups.value.map((g) => (g === oldName ? trimmed : g))
    }
    await persistGroups()
    const targets = projects.value.filter((p) => p.group === oldName)
    await Promise.all(targets.map((p) => saveProject({ ...p, group: trimmed })))
  }

  async function removeGroup(name: string) {
    groups.value = groups.value.filter((g) => g !== name)
    await persistGroups()
    const targets = projects.value.filter((p) => p.group === name)
    await Promise.all(targets.map((p) => saveProject({ ...p, group: undefined })))
  }

  async function setProjectGroup(projectId: string, group: string | undefined) {
    const project = projects.value.find((p) => p.id === projectId)
    if (!project) return
    const normalized = group?.trim() ? group.trim() : undefined
    if (project.group === normalized) return
    // The manual position belongs to the group it was set in (#203): carrying it
    // over would drop the project into the middle of the new one. Without an
    // order it lands at the end, where the drop happened.
    await saveProject({ ...project, group: normalized, order: undefined })
    if (normalized) await addGroup(normalized)
  }

  /** Put the groups in this order (#203). The array order IS the stored order,
   *  so reordering is just a rewrite of groups.json. */
  async function reorderGroups(ordered: string[]) {
    // Keep any group the caller did not mention (another window may have added
    // one since the panel rendered) instead of dropping it from the file.
    const rest = groups.value.filter((g) => !ordered.includes(g))
    const next = [...ordered, ...rest]
    // The sync pull calls this on every launch with the shared order, which is
    // usually the order already on disk.
    if (next.length === groups.value.length && next.every((g, i) => g === groups.value[i])) return
    groups.value = next
    await persistGroups()
  }

  /**
   * Assign `order` 0..n-1 along `orderedIds`, optionally moving them all into
   * `group` (#203). Only projects whose stored values actually change are
   * written: each save is a whole-object `project_update` plus a cross-window
   * broadcast, so a drag that shifts one row should not rewrite the group.
   */
  async function reorderProjects(orderedIds: string[], group: string | undefined) {
    const normalized = group?.trim() ? group.trim() : undefined
    const writes: ProjectConfig[] = []
    orderedIds.forEach((id, index) => {
      const project = projects.value.find((p) => p.id === id)
      if (!project) return
      if (project.order === index && project.group === normalized) return
      writes.push({ ...project, order: index, group: normalized })
    })
    // Parallel like renameGroup/removeGroup: an insertion at the top shifts the
    // whole group, and each write is its own file.
    await Promise.all(writes.map((config) => saveProject(config)))
    if (normalized) await addGroup(normalized)
  }

  /**
   * 前回のセッションを復元する（`last_project.txt` の 1 行につき 1 ウィンドウ、#264）。
   *
   * `focus` を渡すと、**復元で開いた子ウィンドウが出そろってから**そのプロジェクトを前に
   * 出す（通知からのコールドスタート、#334 / #340）。子ウィンドウは表示のたびにフォーカスを
   * 取るので、先に前へ出しても後から出てきたものに奪われる。
   *
   * **順序をこの関数の中に閉じてあるのは、半分だけ呼んで後半を忘れられないようにするため**
   * （`adoptProject` と同じ理由）。待ち合わせの handle を返す形にすると、2 人目の呼び出し元が
   * 待ち忘れても型検査も lint も通り、症状は #340 と同じ「コールドスタートのときだけ
   * フォーカスが当たらない」になる。
   *
   * **前に出すところは await しない。** main の mount の続き（listener の登録・`initCliOpen`）を
   * 子ウィンドウの生成で止めない（`isElevated` / `offerAgentHook` と同じ扱い）。`focus` が
   * 無ければ待つものも無い。
   */
  async function restoreLastProject(focus?: string): Promise<void> {
    await loadProjects()
    // 同期（#403）は起動時に読まない。いつ同期するかは同期の調停役（`stores/sync.ts`）が決める。
    // 消してから各ウィンドウに書き直させる、はもう要らない（#264）。書き込みは生きて
    // いるウィンドウからの全量書き直しなので、古い行は最初の `project_add_open` で消える。
    const sessions = await projectGetLast().catch(() => [] as WindowSession[])
    const known = (id: string) => projects.value.some((p) => p.id === id)
    // 復元で開いた子ウィンドウ。1 枚ずつ待たない（生成は Rust 側でどのみち直列化される）ので、
    // 入るのは「開き終わった」Promise。落ちた 1 枚が下の待ち合わせを壊さないよう、失敗は
    // ここで潰してある。
    let opened: Promise<void>[] = []
    if (sessions.length > 0) {
      // Main window opens the first window's project, and remembers what that
      // window was holding (#264).
      const main = sessions[0]
      if (known(main.shown)) {
        await adoptProject(main.shown)
        setHeldProjects(main.held.filter(known))
      }
      // Remaining windows open separately, each adopting its own (#212)
      opened = sessions
        .slice(1)
        .filter((session) => known(session.shown))
        .map((session) => openProjectWindow(session.shown, session.held.filter(known)).catch(() => {}))
    } else {
      // Nothing to restore: show the switcher so the user can open/create a
      // project or switch this window into global mode. Shown even with zero
      // projects (first-ever launch) so the global-mode entry is reachable.
      showSwitcher.value = true
    }
    if (!focus) return
    void Promise.all(opened)
      .then(() => openProject(focus, 'focusOrSwitch'))
      .catch(() => {})
  }

  async function switchProject(
    id: string,
    opts?: { restoreSession?: boolean; transient?: ProjectConfig },
  ): Promise<boolean> {
    if (saveTimer) clearTimeout(saveTimer)
    const tabStore = useTabStore()
    const searchStore = useSearchStore()
    // **一時プロジェクト（#230）の入れ替えはここが唯一の場所（#352）。** 呼び出し側で
    // `transientProject` を先に差し替えると、下の「離れる側の後始末」が自分自身を見て
    // 素通りする（`id !== id` にならない）。一時 → 一時の切り替えで、確認も
    // `closeProjectTabs` も `projectTransientDrop` も飛ばされ、**一覧に出ないのに
    // プロセスを抱えたタブ**が残る。`pike <未登録 dir>` を続けて叩くと踏む。
    const project = opts?.transient ?? findProject(id)
    if (!project) return false
    // Moving this window off a transient project (#230) is the end of that
    // project: drop it here rather than at window close, or `pike <that dir>`
    // would keep focusing a window that no longer shows it.
    if (transientProject.value && transientProject.value.id !== id) {
      const leaving = transientProject.value
      // **破棄されることを先に言う**（#271）。登録済みのプロジェクトは切り替えても
      // タブが残るので、ここだけ挙動が違う。黙って捨てると、戻ってきて初めて気付く。
      // タブが無ければ失うものが無いので聞かない。
      if (tabStore.hasTabsFor(leaving.id)) {
        if (!(await confirmDialog(t('project.confirmLeaveTransient', { name: leaving.name })))) return false
      }
      // **タブを先に手放す**（#264）。パークだけして記録を消すと、一覧にも出ず
      // 切り替えても戻れない id のタブが、プロセスを抱えたまま残る。断られたら
      // 切り替え自体をやめる（記録だけ消すと、同じ迷子のタブができる）。
      if (!(await tabStore.closeProjectTabs(leaving.id))) return false
      forgetHeld(leaving.id)
      projectTransientDrop(leaving.id).catch(() => {})
      transientProject.value = null
    }
    // 離れる側を片付けたあとで、入る側を据える（`isTransient` は `currentProject` と
    // 突き合わせるので、下の `projectAddOpen` のガードより前であればよい）。
    if (opts?.transient) transientProject.value = opts.transient
    // Elevated admin project window opens the project context only; the caller
    // adds the single pinned-shell terminal, so skip session/pinned restore.
    const restore = opts?.restoreSession !== false

    searchStore.clear()
    useDiagnosticsStore().clear()
    useTaskStore().clear()
    useIssuesStore().clear()
    // **エージェントの検出は捨てない**（#275）。あちらはシェルごとの表を持っていて、
    // 切り替え先のシェルが違えば別のキーを引くだけ。捨てると、有効な答えを消したうえで
    // 「タブが見えたら取り戻す」という後始末が要る。
    activeWorktreeRoot.value = null

    // 切り替えではタブを捨てない（#264）。ターミナルのプロセスとエージェントのセッションを
    // 生かしたままパークし、戻ってきたらそのまま見せる。**復元するかは切り替える前に
    // 決める**（パークしたぶんが既にあるなら、復元すると二重になる）。
    const shouldRestore = restore && !tabStore.hasTabsFor(id)
    tabStore.setOwnerProject(id)

    project.lastOpened = new Date().toISOString()
    currentProject.value = project

    // A transient project (#230) has no file to update and must stay out of the
    // open list, or the throwaway directory would reopen on the next plain launch.
    // Fire-and-forget: don't block tab restoration on metadata persistence
    if (!isTransient.value) {
      Promise.all([projectUpdate(project).catch(() => {}), projectAddOpen(id).catch(() => {})])
    } else {
      // 一時プロジェクトの `projectAddOpen` にあたるもの（#352）。**ここが置き場**:
      // 呼び出し側に任せていたころは、切り替えが成ったかを各自で確かめる必要があり、
      // 結び忘れると `window_projects` が古いまま残って `pike <同じ dir>` が 2 枚目の
      // ウィンドウを開いた。ウィンドウ生成の経路では Rust が既に seed 済みだが、
      // 同じ値を書くだけなので二重に呼んでも害が無い。
      projectTransientBind(id).catch(() => {})
    }

    if (!shouldRestore) return true

    if (project.lastSession && project.lastSession.tabs.length > 0) {
      // 分割（#308）は先に立てる。各タブの置き場は `def.pane` をそのまま渡し、
      // 選択とフォーカスは作り終えてから `applySessionPanes` が戻す。
      tabStore.beginSessionRestore(project.lastSession)
      for (const def of project.lastSession.tabs) {
        if (def.kind === 'terminal') {
          tabStore.addTerminalTab({
            id: def.id,
            title: def.title,
            pinned: def.pinned,
            autoStart: def.pinned ? resolveResumeCommand(def.autoStart) : undefined,
            cwd: activeRoot.value,
            shell: project.shell,
            pane: def.pane,
          })
        } else if (def.kind === 'editor') {
          if (def.path) {
            tabStore.addEditorTab({ path: def.path, pane: def.pane })
          } else if (def.content !== undefined) {
            tabStore.addBlankEditorTab({ title: def.title, content: def.content, pane: def.pane })
          }
        } else if (def.kind === 'browser' && def.url) {
          // ページは作らない（#368）。子 webview はタブが初めて見えたときに `BrowserTab` が作るので、
          // 復元したタブの数だけ起動時に読み込みが走ることはない。
          tabStore.addBrowserTab(def.url, {
            forceNew: true,
            title: def.title,
            pinned: def.pinned,
            pane: def.pane,
            mobile: def.mobile,
          })
        }
        // `codex-chat` / `agent-chat` は #275 で廃止した。**専用の後始末は要らない**:
        // このループが知らない kind を読み飛ばし、`snapshotSession` は生きている kind だけを
        // 全量で書き戻すので、次の flush でディスクからも消える（設定の削除を移行なしで
        // 済ませたのと同じ理屈）。
      }
      tabStore.applySessionPanes(project.lastSession)
    } else {
      // `agent-chat` は #275 で廃止したので、pin してあっても復元しない。
      for (const def of project.pinnedTabs.filter((d) => d.kind === 'terminal')) {
        tabStore.addTerminalTab({
          id: def.id,
          title: def.title,
          pinned: true,
          autoStart: def.autoStart,
          cwd: activeRoot.value,
          shell: project.shell,
        })
      }
    }

    // Ensure at least one plain terminal tab exists (for CWD detection, etc.)
    const hasPlainTerminal = tabStore.visibleTabs.some((t) => t.kind === 'terminal' && !t.autoStart)
    if (!hasPlainTerminal) {
      tabStore.addTerminalTab({ cwd: activeRoot.value, shell: project.shell })
    }
    return true
  }

  async function flushSession() {
    // Ephemeral (elevated admin) window: never persist — its lean session would
    // clobber the real one written by the non-elevated instance (#138).
    if (ephemeralWindow.value) return
    // Transient project (#230): there is no project.json to write to.
    if (isTransient.value) return
    if (!currentProject.value) return
    const next = useTabStore().snapshotSession()
    // **同じ内容なら書かない**（#321 で入れた `staleAt` の巻き添えを断つ）。書き出しは
    // `project.json` の全量書き直しと全ウィンドウへの broadcast を伴うのに、`snapshotSession`
    // が拾うのは terminal / editor / browser だけなので、他の種別のタブが持つ状態が動いても中身は
    // 変わらない。契機は `$subscribe`（タブの**どのフィールド**が変わっても発火する）で、
    // diff タブの自動取り直しはファイルが書き換わるたびにここへ来る。
    // Rust 側の `write_open_windows` が `last_written_sessions` で同じことをしている。
    if (JSON.stringify(currentProject.value.lastSession) === JSON.stringify(next)) return
    currentProject.value.lastSession = next
    await projectUpdate(currentProject.value).catch(() => {})
  }

  function saveSessionDebounced() {
    if (!currentProject.value) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSession, 1000)
  }

  async function saveSessionNow() {
    if (saveTimer) clearTimeout(saveTimer)
    await flushSession()
  }

  /**
   * A project id not already taken locally, nor left behind by a project this
   * machine hid (#164): reusing an id would silently adopt the hidden entry's
   * state, and once ids travel between machines a collision means two different
   * repositories fighting over one sync entry.
   */
  function uniqueProjectId(base: string): string {
    const settings = useSettingsStore()
    const taken = (id: string) => projects.value.some((p) => p.id === id) || settings.isProjectHidden(id)
    if (!taken(base)) return base
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`
      if (!taken(candidate)) return candidate
    }
  }

  async function addProject(config: ProjectConfig) {
    const created = await projectCreate(config)
    projects.value.unshift(created)
  }

  async function saveProject(config: ProjectConfig) {
    // A transient project (#230) has no project.json, so the write would reject.
    // Guarded here rather than in each caller: this is the one place a config
    // reaches disk, and `stores/git.ts` already calls it to record `origin`.
    // The in-memory copies are still updated, so the value holds for this window.
    if (transientProject.value?.id === config.id) {
      transientProject.value = config
      if (currentProject.value?.id === config.id) currentProject.value = config
      return
    }
    await projectUpdate(config)
    const idx = projects.value.findIndex((p) => p.id === config.id)
    if (idx !== -1) {
      projects.value[idx] = config
    }
    if (currentProject.value?.id === config.id) {
      currentProject.value = config
    }
  }

  /** Apply a `project_groups_updated` broadcast from another window (see
   *  `project_groups_save` for why the list has to travel). */
  function applyExternalGroups(list: string[]) {
    groups.value = list
  }

  // Apply a project_updated broadcast from another window: refresh in-memory
  // copies so this window's full-object writes don't revert the edit. The
  // window-local live session is kept (this window owns it while open).
  function applyExternalUpdate(config: ProjectConfig) {
    const idx = projects.value.findIndex((p) => p.id === config.id)
    if (idx !== -1) projects.value[idx] = config
    if (currentProject.value?.id === config.id) {
      currentProject.value = { ...config, lastSession: currentProject.value.lastSession }
    }
  }

  async function removeProject(id: string) {
    const project = projects.value.find((p) => p.id === id)
    // **タブを先に手放す**（#264）。あとに回すと、`closeTabs` の中の確認（未保存の
    // エディタ・実行中のターミナル）で断られたときに、一覧から消えた id のタブが
    // プロセスを抱えたまま残る。断られたら削除自体をやめる。
    const tabStore = useTabStore()
    if (!(await tabStore.closeProjectTabs(id))) return
    forgetHeld(id)
    await projectDelete(id)
    // Remember the deletion locally (#164): the sync file only ever gains
    // entries, so without this the next pull would recreate the project. The
    // root and origin go in the record too — see the match in the pull. After
    // the delete succeeds — a project hidden but still on disk is unreachable.
    useSettingsStore().hideProject({
      id,
      name: project?.name ?? id,
      root: project?.root,
      remoteUrl: project?.remoteUrl,
      // 削除として同期で伝える（#403。`HiddenProject.shared`）。
      shared: true,
    })
    projects.value = projects.value.filter((p) => p.id !== id)
    if (currentProject.value?.id === id) {
      currentProject.value = null
      // 所有者も手放す。残すと、以後このウィンドウで作るタブに消えた id が焼かれる。
      useTabStore().setOwnerProject('')
    }
  }

  function toggleSwitcher() {
    showSwitcher.value = !showSwitcher.value
  }

  function toggleQuickOpen() {
    showQuickOpen.value = !showQuickOpen.value
  }

  return {
    projects,
    groups,
    currentProject,
    findProject,
    heldProjects,
    parkedProjectIds,
    setHeldProjects,
    releaseProject,
    isTransient,
    openDirectory,
    openDirectoryAsProject,
    recentDirs,
    recentFiles,
    trackRecentFile,
    pickerStartDir,
    projectForRoot,
    registerTransientProject,
    showSwitcher,
    showQuickOpen,
    activeWorktreeRoot,
    activeRoot,
    shellForIO,
    missingRoots,
    visibleProjects,
    recentProjects,
    byRecency,
    unsyncableProjects,
    syncableProjects,
    applySyncedProjects,
    checkRoots,
    cloneProject,
    placeProject,
    openProject,
    adoptProject,
    loadProjects,
    loadGroups,
    addGroup,
    renameGroup,
    removeGroup,
    setProjectGroup,
    reorderGroups,
    reorderProjects,
    restoreLastProject,
    saveSessionDebounced,
    saveSessionNow,
    // **`addProject` と `uniqueProjectId` は公開しない**（#373）。登録を書けるのは
    // `openDirectoryAsProject` と `registerTransientProject` の 2 つだけ、という
    // 不変条件を型で守る（`switchProject` を非公開にしてあるのと同じ手）。
    saveProject,
    applyExternalUpdate,
    applyExternalGroups,
    removeProject,
    toggleSwitcher,
    toggleQuickOpen,
  }
})
