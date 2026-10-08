import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { infoDialog } from '../composables/useConfirmDialog'
import { useFocusPolling } from '../composables/useFocusPolling'
import { t } from '../i18n'
import { fuzzyMatch } from '../lib/paths'
import { loadJson, saveJson } from '../lib/storage'
import { ciAct, ciCircleciAvailable, ciConfigs, ciJobs, ciList } from '../lib/tauri'
import type { CiAction, CiConfigs, CiJob, CiProvider, CiRun, CiState } from '../types/ci'
import { useGitStore } from './git'
import { useIssuesStore } from './issues'
import { useProjectStore } from './project'
import { createShellProbe } from './shellProbe'
import { useSidebarStore } from './sidebar'

/**
 * 一度に取る run の件数。issue の一覧（50）より少ないのは、行が 2 段で、見るのは直近だけなため。
 * 古い run を探すなら CI のページのほうが早い。
 */
const LIMIT = 30

/**
 * 実行中の run があるあいだの取り直しの間隔。`gh run list` は約 1 秒で返り、WSL では
 * `wsl.exe` の起動を伴うので、Docker の一覧（5 秒）より長く取ってある。
 */
const POLL_MS = 15_000

/**
 * 再実行や中止のあと、実行中の run が一覧に無くても取り直しを続ける時間。操作の直後は
 * サービスの側の一覧がまだ古く、「終わった run しか無い」と見えてポーリングが始まらない。
 */
const WATCH_AFTER_ACT_MS = 60_000

/** タブの並び。両方使えるリポジトリでは、覚えている選択が無ければ先頭を出す。 */
const CI_PROVIDERS: readonly CiProvider[] = ['github', 'circleci']

/** どちらの CI を出すか。マシンローカルの好み（`pike:issues-kind` と同じ扱い）。 */
const PROVIDER_KEY = 'pike:ci-provider'

/** 今のブランチの run だけを出すか。マシンローカルの好み。 */
const BRANCH_ONLY_KEY = 'pike:ci-branch-only'

/** 開いた run の job。`jobs` が null のあいだは 1 度も取れていない。 */
interface JobsEntry {
  jobs: CiJob[] | null
  error: string | null
  loading: boolean
  /** 取ったときの run の状態。変わっていたら取り直す。 */
  forState: CiState
}

/**
 * CI ごとの一覧。**取得の状態も CI ごとに持つ**（`stores/issues.ts` の `KindList` と同じ理由で、
 * 1 本を共有すると、片方の取得中にタブを切り替えたとき、もう片方を取りに行く者が居なくなる）。
 */
interface ProviderList {
  items: CiRun[]
  error: string | null
  loading: boolean
  /** 今の取得がポーリングによるものか。ヘッダの更新ボタンを 15 秒ごとに回さないために見る。 */
  silent: boolean
  loaded: boolean
  seq: number
  /** 開いている run（id → job）。 */
  jobs: Map<string, JobsEntry>
}

function emptyList(): ProviderList {
  return { items: [], error: null, loading: false, silent: false, loaded: false, seq: 0, jobs: new Map() }
}

/**
 * CI の実行の一覧（#457）。GitHub Actions と CircleCI を、同じ行の形で出す。
 *
 * **出す条件は CI ごとに 2 つ**（`available`）: リポジトリにその CI の設定があり、かつ
 * プロジェクトのシェルにその CLI がある。GitHub Actions は origin が GitHub であることも要る
 * （`gh` の検出ごと `issuesStore.visible` を借りる）。
 *
 * **取得はパネルを開いたとき・更新ボタン・実行中の run があるあいだのポーリング**（`shouldPoll`）。
 * issue パネルと違って定期実行を持つのは、run が終わるのを待つ使い方があるため（利用者の判断）。
 * 実行中のものが無ければ外部プロセスは起こさない。
 */
export const useCiStore = defineStore('ci', () => {
  const projectStore = useProjectStore()
  const issuesStore = useIssuesStore()

  /**
   * リポジトリが持つ CI の設定（root ごと）。**覚えるのはウィンドウの寿命のあいだ**: WSL では
   * 1 回聞くのに `wsl.exe` の起動が要るので、プロジェクトを行き来するたびに聞き直さない。
   * 設定を足したあとは更新ボタン（`refresh`）が聞き直す。
   */
  const configsByRoot = reactive(new Map<string, CiConfigs>())
  /** 聞いている最中の root。同じ root に 2 本立てない。 */
  const configsInFlight = new Map<string, Promise<void>>()

  /** 設定を引くキー。worktree を切り替えると root が変わるので、id ではなく root で持つ。 */
  const rootKey = computed(() => {
    const project = projectStore.currentProject
    return project ? `${project.id}\n${projectStore.activeRoot}` : null
  })
  const configs = computed(() => (rootKey.value ? (configsByRoot.get(rootKey.value) ?? null) : null))

  /** `circleci` を探すラッチ。規約は `issuesStore` の `ghProbe` と同じ（見つかっただけ覚える）。 */
  const circleciProbe = createShellProbe<boolean>((shell, root, force) => ciCircleciAvailable(shell, root, force), {
    keep: (found) => found,
  })
  const currentShell = computed(() => projectStore.currentProject?.shell ?? null)
  const circleciAvailable = computed(() => circleciProbe.answerFor(currentShell.value) === true)

  /** このプロジェクトで使える CI（`CI_PROVIDERS` の並び）。 */
  const available = computed<CiProvider[]>(() => {
    const c = configs.value
    if (!c) return []
    const usable: Record<CiProvider, boolean> = {
      github: c.github && issuesStore.visible,
      circleci: c.circleci && circleciAvailable.value,
    }
    return CI_PROVIDERS.filter((p) => usable[p])
  })
  const visible = computed(() => available.value.length > 0)

  /**
   * **このプロジェクトでは CI を扱えないと確定した**か（`usePanelAvailability` が、開いている
   * パネルを逃がす判断に使う。`stores/issues.ts` の `ruledOut` と同じ意味）。**設定をまだ
   * 聞いていないあいだは false**。CLI が無いだけのときも false（入れれば直るので、パネルに
   * 理由が出ているほうが親切）。
   */
  const ruledOut = computed(() => {
    const c = configs.value
    if (!c) return false
    return !c.circleci && (!c.github || issuesStore.ruledOut)
  })

  const chosen = ref<CiProvider>(loadJson<CiProvider>(PROVIDER_KEY, 'github') === 'circleci' ? 'circleci' : 'github')
  /** 今出している CI。覚えている選択が使えなければ、使えるものの先頭。 */
  const provider = computed<CiProvider | null>(() =>
    available.value.includes(chosen.value) ? chosen.value : (available.value[0] ?? null),
  )

  const lists = reactive<Record<CiProvider, ProviderList>>({ github: emptyList(), circleci: emptyList() })
  const current = computed(() => (provider.value ? lists[provider.value] : null))
  const runs = computed(() => current.value?.items ?? [])
  const error = computed(() => current.value?.error ?? null)
  const loading = computed(() => current.value?.loading ?? false)

  /** 再実行や中止の最中のプロジェクト（`issuesStore` の `actingIn` と同じ形・同じ理由）。 */
  const actingIn = reactive(new Set<string>())
  const acting = computed(() => {
    const id = projectStore.currentProject?.id
    return id !== undefined && actingIn.has(id)
  })
  /** 更新ボタン（`refresh`）が設定と CLI を聞き直している最中か。 */
  const detecting = ref(false)
  /** ヘッダの更新ボタンを回すか。**ポーリングの取得では回さない**（15 秒ごとに回り続ける）。 */
  const busy = computed(() => (loading.value && !current.value?.silent) || acting.value || detecting.value)

  const filter = ref('')
  const branchOnly = ref(loadJson<boolean>(BRANCH_ONLY_KEY, false) === true)

  /**
   * 絞り込むブランチ（絞らないなら null）。**絞り込みは CLI に渡す**（理由は Rust の `ci_list`）。
   * detached のあいだは git が `(detached)` を返すので、絞らずに全部を出す。
   */
  const branchFilter = computed(() => {
    if (!branchOnly.value) return null
    const branch = useGitStore().status?.branch
    return branch && !branch.startsWith('(') ? branch : null
  })

  /**
   * ブランチで絞るのに、今のブランチをまだ知らないか。**このあいだは取得を待つ**: 待たないと、
   * プロジェクトを開いた直後に全ブランチで 1 回取り、git の status が届いてからもう 1 回取る
   * （CLI が 2 回起き、全ブランチの一覧が一瞬見える）。
   */
  const branchPending = computed(() => branchOnly.value && !useGitStore().status)

  /** 絞り込みの述語。題名・ワークフロー名・ブランチに、他のパネルと同じ `fuzzyMatch` を当てる。 */
  const filtered = computed(() => {
    const q = filter.value.trim()
    if (!q) return runs.value
    return runs.value.filter((r) => fuzzyMatch(`${r.title} ${r.workflow} ${r.branch}`, q))
  })

  function setProvider(next: CiProvider) {
    chosen.value = next
    saveJson(PROVIDER_KEY, next)
  }

  function setBranchOnly(next: boolean) {
    branchOnly.value = next
    saveJson(BRANCH_ONLY_KEY, next)
  }

  /**
   * 設定の有無と `circleci` を調べる。**べき等**（覚えていれば何もしない）。`force` は更新ボタンから。
   *
   * **`circleci` は設定があるリポジトリでしか探さない**（「検出のためだけに起動時へ `wsl.exe` を
   * 足さない」の例外にする範囲を、CircleCI を使うリポジトリに絞る）。`gh` は issue パネルの
   * 検出に任せ、`force` のときだけ、見つかっていなければ聞き直させる。
   */
  async function detect(force = false): Promise<void> {
    const project = projectStore.currentProject
    const key = rootKey.value
    if (!project || !key) return
    const root = projectStore.activeRoot
    const { shell } = project
    // 更新ボタンでも、両方の設定が在ると分かっていれば聞き直さない（新しく見つかるものが無い）。
    const known = configsByRoot.get(key)
    if (!known || (force && !(known.github && known.circleci))) {
      let asking = configsInFlight.get(key)
      if (!asking) {
        asking = ciConfigs(shell, root)
          .then((found) => void configsByRoot.set(key, found))
          // 聞けなかったら何も覚えない（次に切り替えたときにまた聞く）。
          .catch(() => {})
          .finally(() => configsInFlight.delete(key))
        configsInFlight.set(key, asking)
      }
      await asking
    }
    const found = configsByRoot.get(key)
    if (!found) return
    const probes: Promise<void>[] = []
    if (found.circleci) probes.push(circleciProbe.ask(shell, root, force && !circleciAvailable.value))
    // origin が GitHub でないと確定しているなら `gh` は探さない（答えを使う者が居ない）。
    if (found.github && force && !issuesStore.visible && !issuesStore.ruledOut) probes.push(issuesStore.detect(true))
    await Promise.all(probes)
  }

  /**
   * 開いている run の job を取る。**応答は取りに行った一覧の、その時点で開いている行にだけ
   * 入れる**（待っているあいだに閉じられたり、プロジェクトを切り替えられたりする）。
   */
  async function loadJobs(p: CiProvider, run: CiRun): Promise<void> {
    const project = projectStore.currentProject
    const list = lists[p]
    const entry = list.jobs.get(run.id)
    if (!project || !entry || entry.loading) return
    entry.loading = true
    entry.forState = run.state
    // 取り直しのあいだも、読めていた中身は残す（消すと行が畳まれて見える）。
    // **一覧の seq とは突き合わせない**: 一覧はポーリングで 15 秒ごとに取り直すので、seq で
    // 捨てると `loading` を下ろす者が居なくなる。行を閉じたときと `clear()`（Map ごと
    // 作り直す）は、`entry` が入れ替わることで見分けが付く。
    const settle = (patch: Partial<JobsEntry>) => {
      if (list.jobs.get(run.id) === entry) Object.assign(entry, patch, { loading: false })
    }
    try {
      const jobs = await ciJobs(project.shell, projectStore.activeRoot, p, run.id)
      settle({ jobs, error: null })
    } catch (e) {
      settle({ error: String(e) })
    }
  }

  /** 行を開閉する。開いたときに job を取る。 */
  function toggleExpanded(run: CiRun) {
    const p = provider.value
    if (!p) return
    const list = lists[p]
    if (list.jobs.delete(run.id)) return
    list.jobs.set(run.id, { jobs: null, error: null, loading: false, forState: run.state })
    void loadJobs(p, run)
  }

  /**
   * 一覧を取り直したあと、開いている行の job を合わせる。**取り直すのは実行中の run と、
   * 状態が変わった run だけ**（終わった run の job は変わらないので、ポーリングのたびに
   * CLI を起こさない）。一覧から消えた run の行は捨てる。
   */
  function syncJobs(p: CiProvider) {
    const list = lists[p]
    for (const [id, entry] of list.jobs) {
      const run = list.items.find((r) => r.id === id)
      if (!run) list.jobs.delete(id)
      else if (run.state === 'running' || run.state !== entry.forState) void loadJobs(p, run)
    }
  }

  /**
   * 取得の本体。`loading` の規約は `stores/issues.ts` の `load` と同じ（seq を進めた者が持ち、
   * 古くなった取得は下ろさない。`clear()` が下ろす）。
   *
   * 一覧は呼んだ時点の CI に固定して書き込む（取得中にタブを切り替えても、応答は取りに
   * 行った側へ入る）。
   */
  async function load(silent = false, p: CiProvider | null = provider.value): Promise<void> {
    if (!p) return
    const list = lists[p]
    const mySeq = ++list.seq
    list.loading = true
    list.silent = silent
    try {
      const project = projectStore.currentProject
      if (!project || !available.value.includes(p)) {
        list.items = []
        list.error = null
        return
      }
      const result = await ciList(project.shell, projectStore.activeRoot, p, LIMIT, branchFilter.value)
      if (mySeq !== list.seq) return
      list.items = result.runs
      list.error = result.error
      list.loaded = true
      syncJobs(p)
    } catch (e) {
      if (mySeq !== list.seq) return
      list.items = []
      list.error = String(e)
      list.loaded = true
    } finally {
      if (mySeq === list.seq) list.loading = false
    }
  }

  /** 更新ボタン。設定と CLI の検出もやり直す（CLI を入れたあと、ここから戻れるように）。 */
  async function refresh(): Promise<void> {
    if (busy.value) return
    detecting.value = true
    try {
      await detect(true)
    } finally {
      detecting.value = false
    }
    await load()
  }

  /** パネルを開いたときの取得。今の CI をまだ 1 回も取っていないときだけ走る。 */
  async function ensureLoaded(): Promise<void> {
    if (!current.value || current.value.loaded || current.value.loading || branchPending.value) return
    await load()
  }

  /**
   * run の状態を変える操作を 1 つ実行する。`ask` が確認を出して、操作と対象の id を返す
   * （断ったら null）。確認の中身は `lib/ciActions.ts`。流れは `issuesStore.act` と同じ:
   * シェルと root は呼んだ時点のものを使い、失敗は CLI の文面をダイアログに出し、CLI まで
   * 進んだら失敗しても取り直す。
   *
   * **済んだ行は落とさない**（issue のクローズと違い、再実行も中止も行は残って状態が変わる）。
   * 代わりに `watchUntil` を立てて、変化が一覧に出るまでポーリングを続ける。
   */
  async function act(ask: () => Promise<{ action: CiAction; ids: string[] } | null>): Promise<void> {
    const project = projectStore.currentProject
    const p = provider.value
    if (!project || !p || actingIn.has(project.id)) return
    const { id, shell } = project
    const root = projectStore.activeRoot
    const stillHere = () => projectStore.currentProject?.id === id
    let attempted = false
    actingIn.add(id)
    try {
      const request = await ask()
      if (!request) return
      attempted = true
      await ciAct(shell, root, p, request.action, request.ids)
    } catch (e) {
      await infoDialog(t('ci.actionFailed', { error: String(e) }))
    } finally {
      actingIn.delete(id)
      if (attempted && stillHere()) {
        watchUntil.value = Date.now() + WATCH_AFTER_ACT_MS
        void load(false, p)
      }
    }
  }

  function clear() {
    for (const list of Object.values(lists)) {
      // seq を進めてから下ろす（理由は `stores/issues.ts` の `clear`）。
      Object.assign(list, emptyList(), { seq: list.seq + 1 })
    }
    filter.value = ''
    watchUntil.value = 0
  }

  // --- ポーリング ---------------------------------------------------------------

  /** 操作の直後に、実行中の run が無くても取り直しを続ける期限（epoch ms。0 は無し）。 */
  const watchUntil = ref(0)
  const panelOpen = computed(() => useSidebarStore().activePanel === 'ci')
  const hasRunning = computed(() => runs.value.some((r) => r.state === 'running'))

  /**
   * ポーリングするか。**パネルを開いていて、実行中の run があるあいだだけ**（フォーカスは
   * `useFocusPolling` が見る）。全部終わったら止まるので、見ているだけの人に外部プロセスの
   * 起動を払わせない。
   */
  const shouldPoll = computed(() => panelOpen.value && visible.value && (hasRunning.value || watchUntil.value > 0))

  function tick() {
    if (watchUntil.value && Date.now() > watchUntil.value) watchUntil.value = 0
    // 取得中なら重ねない（遅い回線で、前の応答を待たずに次を撃つことになる）。
    if (!shouldPoll.value || loading.value) return
    void load(true)
  }

  // **ストアの setup 直下で張る**（`useFocusPolling` の doc）。
  const polling = useFocusPolling([{ every: POLL_MS, tick }])
  watch(shouldPoll, (on) => (on ? polling.start() : polling.stop()), { immediate: true })

  // 検出もここで 1 回だけ張る（`stores/issues.ts` の watcher と同じ理由）。
  watch([rootKey, currentShell], () => void detect(), { immediate: true })

  // ブランチの絞り込みが変わったら、取ってある一覧は別物になる。**両方の CI を捨てる**
  // （出していないほうは、次にタブを切り替えたときに `ensureLoaded` が取り直す）。
  // `branchPending` も見るのは、detached のように「status は届いたが絞り込みは null のまま」の
  // とき、待たせていた最初の取得を始める者が要るため。
  watch([branchFilter, branchPending], ([, pending]) => {
    for (const list of Object.values(lists)) list.loaded = false
    if (!pending && panelOpen.value && visible.value) void load()
  })

  return {
    available,
    visible,
    ruledOut,
    provider,
    setProvider,
    runs,
    filtered,
    error,
    loading,
    acting,
    busy,
    filter,
    branchOnly,
    setBranchOnly,
    jobsOf: (id: string) => current.value?.jobs.get(id) ?? null,
    toggleExpanded,
    act,
    refresh,
    ensureLoaded,
    clear,
  }
})
