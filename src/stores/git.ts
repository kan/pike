import { defineStore } from 'pinia'
import { computed, type Ref, ref } from 'vue'
import { confirmDialog, secretDialog } from '../composables/useConfirmDialog'
import { useFocusPolling } from '../composables/useFocusPolling'
import { t } from '../i18n'
import { isRespelling } from '../lib/gitRemote'
import {
  gitBranchList,
  gitCheckout,
  gitCheckoutTrack,
  gitCommit,
  gitDiscardChanges,
  gitFetch,
  gitInit,
  gitIsRepo,
  gitLog,
  gitPull,
  gitPush,
  gitRemoteUrl,
  gitSetOrigin,
  gitSshAdd,
  gitStage,
  gitStatus,
  gitUnstage,
} from '../lib/tauri'
import { windowFocused } from '../lib/window'
import type {
  FetchOption,
  GitFileChange,
  GitLogEntry,
  GitNetworkResult,
  GitStatusResult,
  PullOption,
  PushOption,
} from '../types/git'
import { chainOnSuccess, type ShellType } from '../types/tab'
import { useProjectStore } from './project'
import { useStatusMessageStore } from './statusMessage'
import { useTabStore } from './tabs'

/**
 * Local branch a remote-tracking branch maps to (`origin/foo` → `foo`). Only for
 * display decisions: the actual checkout lets git derive the name, which stays
 * correct even for the rare remote whose own name contains a slash.
 */
export function localBranchName(remoteBranch: string): string {
  const slash = remoteBranch.indexOf('/')
  return slash < 0 ? remoteBranch : remoteBranch.slice(slash + 1)
}

/** パスフレーズを聞いた結末（#386）。何を見せるかは呼び出し側が決める。 */
type AddKeyOutcome = 'added' | 'cancelled' | 'failed'

export const useGitStore = defineStore('git', () => {
  const status = ref<GitStatusResult | null>(null)
  const logEntries = ref<GitLogEntry[]>([])
  const branches = ref<string[]>([])
  // Remote-tracking branches (`origin/foo`), offered by the switcher alongside
  // the local ones (#197).
  const remoteBranches = ref<string[]>([])
  const fetchingBranches = ref(false)
  const remoteUrl = ref<string | null>(null)
  /**
   * `remoteUrl` を**どのプロジェクトについて**確かめ終えたか（#353）。公開するのは
   * 下の `remoteResolved`（id の突き合わせをここに閉じる）。
   */
  const remoteResolvedFor = ref<string | null>(null)
  /**
   * 今のプロジェクトの origin を聞き終えたか（#353）。
   *
   * **`remoteUrl` の null が 2 つの意味を持つ**（まだ聞いていない / origin が無い）ので、
   * それだけでは issue パネルを逃がしてよいかを決められない。聞く前に逃がすと、GitHub の
   * プロジェクトでも勝手にファイルツリーへ飛ぶ。id で見るので、切り替えた直後は自動的に
   * 「まだ」へ戻る。
   */
  const remoteResolved = computed(() => {
    const project = useProjectStore().currentProject
    return !!project && remoteResolvedFor.value === project.id
  })
  /**
   * 直近の失敗。**3 つを 1 つの値で持つのが要点**（#384）。
   *
   * 以前は文言だけを `error` に持っていたが、「ターミナルで実行」のボタン（`command`）を
   * 足したことで、**片方だけ書き換わると押せる嘘のボタンになる**。1 つの ref にして
   * `error` を computed にすれば、`error.value = …` と書く経路が型で塞がる。
   *
   * - `command` … 資格情報待ちのときに、ターミナルで走らせ直す 1 行。組み立ては Rust の
   *   `terminal_command`（`ssh-add` を前に置くかの判断もあちら）
   * - `root` … その失敗がどのリポジトリのものか。プロジェクトや worktree を切り替えた
   *   あとも帯が残ると、**押した先が別のリポジトリになる**（`clearTransientError`）
   * - `addKeyRetry` … 鍵のパスフレーズを聞けば直る失敗のときに、預けたあとでやり直す
   *   もの（#386）。**真偽値と関数の 2 欄に割らないこと**: 「押せるのに何も起きない
   *   ボタン」が型で表せてしまう。ボタンを出すかは `canAddKey`（この欄の有無）で決まる。
   *   **やり直しまで持つのは、2 つのボタンを同じ結末に揃えるため**: 「ターミナルで実行」は
   *   `ssh-add; git pull` を走らせる＝やり直しまで含むので、ダイアログ側だけ「鍵は入ったが
   *   何も起きない」で終わると、同じ帯の隣り合ったボタンで結果が違うことになる
   * - `fromPoll` … 10 秒ごとの `git status` が立てた失敗か（#436）。**下ろし方が違う**:
   *   ポーリングの失敗は次に通れば直っているが、利用者の操作の失敗は `git status` が
   *   通っても直っていない（`clearTransientError`）
   */
  const failure = ref<{
    message: string
    command: string | null
    root: string
    addKeyRetry: (() => Promise<void>) | null
    fromPoll: boolean
  } | null>(null)
  const error = computed(() => failure.value?.message ?? null)
  const authCommand = computed(() => failure.value?.command ?? null)
  const canAddKey = computed(() => !!failure.value?.addKeyRetry)
  // Whether the active root is a git repository. `false` drives the panel's
  // "initialize repository" view instead of surfacing a raw git error.
  const isRepo = ref(true)
  const pushing = ref(false)
  const pulling = ref(false)
  /** 利用者が頼んだ fetch が走っているあいだ（#438）。背景の取得（`fetchGuard`）とは別。 */
  const fetching = ref(false)

  /**
   * 失敗を記録し、**ステータスバーにも出す**（#270）。Git パネルのストリップだけだと、
   * パネルを閉じたまま実行したとき（パレットやサイドバーのボタン）に「何も起きなかった」
   * ように見える。入口ごとに通知を書くと、どれかが漏れる。
   */
  function setError(message: string, command: string | null = null, addKeyRetry: (() => Promise<void>) | null = null) {
    setFailure(message, command, addKeyRetry)
    // **押せる場所まで案内する**（#384）。知らせはアプリ全体（トースト）なのに、入力の
    // 入口は Git パネルの中にしかない。パレットやサイドバーから pull した人は、パネルを
    // 開けば拾えることに気付けない。
    const text = command ? `${message}\n${t('git.runInTerminalHint')}` : message
    useStatusMessageStore().show({ text, variant: 'error', durationMs: 8000 })
  }

  /**
   * 失敗を記録するだけの版。ステータスバーに出さない経路（10 秒ごとのポーリング、
   * ステージ・コミット・チェックアウト）が使う。**`failure` を直に代入しないこと**:
   * `root` を添えるのがここ 1 箇所で、添え忘れると `clearTransientError` の判定が
   * 素通りする。
   */
  function setFailure(
    message: string,
    command: string | null = null,
    addKeyRetry: (() => Promise<void>) | null = null,
    fromPoll = false,
  ) {
    failure.value = { message, command, root: getRoot(), addKeyRetry, fromPoll }
  }

  /**
   * リモートに触る操作（pull / push）の失敗を記録する（#386）。
   *
   * **`GitNetworkResult` をそのまま受ける**ので、欄が増えたときに触るのはここだけになる。
   */
  function setNetworkError(message: string, result: GitNetworkResult | null, retry: () => Promise<void>) {
    setError(message, result?.command ?? null, result?.canAddKey ? retry : null)
  }

  /**
   * リモートに触る操作（pull / push）が失敗したときの始末（#386）。
   *
   * **鍵のパスフレーズで直る失敗では、帯を出す前に入力を聞く。** 利用者がしたいのは
   * 「pull を通すこと」で、そこに要るのはパスフレーズ 1 つと分かっている。先に帯を出すと、
   * エラーを読んでボタンを探す手間を挟むことになる。**断られて初めて**帯と
   * 「ターミナルで実行」を出す（ホスト鍵の確認など、こちらで聞けないことも起きるため）。
   *
   * **入力して通らなかったときは帯だけ**（トーストを重ねない）。理由は
   * `askAndAddKey` が既に「パスフレーズが違うかもしれません」として出している。
   */
  async function handleNetworkFailure(
    message: string,
    result: GitNetworkResult | null,
    retry: () => Promise<void>,
    keyAsked: boolean,
  ) {
    if (result?.canAddKey && !keyAsked) {
      const outcome = await askAndAddKey(getRoot(), retry)
      if (outcome === 'added') return
      if (outcome === 'failed') {
        setFailure(message, result.command, retry)
        return
      }
    }
    setNetworkError(message, result, retry)
  }

  /**
   * パスフレーズを聞いて鍵を預け、通ったらやり直す（#386）。**帯は出さない**（何を
   * 見せるかは結末を見て呼び出し側が決める）。
   *
   * - `added` … 預けられた（やり直しまで済んでいる、または相手が変わったので止めた）
   * - `cancelled` … 入力しなかった
   * - `failed` … 入力したが通らなかった（理由はトーストで出した）
   *
   * **`root` は待つたびに見る。** ダイアログと `ssh-add`（冷えた WSL で最長 30 秒）の
   * あいだに切り替えられると、**別のリポジトリへ鍵を預け、別のリポジトリでやり直す**。
   */
  async function askAndAddKey(root: string, retry: () => Promise<void>): Promise<AddKeyOutcome> {
    const project = getProject()
    if (!project) return 'cancelled'
    const passphrase = await secretDialog(t('git.passphrasePrompt'))
    // 空文字も「入力しなかった」とみなす（`ssh-add` に渡しても失敗するだけ）。
    if (!passphrase || root !== getRoot()) return 'cancelled'
    try {
      await gitSshAdd(root, project.shell, passphrase)
    } catch (e) {
      // **「パスフレーズが違う」を言えるのはここだけ。** `SSH_ASKPASS_REQUIRE=force` の
      // `ssh-add` は間違えても**何も書かずに 1 で終わる**（聞き直す先が無いため）ので、
      // Rust から来るのは試した鍵の名前くらいしかない。
      useStatusMessageStore().show({
        text: t('git.passphraseFailed', { reason: String(e) }),
        variant: 'error',
        durationMs: 8000,
      })
      return 'failed'
    }
    // 鍵は入った。やり直す相手が変わっていたら、そこで止めるだけ。
    if (root !== getRoot()) return 'added'
    // **やり直す前に帯を下ろす。** `retry` は新しい失敗を立てうるので、後ろで消すと
    // そちらまで消す。
    clearError()
    await retry()
    return 'added'
  }

  /** 失敗の表示を下ろす。 */
  function clearError() {
    failure.value = null
  }

  /**
   * ポーリングが成功したときの後始末。**下ろすのはポーリング自身の失敗だけ**（#384 / #436）。
   *
   * 10 秒ごとの `git status` が通っても、コミットや pull が失敗した事実は変わらない。
   * ここで消すと、読む前にエラーが消え、資格情報待ちなら入力する唯一の入口（「ターミナルで
   * 実行」）も押される前に消える。操作の失敗が下りるのは、× を押した時点か、次の操作を
   * 始めた時点（`clearUnlessAuthPending`）。
   *
   * **ただし、別のリポジトリを見ているなら下ろす。** プロジェクトの切り替えと worktree の
   * 切り替えはどちらも直後に `refreshStatus` を通るので、ここが掃除の場所になる。残すと
   * **A の失敗の帯が B のパネルに出たまま、押すと B で `git pull` が走る**。
   */
  function clearTransientError() {
    if (failure.value?.fromPoll || failure.value?.root !== getRoot()) clearError()
  }

  /**
   * 役目を終えた失敗を下ろす（#436）。契機は 2 つで、どちらも残すと直したあとも古い
   * エラーが出続ける。
   *
   * - 利用者が次の操作を始めた（`runAction` / `runRecovery`）。やり直しか別の手で対処
   *   しようとしている
   * - 止まっていた操作が終わった（`doRefreshStatus`）。Pike を通らずに片付いている
   *
   * **資格情報待ちの表示は残す**（#384）。ステージやコミットは pull の失敗と無関係で、
   * 下ろすと入力の入口が消える。あちらが下りるのは次の pull / push か、そのボタン。
   */
  function clearUnlessAuthPending() {
    if (!failure.value?.command) clearError()
  }

  /** ステータスとログをまとめて取り直す（「更新」の実体。入口が 2 つある）。 */
  async function refreshAll() {
    await Promise.all([refreshStatus(true), refreshLog()])
  }

  const refreshing = ref(false)
  let statusInFlight: Promise<void> | null = null
  let statusPending: Promise<void> | null = null
  let logInFlight: Promise<void> | null = null
  let logPending: Promise<void> | null = null
  /** 背景の取得の間隔。 */
  const FETCH_INTERVAL_MS = 60_000
  let fetchGuard = false
  let lastFetchTime = 0
  /** 走っている fetch の列（#438）。持ち主は `runFetch`。 */
  let fetchQueue: Promise<unknown> = Promise.resolve()
  const logAllMode = ref(false)
  // Status from the previous poll. When HEAD/ahead/behind change between polls —
  // e.g. a commit made in a terminal, a pull, or a branch switch — the commit
  // log is stale and must be refreshed alongside the status.
  let lastStatus: GitStatusResult | null = null

  function getProject() {
    const projectStore = useProjectStore()
    return projectStore.currentProject
  }

  // The active worktree root (single source of truth in the project store).
  // Callers guard on getProject() first, so this is always a real path.
  function getRoot(): string {
    return useProjectStore().activeRoot
  }

  async function doRefreshStatus(showProgress: boolean): Promise<void> {
    const project = getProject()
    if (!project) return
    if (showProgress) refreshing.value = true
    const minDelay = showProgress ? new Promise((r) => setTimeout(r, 300)) : null
    try {
      const [s] = await Promise.all([gitStatus(getRoot(), project.shell), minDelay])
      status.value = s
      clearTransientError()
      // 止まっていた操作が終わったら、それを報せていた失敗も下ろす（#436）。ターミナルで
      // `git merge --abort` した場合など、Pike の操作を通らない終わり方がある。
      if (lastStatus?.operation && !s.operation) clearUnlessAuthPending()
      isRepo.value = true
      // Auto-refresh the commit log when the repo's commit state changed since
      // the last poll. Skip the very first observation to avoid a redundant
      // load (the panel loads the log explicitly on open).
      if (
        lastStatus &&
        (s.head !== lastStatus.head || s.ahead !== lastStatus.ahead || s.behind !== lastStatus.behind)
      ) {
        void refreshLog()
      }
      lastStatus = s
    } catch (e) {
      // A status failure is usually "not a git repository" — disambiguate so the
      // panel can offer to initialize one instead of showing a raw git error.
      const repo = await gitIsRepo(getRoot(), project.shell).catch(() => true)
      if (!repo) {
        isRepo.value = false
        status.value = null
        clearError()
      } else {
        isRepo.value = true
        // 操作の失敗が出ているあいだは上書きしない（#436）。あちらは利用者が読んで
        // 対処するもので、`git status` の失敗に差し替わると元のエラーへ戻る手が無い。
        // **残すかどうかの判定は成功時と同じ**なので、同じ関数に聞く。
        clearTransientError()
        if (!failure.value) setFailure(String(e), null, null, true)
      }
      if (minDelay) await minDelay
    } finally {
      refreshing.value = false
    }
  }

  // Coalescing wrapper: keeps at most one in-flight + one pending refresh.
  // Callers that arrive while a refresh is running get scheduled into the
  // pending slot so post-action state is never silently dropped.
  async function refreshStatus(showProgress = false): Promise<void> {
    if (statusInFlight) {
      if (statusPending) return statusPending
      statusPending = statusInFlight
        .then(() => doRefreshStatus(showProgress))
        .finally(() => {
          statusPending = null
        })
      return statusPending
    }
    statusInFlight = doRefreshStatus(showProgress).finally(() => {
      statusInFlight = null
    })
    return statusInFlight
  }

  /**
   * 履歴は `LOG_PAGE` 件ずつ読み、パネルの末尾まで来たら足す（#374）。以前は一覧 500 件・
   * グラフ 1000 件を一度に取って打ち切っていたので、それより古い履歴は見られなかった。
   *
   * **足すときも先頭から取り直す**（`--skip` で続きだけを取らない）。ポーリングで HEAD が
   * 動いたときの取り直しと同じ経路に乗り、途中にコミットが増えても重複や抜けが出ない。
   * 費用は件数に比例するが、描く側（行ごとの SVG）のほうが重いので、ここは問題にならない。
   */
  const LOG_PAGE = 200
  const logLimit = ref(LOG_PAGE)
  /** 最後に取ったとき `logLimit` ぶん返ってきた＝まだ先がありうる。 */
  const logHasMore = ref(false)
  /** `logLimit` を数えている相手（root と一覧 / グラフ）。変わったら 1 ページ目に戻す。 */
  let logScope = ''

  async function doRefreshLog(): Promise<void> {
    const project = getProject()
    if (!project) return
    const root = getRoot()
    // 区切りはエスケープで書く。**生の制御文字を埋めないこと**: NUL だと git が
    // このファイルを binary と判定し、`git diff` / `git blame` が効かなくなる
    // （#374 から #384 のレビューまで実際にそうなっていて、差分を読めなかった）。
    const scope = `${root}\u001f${logAllMode.value}`
    if (scope !== logScope) {
      logScope = scope
      logLimit.value = LOG_PAGE
    }
    const limit = logLimit.value
    try {
      logEntries.value = await gitLog(root, project.shell, limit, logAllMode.value)
      logHasMore.value = logEntries.value.length >= limit
    } catch {
      logEntries.value = []
      logHasMore.value = false
    }
  }

  /**
   * 次のページを足す。もう先が無いときは何もしない。**別の取り直しが走っていたら終わるのを
   * 待ってから足す**: 何もせずに戻ると、末尾の印が見えたまま件数が増えず、観測の通知
   * （見え方が変わったときにしか来ない）も来ないので、自動読み込みがそこで止まる。
   */
  async function loadMoreLog(): Promise<void> {
    // **`logPending` も待つ**（#374）。`logInFlight` だけを待つと、合流待ちの取り直し
    // （limit は据え置き）と、ここが起こす取り直し（limit は 1 ページぶん多い）が同時に
    // 走る。小さいほうが後に着くと一覧が 200 行に縮んで見える。
    const running = logPending ?? logInFlight
    if (running) await running
    if (!logHasMore.value) return
    logLimit.value += LOG_PAGE
    await refreshLog()
  }

  async function refreshLog(all?: boolean): Promise<void> {
    if (all !== undefined) logAllMode.value = all
    if (logInFlight) {
      if (logPending) return logPending
      logPending = logInFlight
        .then(() => doRefreshLog())
        .finally(() => {
          logPending = null
        })
      return logPending
    }
    logInFlight = doRefreshLog().finally(() => {
      logInFlight = null
    })
    return logInFlight
  }

  /**
   * 利用者が起こすローカルの操作（ステージ・コミット・チェックアウト）の共通の骨格（#436）。
   *
   * **「始めた時点で前の失敗を下ろす」をここ 1 か所に置く。** 操作ごとに書くと、次に足す
   * 操作で落としても型にもテストにも掛からず、直したあとも古いエラーが残るだけになる。
   * pull / push は通さない（あちらは資格情報待ちも下ろし、失敗を値で受ける別の形）。
   */
  async function runAction(run: (root: string, shell: ShellType) => Promise<unknown>) {
    const project = getProject()
    if (!project) return
    clearUnlessAuthPending()
    try {
      await run(getRoot(), project.shell)
    } catch (e) {
      setFailure(String(e))
    }
  }

  function stageFiles(paths: string[]) {
    return runAction(async (root, shell) => {
      await gitStage(root, shell, paths)
      await refreshStatus()
    })
  }

  /**
   * ステージから外す。**リネームは両方の名前を外す（#306）。** 新しい名前だけを `git reset`
   * すると、元の名前が「削除」としてステージに残り、新しいほうが untracked になる（実測）。
   * 押した人はそんな半端な状態を頼んでいない。
   *
   * **パスではなく `GitFileChange` を受ける**のはそのため。呼ぶ側で `origPath` を展開する
   * 形にしていたころは、1 つずつ外すボタンだけが通っていて「すべて外す」が漏れていた。
   */
  function unstageFiles(files: GitFileChange[]) {
    const paths = files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]))
    return runAction(async (root, shell) => {
      await gitUnstage(root, shell, paths)
      await refreshStatus()
    })
  }

  function discardChanges(paths: string[]) {
    return runAction(async (root, shell) => {
      await gitDiscardChanges(root, shell, paths)
      await refreshStatus()
    })
  }

  function commitChanges(message: string) {
    return runAction(async (root, shell) => {
      await gitCommit(root, shell, message)
      await Promise.all([refreshStatus(), refreshLog()])
    })
  }

  /**
   * `keyAsked` は「この操作のためにパスフレーズを既に聞いた」（#386）。**やり直しの側が
   * 真を渡す**ので、聞くのは利用者が押した 1 回につき最大 1 度になる。無いと、鍵は
   * 入るのに（別の鍵なので）pull が通らない構成で**入力欄が延々と出続ける**。
   */
  function push(options?: PushOption[], keyAsked = false): Promise<void> {
    return runNetworkOp(
      pushing,
      (root, shell) => gitPush(root, shell, options),
      refreshStatus,
      () => push(options, true),
      keyAsked,
    )
  }

  /**
   * 成功したときだけ後始末をする、リモートに触る操作の骨格（push と、利用者が頼む fetch）。
   * **pull は通さない**: あちらは失敗しても読み直す（競合で止まった pull の結果を見せる）。
   */
  async function runNetworkOp(
    busy: Ref<boolean>,
    call: (root: string, shell: ShellType) => Promise<GitNetworkResult>,
    onSuccess: () => Promise<unknown>,
    retry: () => Promise<void>,
    keyAsked: boolean,
  ) {
    const project = getProject()
    // **ガードはここに置く**（#270）。以前は SideBar のボタンの disabled だけが多重実行を
    // 止めていたので、パレットから 2 回叩くと同じリポジトリで 2 本走り、`index.lock` で
    // ぶつかったうえ、先に終わったほうがフラグを戻していた。
    if (!project || busy.value) return
    busy.value = true
    // 前回の資格情報待ちの帯は、次の試行を始めた時点で下ろす（`clearTransientError`）。
    clearError()
    let failed: { message: string; result: GitNetworkResult | null } | null = null
    try {
      const result = await call(getRoot(), project.shell)
      if (result.error) failed = { message: result.error, result }
      else await onSuccess()
    } catch (e) {
      failed = { message: String(e), result: null }
    } finally {
      // **旗は失敗の始末より先に下ろす。** やり直し（`retry`）はこの旗を見て早期
      // return するので、握ったまま呼ぶと黙って何も起きない。
      busy.value = false
    }
    if (failed) await handleNetworkFailure(failed.message, failed.result, retry, keyAsked)
  }

  async function pull(options?: PullOption[], keyAsked = false) {
    const project = getProject()
    if (!project || pulling.value) return
    pulling.value = true
    clearError()
    // ストアの `failure` とは別物（あちらは `root` を持つ）。同じ名前にしない。
    // **結果は欄ごとに写さず丸ごと持つ**: `GitNetworkResult` が伸びるたびにここを
    // 直すことになるうえ、写し漏れが無言で `null` に化ける。
    let failed: { message: string; result: GitNetworkResult | null } | null = null
    try {
      const result = await gitPull(getRoot(), project.shell, options)
      if (result.error) failed = { message: result.error, result }
    } catch (e) {
      failed = { message: String(e), result: null }
    } finally {
      // Refresh either way: a pull that stopped on a conflict rejects, and its
      // conflicts and the operation banner are exactly what the user needs to
      // see now rather than after the next poll (#222).
      await Promise.all([refreshStatus(), refreshLog()])
      pulling.value = false
    }
    // **失敗の始末は `finally` の外**（#386）。中でやると、やり直し（`pull`）が
    // `pulling` を握ったままの自分に早期 return される。帯を出すのも refresh の後
    // でなければならない（成功した refresh が下ろしてしまう）。
    if (failed) {
      await handleNetworkFailure(failed.message, failed.result, () => pull(options, true), keyAsked)
    }
  }

  /**
   * 利用者が頼んだ fetch（#438。Git パネルのメニューとパレット）。**`push` と同じ骨格**
   * （`runNetworkOp`）で、失敗を帯に出し、鍵のパスフレーズで直るなら先に聞く。背景の取得（`fetchInBackground`）と
   * 違うのはそこだけで、走らせる git は同じ。
   *
   * 成功は知らせる: pull / push と違い、パネルの見た目が何も変わらないことがある
   * （リモートに新しいコミットが無いとき）ので、黙ると押せたのかが分からない。
   */
  function fetchRemote(options?: FetchOption[], keyAsked = false): Promise<void> {
    return runNetworkOp(
      fetching,
      (root, shell) => runFetch(root, shell, options),
      async () => {
        // ブランチの一覧は読み直さない（切り替えのドロップダウンが開くたびに読む）。
        await Promise.all([refreshStatus(), refreshLog()])
        useStatusMessageStore().show({ text: t('git.fetched') })
      },
      () => fetchRemote(options, true),
      keyAsked,
    )
  }

  /**
   * エージェントへ依頼する前に、リモートの最新を取っておく（#438）。取れたかを返す。
   *
   * **エージェントの側からは fetch が通らないことがある**（鍵が agent に入っておらず
   * パスフレーズを聞かれる、サンドボックスがネットワークを閉じている）。Pike のバックエンドは
   * `SSH_AUTH_SOCK` を運べる（#384）ので、ここで済ませて、済んだことを依頼文に添える。
   *
   * **失敗を記録しない**（`fetchRemote` と違い `failure` に触れない）。依頼の対象はいま出ている
   * エラーで、ここで差し替えると送る原文が失われる。パスフレーズも聞かない。
   *
   * **取れなかったことも呼び出し側が依頼文に書く。** 黙ると、エージェントは古いリモート
   * 追跡ブランチを最新として扱う。
   */
  async function fetchForAgent(): Promise<boolean> {
    const project = getProject()
    if (!project) return false
    // **毎回取りに行く**（直前に取ったかを覚えない）。覚えるには root ごとの印が要るが、
    // このストアは root に紐づく印を既に 3 つ抱えている。差分の無い fetch は軽い。
    try {
      return !(await runFetch(getRoot(), project.shell)).error
    } catch {
      return false
    }
  }

  /**
   * fetch を走らせる唯一の場所（#438）。入口が 3 つある（背景・利用者・エージェントへの
   * 依頼の前）ので、**Pike の fetch どうしは 1 本ずつ走らせる**。同じリポジトリで
   * `git fetch --prune` が並ぶと、片方が ref のロックを取れずに失敗しうる
   * （`cannot lock ref`）。背景の取得は 60 秒ごとに走るので、利用者が押した側がそれに
   * 負けると、何も悪くないのにエラーが出る。
   *
   * **pull / push は並べていない**（あちらは従来どおり背景の取得と重なりうる）。
   *
   * **`lastFetchTime` は「取得済み」の根拠にならない。** あれは背景の取得を間引く時刻で、
   * 失敗しても、スリープ復帰で見送っただけでも進む。
   */
  function runFetch(root: string, shell: ShellType, options?: FetchOption[]): Promise<GitNetworkResult> {
    const run = fetchQueue.then(() => gitFetch(root, shell, options))
    fetchQueue = run.catch(() => {})
    return run
  }

  /**
   * Run a recovery command for the stopped operation in a terminal tab, the way
   * the task runner and compose do. Not a backend command on purpose:
   * `git rebase --continue` opens $EDITOR, signing can raise a passphrase or
   * 1Password prompt, and the backend's git calls have no TTY and die at 30s.
   */
  async function runRecovery(command: string) {
    const project = getProject()
    if (!project) return
    // The operation may have finished in another terminal since the last poll.
    await refreshStatus()
    if (!status.value?.operation?.canContinue) return
    clearUnlessAuthPending()
    runInTerminal(command)
  }

  /**
   * ターミナルタブで走らせて、終わったら取り直す（#222 / #384）。
   *
   * **取り直すものを 1 か所に置く。** 2 つの呼び出し元で書き写していたころは、`loadBranches`
   * を足す日に片方だけ直り「復帰は効くのに認証のほうだけ一覧が古い」になりうる形だった。
   */
  function runInTerminal(command: string) {
    const project = getProject()
    if (!project) return
    useTabStore().runCommandTab(command, getRoot(), project.shell, {
      keepOnError: true,
      onExit: () => {
        void refreshStatus()
        void refreshLog()
      },
    })
  }

  /**
   * 資格情報が要るせいで失敗した操作を、ターミナルタブで走らせ直す（#384）。
   *
   * `runRecovery` と同じ理由でバックエンドに戻さない: 鍵のパスフレーズを聞けるのは TTY
   * のあるところだけ。**成功したら表示を下ろす**（同じ失敗のボタンが残らないように）。
   */
  function runAuthCommand() {
    const project = getProject()
    const f = failure.value
    // 帯が出ているあいだに切り替えられていたら走らせない（`clearTransientError` が
    // 掃除する前にクリックが届きうる）。**押した先が別のリポジトリになる**のが最悪の形。
    if (!project || !f?.command || f.root !== getRoot()) return
    clearError()
    runInTerminal(f.command)
  }

  /**
   * 帯の「パスフレーズを入力」（#386）。**2 回目以降の入口**で、1 回目は失敗した時点で
   * `handleNetworkFailure` が自動で聞く。
   *
   * **失敗しても帯を残す**（何もしない）。間違えただけなら、もう一度押して入力し直せる
   * ほうがよい。
   */
  async function addSshKey() {
    const f = failure.value
    if (!f?.addKeyRetry || f.root !== getRoot()) return
    await askAndAddKey(f.root, f.addKeyRetry)
  }

  /**
   * Carry the stopped operation forward. A rebase that could not write its
   * commit (signing, a hook) has to be handed that commit first: `git rebase
   * --continue` refuses the state outright. `-C` keeps the original author and
   * author date, which a plain re-commit would silently reset to now.
   *
   * Both commands are assembled from values the backend vouches for — `kind` is
   * one of its own literals and `stoppedSha` passed `is_sha` — so nothing here
   * needs quoting. Anything new interpolated into these lines does.
   */
  async function continueOperation() {
    const op = status.value?.operation
    if (!op?.canContinue) return
    // git refuses `--continue` while anything is still unmerged; the panel
    // disables the button for this, and the guard keeps other callers honest.
    if (status.value?.conflicted.length) return
    if (op.stop !== 'commit-failed' || !op.stoppedSha) {
      await runRecovery(`git ${op.kind} --continue`)
      return
    }
    // Two commands, and the second must not run if the commit failed again
    // (the signing prompt was dismissed, say) — so chain in the shell's syntax.
    const shell = getProject()?.shell
    const command = chainOnSuccess(`git commit -C ${op.stoppedSha}`, `git ${op.kind} --continue`, shell)
    const subject = op.stoppedSubject || op.stoppedSha.slice(0, 8)
    if (!(await confirmDialog(t('git.recommitConfirm', { subject, command })))) return
    await runRecovery(command)
  }

  async function abortOperation() {
    const op = status.value?.operation
    if (!op?.canContinue) return
    const command = `git ${op.kind} --abort`
    if (!(await confirmDialog(t('git.abortConfirm', { command })))) return
    await runRecovery(command)
  }

  async function loadBranches() {
    const project = getProject()
    if (!project) return
    try {
      const list = await gitBranchList(getRoot(), project.shell)
      branches.value = list.local
      remoteBranches.value = list.remote
    } catch {
      branches.value = []
      remoteBranches.value = []
    }
  }

  /**
   * Update the remote-tracking refs before reloading the list, so the switcher
   * offers branches pushed since the last fetch (#197). Reuses the throttled
   * background fetch: opening the switcher right after a poll costs no network.
   */
  async function refreshRemoteBranches() {
    fetchingBranches.value = true
    try {
      await fetchInBackground()
      await loadBranches()
    } finally {
      fetchingBranches.value = false
    }
  }

  async function loadRemoteUrl() {
    const project = getProject()
    if (!project) {
      remoteUrl.value = null
      remoteResolvedFor.value = null
      return
    }
    const root = getRoot()
    try {
      remoteUrl.value = await gitRemoteUrl(root, project.shell)
    } catch {
      remoteUrl.value = null
    }
    // 「聞き終えた」を id で記録する（#353）。失敗（repo でない・origin が無い）も
    // 答えのうちなので、`catch` の側も通る。
    remoteResolvedFor.value = project.id
    // Persist origin on the project so a machine that lacks the checkout can
    // still clone it (#164). Only for the project's own root — a worktree can
    // sit in another repository. Never clears a stored URL from a transient
    // failure: only an actual URL change writes.
    //
    // **`root === project.root` の文字列比較にしないこと（#303）。** `activeRoot` は
    // 末尾の区切りを落とした値を配るので、`/home/kan/proj/` の形で登録されている
    // プロジェクトでは永久に一致せず、origin が黙って記録されなくなる。聞きたいのは
    // 「worktree に居るか」なので、そのものを見る。
    const url = remoteUrl.value
    const projectStore = useProjectStore()
    if (!url || projectStore.activeWorktreeRoot !== null || project.remoteUrl === url) return
    // **同じリポジトリの書き方違い（ssh / https）なら、記録ではなく手元の origin を記録に
    // そろえる**（#403）。記録し直すと、端末ごとの書き方が同期のたびに衝突していた。記録は
    // 同期された値で、利用者が選んだ書き方でもある。別のリポジトリなら従来どおり記録する。
    if (project.remoteUrl && isRespelling(url, project.remoteUrl)) {
      const wanted = project.remoteUrl
      await gitSetOrigin(root, project.shell, wanted).then(
        () => {
          if (remoteResolvedFor.value === project.id) remoteUrl.value = wanted
        },
        () => {},
      )
      return
    }
    projectStore.saveProject({ ...project, remoteUrl: url }).catch(() => {})
  }

  async function initRepo() {
    const project = getProject()
    if (!project) return
    try {
      await gitInit(getRoot(), project.shell)
      isRepo.value = true
      clearError()
      lastStatus = null
      await Promise.all([refreshStatus(), refreshLog()])
      await loadRemoteUrl()
    } catch (e) {
      setFailure(String(e))
    }
  }

  function checkoutBranch(branch: string) {
    return runAction(async (root, shell) => {
      await gitCheckout(root, shell, branch)
      await Promise.all([refreshStatus(), refreshLog()])
    })
  }

  /**
   * Switch to a remote-tracking branch, creating the local branch that tracks it.
   * When that local branch already exists (the list was stale, or the switcher
   * showed the remote anyway), switch to it instead of failing on `--track`.
   */
  async function checkoutRemoteBranch(remoteBranch: string) {
    const local = localBranchName(remoteBranch)
    if (branches.value.includes(local)) return checkoutBranch(local)
    return runAction(async (root, shell) => {
      await gitCheckoutTrack(root, shell, remoteBranch)
      // The new local branch has to show up in the switcher's local list.
      await Promise.all([refreshStatus(), refreshLog(), loadBranches()])
    })
  }

  async function fetchInBackground() {
    if (fetchGuard) return
    if (!windowFocused.value) return
    const elapsed = Date.now() - lastFetchTime
    if (lastFetchTime > 0 && elapsed < FETCH_INTERVAL_MS) return
    // Likely resumed from sleep — defer until next normal cycle
    if (lastFetchTime > 0 && elapsed > 300_000) {
      lastFetchTime = Date.now()
      return
    }
    const project = getProject()
    if (!project) return
    fetchGuard = true
    try {
      // **背景の取得なので、資格情報が要ることは知らせない**（60 秒ごとに同じ知らせが
      // 出る）。結果の形が pull / push と同じなのは、整形を Rust の 1 か所に残すため。
      await runFetch(getRoot(), project.shell)
      lastFetchTime = Date.now()
      await refreshStatus()
    } catch {
      // Silently ignore fetch errors (offline, auth failure, etc.)
    } finally {
      fetchGuard = false
    }
  }

  const polling = useFocusPolling([
    { every: 10_000, tick: refreshStatus },
    { every: FETCH_INTERVAL_MS, tick: fetchInBackground },
  ])

  function startPolling() {
    lastStatus = null
    // Restarted on every project switch (App.vue), so fetch once up front: the
    // timer alone would leave the StatusBar showing the previous project's
    // branch and ahead/behind for up to 10 seconds. `refreshStatus` dedups, so
    // an open Git panel refreshing at the same time costs nothing extra.
    refreshStatus()
    loadRemoteUrl()
    polling.start()
  }

  return {
    status,
    logEntries,
    branches,
    remoteBranches,
    fetchingBranches,
    remoteUrl,
    remoteResolved,
    error,
    clearError,
    authCommand,
    runAuthCommand,
    canAddKey,
    addSshKey,
    isRepo,
    pushing,
    pulling,
    fetching,
    refreshing,
    refreshStatus,
    refreshAll,
    refreshLog,
    logHasMore,
    loadMoreLog,
    stageFiles,
    unstageFiles,
    discardChanges,
    commitChanges,
    push,
    pull,
    fetchRemote,
    fetchForAgent,
    continueOperation,
    abortOperation,
    loadBranches,
    refreshRemoteBranches,
    loadRemoteUrl,
    initRepo,
    checkoutBranch,
    checkoutRemoteBranch,
    fetchInBackground,
    startPolling,
    stopPolling: polling.stop,
  }
})
