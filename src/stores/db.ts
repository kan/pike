/**
 * DB ビューワ（#632）の接続先: パネルに並べる候補、押したときの自動接続、つなげなかったときの
 * 接続のダイアログ、つなげた接続の保存。
 *
 * **候補の組み立てはここ 1 か所**（`lib/dbViewer.ts` の `buildDbCandidates`）。DB パネルと
 * 接続のダイアログは同じ `candidates` / `dbContainers` を読み、別々に一覧を組まない。
 *
 * **接続を確かめるのはここ。** タブはつなげた接続先しか受け取らない（`tabStore.addDbTab`）ので、
 * タブの中に接続のフォームは無い。つなげなければダイアログを出し、そこで直して試し直す。
 *
 * **パスワードは保存しない。** 保存するのはローカル / WSL の接続の種類・シェル・ホスト・ポート・
 * ユーザー・DB 名だけで、置き場はプロジェクトごとの localStorage（マシンの中だけ。同期しない）。
 * 判断の記録は `.claude/rules/db.md`。
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import {
  buildDbCandidates,
  buildDbTarget,
  connectionKey,
  type DbCandidate,
  type DbConnCandidate,
  type DbConnForm,
  type DbProbeVerdict,
  type DbSavedConnection,
  dbCandidatesFromEnv,
  dbEngineOfImage,
  dbErrorText,
  describeShellTarget,
  judgeProbe,
  parseSavedConnections,
  probeAskText,
  removeSaved,
  targetToSaved,
  upsertSaved,
} from '../lib/dbViewer'
import { joinPath, pathSep } from '../lib/paths'
import { PROJECT_KEY_PREFIX } from '../lib/projectStorage'
import { loadJson, saveJson } from '../lib/storage'
import { dbContainerDefaults, dbProbe, fsReadFile, redisProbe } from '../lib/tauri'
import type { DbProbe, DbTarget, RedisProbe } from '../types/db'
import type { ShellType } from '../types/tab'
import { useDockerStore } from './docker'
import { useProjectStore } from './project'
import { useTabStore } from './tabs'

/** 接続のダイアログの経路の値のうち、ローカル / WSL（プロジェクトのシェル）を指すもの。 */
export const SHELL_ROUTE = 'shell'

export interface DbDialogState {
  /** `SHELL_ROUTE` か、コンテナの id。変えるときは `setRoute` を通す（既定の値を埋めるため）。 */
  route: string
  form: DbConnForm
  error: string | null
  /** 経路のコンテナの環境変数にパスワードがあるか（あればパスワード欄は空のままでよい）。 */
  containerHasPassword: boolean
  /**
   * ローカル / WSL の経路で使うシェル。保存した接続から開いたときはその接続のシェル（プロジェクトの
   * シェルを後から変えていても、行が指していたシェルで試し直す）、それ以外はプロジェクトのシェル。
   */
  shell: ShellType
  /** DB 名の欄の選択肢（つながったが DB を選んでいなかったとき、見られる DB の一覧）。 */
  databaseChoices: string[]
  /** 「接続先を変える」から開いたときの DB タブ（つなげたらそのタブの接続先を差し替える）。 */
  tabId?: string
}

/**
 * つないだときに読んだ一覧。開いた DB タブが 1 回だけ使う（同じ問い合わせを繰り返さない）。
 * SQL の DB と Redis（#647）で中身が違う（タブは自分の種類のものを `take*Prefetched` で受ける）。
 */
type DbFetched = { kind: 'sql'; probe: DbProbe } | { kind: 'redis'; probe: RedisProbe }
interface DbPrefetched {
  tabId: string
  fetched: DbFetched
}

export const useDbStore = defineStore('db', () => {
  const projectStore = useProjectStore()
  const dockerStore = useDockerStore()
  const tabStore = useTabStore()

  /** 接続のダイアログ。null なら閉じている。 */
  const dialog = ref<DbDialogState | null>(null)
  /** 接続を試している接続先の `key`（パネルの行とダイアログのボタンに印を出す）。 */
  const connecting = ref<string | null>(null)
  /** 読み直している最中か（サイドバーの更新ボタンの回転）。 */
  const refreshing = ref(false)

  // --- 保存した接続（プロジェクトごと） ---

  const saved = ref<DbSavedConnection[]>([])
  const storageKey = (projectId: string) => PROJECT_KEY_PREFIX.dbConnections + projectId

  watch(
    () => projectStore.currentProject?.id,
    (id) => {
      saved.value = id ? parseSavedConnections(loadJson<unknown>(storageKey(id), [])) : []
    },
    { immediate: true },
  )

  function persist(next: DbSavedConnection[]) {
    saved.value = next
    const id = projectStore.currentProject?.id
    if (id) saveJson(storageKey(id), next)
  }

  /** 保存した接続を消す（パネルの行の消すボタン）。 */
  function forget(key: string) {
    persist(removeSaved(saved.value, key))
  }

  // --- `.env` の候補 ---

  const envCandidates = shallowRef<DbConnCandidate[]>([])
  /** 読んだルート。同じルートなら読み直さない（更新ボタンは読み直す）。 */
  let envRoot: string | null = null
  /** 一度でも読もうとしたか（パネルを開いたか）。読んだあとは、ルートが変わるたびに読み直す。 */
  let envWanted = false

  async function loadEnv(force = false) {
    envWanted = true
    const root = projectStore.activeRoot
    if (!root) {
      envCandidates.value = []
      envRoot = null
      return
    }
    if (!force && envRoot === root) return
    envRoot = root
    const shell = projectStore.shellForIO
    try {
      const r = await fsReadFile(shell, joinPath(root, '.env', pathSep(shell)), undefined, { allowMissing: true })
      if (envRoot === root) envCandidates.value = r.isNew ? [] : dbCandidatesFromEnv(r.content)
    } catch {
      if (envRoot === root) envCandidates.value = []
    }
  }

  // プロジェクトや worktree を切り替えたら、一度読んだことがあれば読み直す（パネルを開くまでは読まない）。
  watch(
    () => projectStore.activeRoot,
    () => {
      if (envWanted) void loadEnv()
    },
  )

  // --- 候補 ---

  /** 動いている MySQL / PostgreSQL のコンテナ（Docker パネルと同じ一覧から、イメージ名で選ぶ）。 */
  const dbContainers = computed(() =>
    dockerStore.containers.flatMap((c) => {
      const engine = dbEngineOfImage(c.image)
      return engine && c.state === 'running'
        ? [{ id: c.id, name: c.composeService ?? c.name, image: c.image, engine }]
        : []
    }),
  )

  const candidates = computed<DbCandidate[]>(() =>
    buildDbCandidates({
      containers: dbContainers.value,
      saved: saved.value,
      env: envCandidates.value,
      shell: projectStore.shellForIO,
    }),
  )

  /**
   * 候補を揃える。パネルを開いたときは軽く（コンテナの一覧だけ取り直し、`.env` は読んでいなければ
   * 読む）、更新ボタン（`force`）は Docker の接続から `.env` まで読み直す。
   */
  async function refresh(force = false) {
    refreshing.value = true
    try {
      const containers = force || !dockerStore.connected ? dockerStore.refreshAll() : dockerStore.refreshContainers()
      await Promise.all([containers, loadEnv(force)])
    } finally {
      refreshing.value = false
    }
  }

  // --- 接続 ---

  /** つないだときに読んだ一覧（1 件だけ持つ。次に開いたタブが使わなければ、次の接続で上書きする）。 */
  let prefetched: DbPrefetched | null = null

  function take(tabId: string): DbFetched | null {
    if (prefetched?.tabId !== tabId) return null
    const p = prefetched.fetched
    prefetched = null
    return p
  }

  function takePrefetched(tabId: string): DbProbe | null {
    const p = take(tabId)
    return p?.kind === 'sql' ? p.probe : null
  }

  function takeRedisPrefetched(tabId: string): RedisProbe | null {
    const p = take(tabId)
    return p?.kind === 'redis' ? p.probe : null
  }

  function titleOf(target: DbTarget): string {
    if (target.via.kind === 'shell') return describeShellTarget(target)
    const id = target.via.containerId
    return dbContainers.value.find((c) => c.id === id)?.name ?? id.slice(0, 12)
  }

  /**
   * 接続先を試し、つなげたら DB タブを開く。つなげなければ接続のダイアログを出す（既に開いて
   * いれば、そこにエラーを出す）。つなげたローカル / WSL の接続は保存する（パスワードを除く）。
   * パネルの行・ダイアログ・Docker パネル・DB タブの DB の切り替えが、全部ここを通る。
   */
  async function open(
    target: DbTarget,
    opts: { tabId?: string; fromDialog?: boolean; save?: boolean; picked?: boolean } = {},
  ): Promise<boolean> {
    const key = connectionKey(target)
    // 同じ接続先のタブが既にあれば前に出すだけ（つなぎ直さない）。そのタブには入れたパスワードや
    // 切り替えた DB が残っているので、行の接続先で差し替えると、それが消える。
    if (!opts.tabId && !opts.fromDialog && tabStore.focusDbTab(key)) return true
    connecting.value = key
    // 結果を書き込んでよいダイアログ。**このダイアログから出した接続だけ**がダイアログを閉じ、
    // エラーを出す（待っているあいだに別のダイアログを開かれていたら、そちらには触らない）。
    const ownDialog = opts.fromDialog ? dialog.value : null
    try {
      let fetched: DbFetched
      if (target.engine === 'redis') {
        // Redis（#647）は DB の番号が既定で 0 なので、選ばずにつないでも見るものがある（判定は要らない）。
        fetched = { kind: 'redis', probe: await redisProbe(target) }
      } else {
        // 接続を確かめ、今の DB・DB の一覧・テーブルの一覧を 1 回で取る（どれもタブが最初に要る）。
        const probe = await dbProbe(target)
        // **つながっても見るものが無い（DB を選ばずにつないだ）なら、タブを開かずに聞く。**
        // DB 名の指定が無く、コンテナに `MYSQL_DATABASE` も無いとき、空のタブが開いていた。
        const judged = judgeProbe(probe)
        // 選んでつなぎ直すのは 1 回だけ（DB 名がクライアントに効かずに、また選ばれていない状態で
        // 戻ってきたら、繰り返さずに聞く）。
        const verdict: DbProbeVerdict =
          judged.kind === 'pick' && opts.picked
            ? { kind: 'ask', reason: 'noDatabase', choices: [judged.database] }
            : judged
        if (verdict.kind === 'pick') {
          connecting.value = null
          return await open({ ...target, database: verdict.database }, { ...opts, picked: true })
        }
        if (verdict.kind === 'ask') {
          const notice = probeAskText(verdict.reason)
          if (ownDialog) {
            if (dialog.value === ownDialog) {
              ownDialog.error = notice
              ownDialog.databaseChoices = verdict.choices
            }
          } else {
            openDialog(target, { error: notice, tabId: opts.tabId, databaseChoices: verdict.choices })
          }
          return false
        }
        fetched = { kind: 'sql', probe }
      }
      const s = opts.save === false ? null : targetToSaved(target)
      if (s) persist(upsertSaved(saved.value, s))
      const title = titleOf(target)
      const id = opts.tabId
        ? tabStore.retargetDbTab(opts.tabId, target, key, title)
        : tabStore.addDbTab(target, key, title)
      prefetched = { tabId: id, fetched }
      if (ownDialog && dialog.value === ownDialog) dialog.value = null
      return true
    } catch (e) {
      const error = dbErrorText(e, target)
      if (ownDialog) {
        if (dialog.value === ownDialog) {
          ownDialog.error = error
          // つながらなかった接続先の DB の一覧は当てにならない。
          ownDialog.databaseChoices = []
        }
      } else {
        openDialog(target, { error, tabId: opts.tabId })
      }
      return false
    } finally {
      if (connecting.value === key) connecting.value = null
    }
  }

  // --- 接続のダイアログ ---

  /** ダイアログを開く。`from` があればその接続先で欄を埋める。 */
  function openDialog(from?: DbTarget, opts: { error?: string; tabId?: string; databaseChoices?: string[] } = {}) {
    dialog.value = {
      route: SHELL_ROUTE,
      form: {
        engine: from?.engine ?? 'mysql',
        host: from?.host ?? (from ? '' : '127.0.0.1'),
        port: from?.port ? String(from.port) : '',
        user: from?.user ?? '',
        password: from?.password ?? '',
        database: from?.database ?? '',
      },
      error: opts.error ?? null,
      containerHasPassword: false,
      shell: from?.via.kind === 'shell' ? from.via.shell : projectStore.shellForIO,
      databaseChoices: opts.databaseChoices ?? [],
      tabId: opts.tabId,
    }
    if (from?.via.kind === 'container') void setRoute(from.via.containerId)
  }

  /**
   * ダイアログの経路を変える。コンテナなら、そのイメージで種類を決め、空いている欄をコンテナの
   * 環境変数の既定で埋める。パスワードは返ってこない（Rust が実行のたびに環境変数から読む）。
   */
  async function setRoute(route: string) {
    const d = dialog.value
    if (!d) return
    d.route = route
    d.containerHasPassword = false
    // DB の選択肢は前の接続先のもの。
    d.databaseChoices = []
    const c = route === SHELL_ROUTE ? undefined : dbContainers.value.find((x) => x.id === route)
    if (!c) return
    d.form.engine = c.engine
    try {
      const defaults = await dbContainerDefaults(route, c.engine)
      if (dialog.value !== d || d.route !== route) return
      if (!d.form.user) d.form.user = defaults.user ?? ''
      if (!d.form.database) d.form.database = defaults.database ?? ''
      d.containerHasPassword = defaults.hasPassword
    } catch {
      // 既定が読めなくても、手で入れれば接続できる。
    }
  }

  function closeDialog() {
    dialog.value = null
  }

  /** ダイアログの「接続」。 */
  async function submitDialog() {
    const d = dialog.value
    if (!d) return
    const via =
      d.route === SHELL_ROUTE
        ? { kind: 'shell' as const, shell: d.shell }
        : { kind: 'container' as const, containerId: d.route }
    await open(buildDbTarget(d.form, via), { tabId: d.tabId, fromDialog: true })
  }

  return {
    candidates,
    dbContainers,
    connecting,
    refreshing,
    dialog,
    refresh,
    open,
    openDialog,
    setRoute,
    closeDialog,
    submitDialog,
    forget,
    takePrefetched,
    takeRedisPrefetched,
  }
})
