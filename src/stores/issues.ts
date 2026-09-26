import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { buildRepoLink } from '../lib/gitRemote'
import { buildIssueTree, issueParentNumbers } from '../lib/issueTree'
import { fuzzyMatch } from '../lib/paths'
import { loadJson, saveJson } from '../lib/storage'
import { issuesGhAvailable, issuesList } from '../lib/tauri'
import type { IssueKind, IssueSummary } from '../types/issues'
import { useGitStore } from './git'
import { useProjectStore } from './project'
import { createShellProbe } from './shellProbe'

/**
 * 一度に取る件数。**GitHub の一覧の 1 ページと同じ量**にしてある。これを超える数の open
 * issue を抱えるリポジトリでは、絞り込みではなくブラウザで見るほうが早い。
 *
 * **絞り込みはここで取った範囲に対するもの**なので、窓から外れたものには当たらない。
 * 並びが番号の降順（#357）である以上、外れるのは**いちばん古い open** から順（代償の
 * 説明は `issues_list` の doc が正本）。
 */
const LIMIT = 50

/**
 * ツリー / フラットの選択（#278）。**マシンローカルで、プロジェクトをまたいで共通**:
 * 読み方の好みであってリポジトリの性質ではない。
 */
const VIEW_KEY = 'pike:issues-view'

/** issue と PR のどちらを出すか（#413）。`VIEW_KEY` と同じくマシンローカルの好み。 */
const KIND_KEY = 'pike:issues-kind'

export type IssueView = 'tree' | 'flat'

/**
 * 種類ごとの一覧（#413）。**取得の状態も種類ごとに持つ**: 1 本の `loading` / `seq` を共有すると、
 * issue の取得中に PR へ切り替えたとき、PR の `ensureLoaded` が「取得中だから」で弾かれたうえ、
 * 飛んでいた issue の応答が後から来ても PR を取りに行く者が居ない。
 */
interface KindList {
  items: IssueSummary[]
  error: string | null
  loading: boolean
  /** 1 度でも一覧を取ったか。時刻は誰も読まないので真偽値で足りる。 */
  loaded: boolean
  seq: number
}

function emptyList(): KindList {
  return { items: [], error: null, loading: false, loaded: false, seq: 0 }
}

/**
 * GitHub issue の簡易表示（#278）。
 *
 * **出す条件は 2 つとも満たすとき**（`visible`）: origin が GitHub で、かつプロジェクトの
 * シェルに `gh` がある。片方だけで出すと、押しても必ず失敗するアイコンが並ぶ。
 *
 * **取得は最初にパネルを開いたときと、更新ボタンのときだけ**（`diagnostics` と同じ判断で、
 * 外部プロセスの起動を定期実行に混ぜない）。開き直しでは取り直さない（`loaded`）。
 */
export const useIssuesStore = defineStore('issues', () => {
  const kind = ref<IssueKind>(loadJson<IssueKind>(KIND_KEY, 'issue') === 'pr' ? 'pr' : 'issue')
  const lists = reactive<Record<IssueKind, KindList>>({ issue: emptyList(), pr: emptyList() })
  /** 今の種類の一覧。パネルもヘッダも、読むのはこちらだけ。 */
  const current = computed(() => lists[kind.value])
  const issues = computed(() => current.value.items)
  const error = computed(() => current.value.error)
  const loading = computed(() => current.value.loading)
  const filter = ref('')

  const view = ref<IssueView>(loadJson<IssueView>(VIEW_KEY, 'tree') === 'flat' ? 'flat' : 'tree')

  /**
   * 畳んである親の番号。**永続化しない**: issue の番号は増え続けるので覚えると死んだ番号が
   * 溜まるうえ、一覧は開くたびに取り直す。全展開 / 全畳みのボタンが 1 回で戻せるので、
   * 覚えておく価値がそのコストに見合わない（`tasks` の折り畳みはファイル名がキーで、
   * 数も増えないので覚えている）。
   */
  const collapsed = ref<Set<number>>(new Set())

  /**
   * `gh` を探すラッチ（仕組みは `stores/shellProbe.ts`）。
   *
   * **覚えるのは「見つかった」だけ**（`keep`）。見つからなかったほうを焼き付けると、
   * `PROBE_TIMEOUT` に届いた 1 回でパネルが消え、アイコンもパレットも出ないので更新ボタンに
   * 手が届かなくなる。見つかっていないあいだは watcher が発火するたび（プロジェクト切替・
   * シェル変更）に聞き直すので、`gh` を入れれば次に切り替えたところで出てくる。
   *
   * **TTL は持たない**（シェルが変わるまで有効）。`gh` を消す運用は無いので、見つかった
   * 答えを聞き直す理由が無い。
   */
  const ghProbe = createShellProbe<boolean>((shell, root, force) => issuesGhAvailable(shell, root, force), {
    keep: (found) => found,
  })

  /** 今のプロジェクトのシェル。検出のラッチを引くキー。 */
  const currentShell = computed(() => useProjectStore().currentProject?.shell ?? null)

  /**
   * origin が GitHub か。**判定は `buildRepoLink` に任せる**（`lib/gitRemote.ts` が
   * プロバイダの唯一の出典で、SCP 形式の origin もそこが解いている）。
   *
   * **`project.remoteUrl`（永続化済み）を先に見る。** `gitStore.remoteUrl` は
   * `git remote get-url` の往復が終わるまで null なので、そちらだけを見ているとアイコンが
   * 起動から数百 ms 遅れて増え、アイコン列が一度リフローする。git 側は補正役で、
   * リモートを付け替えたときはそちらが勝つ。
   */
  const repoLink = computed(() => buildRepoLink(useProjectStore().currentProject?.remoteUrl ?? useGitStore().remoteUrl))

  const isGitHub = computed(() => repoLink.value?.provider === 'github')

  /**
   * **このプロジェクトでは issue を扱えないと確定した**か（#353）。開いているパネルを
   * 逃がしてよいかの判断（`usePanelAvailability`）がこれを読む。
   *
   * **`isGitHub` の否定では駄目。** あれは「origin が GitHub でない」と「origin をまだ
   * 聞いていない」を同じ false に潰すので、**聞き終える前に GitHub のプロジェクトでも
   * ファイルツリーへ飛ぶ**（一時プロジェクトと、初めて開くプロジェクトは
   * `project.remoteUrl` を持たない）。**確定していないあいだは false に倒すこと。**
   */
  const ruledOut = computed(() => {
    if (isGitHub.value) return false
    const project = useProjectStore().currentProject
    if (!project) return false
    // 永続化済みの origin があるなら、それが GitHub でない時点で答えは出ている。
    return !!project.remoteUrl || useGitStore().remoteResolved
  })

  /** **今のシェルで**見つかっているか。シェルごとの表を引くので、切り替えて probe が
   *  返るまでのあいだ前のシェルの答えが `visible` に出ることはない。 */
  const ghAvailable = computed(() => ghProbe.answerFor(currentShell.value) === true)
  const visible = computed(() => isGitHub.value && ghAvailable.value)

  /**
   * 絞り込みの述語。番号・タイトル・ラベル名をつないだ 1 本の文字列に、他のパネルと同じ共有
   * `fuzzyMatch` を当てる（部分列一致なので、`308` は「3・0・8 をこの順に含む」もの全部に
   * 当たる。絞り込みであって検索ではない）。
   */
  const matcher = computed(() => {
    const q = filter.value.trim()
    if (!q) return () => true
    const needle = q.startsWith('#') ? q.slice(1) : q
    return (i: IssueSummary) => fuzzyMatch(`#${i.number} ${i.title} ${i.labels.map((l) => l.name).join(' ')}`, needle)
  })

  /**
   * 今ツリーで描いているか。**`view` を直に読まず、これを読むこと**（行・字下げの枠・ヘッダの
   * 全展開ボタン）。PR（#413）は親子を持たないので、好みが `tree` でもフラットで描く。
   * `view` は好みとして残す（issue へ戻ったらツリーに戻る）。
   */
  const treeView = computed(() => kind.value === 'issue' && view.value === 'tree')

  /**
   * 描く行。ツリーでは `parent` だけで組んで平らに落とし（`lib/issueTree.ts`）、フラットでは
   * 一致したものを取ってきた順（番号の降順。#357）に並べる。
   *
   * **フラットでは祖先を足さない。** 木が無い以上、一致していない親が混ざる理由が無い
   * （ツリー側で残すのは、親が消えると子がどこにぶら下がっていたか読めなくなるから）。
   */
  const rows = computed(() => {
    if (!treeView.value) {
      return issues.value.filter(matcher.value).map((issue) => ({ issue, depth: 0, hasChildren: false }))
    }
    return buildIssueTree(issues.value, { matches: matcher.value, collapsed: collapsed.value })
  })

  /** 木の中で子を持つ親（全展開 / 全畳みの対象）。 */
  const parentNumbers = computed(() => issueParentNumbers(issues.value))

  /**
   * 全展開 / 全畳みのボタンが次に何をするか（null＝畳める親が無いのでボタンを出さない）。
   * **1 つの値にまとめる**: 「出すか」と「どちら向きか」を別々に公開すると、読む側が
   * 2 つを必ず対で見る約束になる。
   */
  const collapseAction = computed<'collapse' | 'expand' | null>(() => {
    if (parentNumbers.value.length === 0) return null
    return parentNumbers.value.some((n) => !collapsed.value.has(n)) ? 'collapse' : 'expand'
  })

  function setView(next: IssueView) {
    view.value = next
    saveJson(VIEW_KEY, next)
  }

  /** 取得はパネルの watcher（`ensureLoaded`）に任せる。種類ごとに 1 回だけ取る。 */
  function setKind(next: IssueKind) {
    kind.value = next
    saveJson(KIND_KEY, next)
  }

  function toggleCollapsed(number: number) {
    const next = new Set(collapsed.value)
    if (!next.delete(number)) next.add(number)
    collapsed.value = next
  }

  /** 全展開 / 全畳みのトグル。1 つでも開いていれば畳む側に倒す。 */
  function toggleAll() {
    collapsed.value = collapseAction.value === 'collapse' ? new Set(parentNumbers.value) : new Set()
  }

  /**
   * `gh` を探す。**べき等**なので、呼ぶ側に「無効化」を持たせない（シェルを差し替える
   * 経路を足した人が忘れる）。ラッチの規約は `ghProbe` の宣言と `stores/shellProbe.ts`。
   */
  async function detect(force = false): Promise<void> {
    const projectStore = useProjectStore()
    await ghProbe.ask(projectStore.currentProject?.shell, projectStore.activeRoot, force)
  }

  /**
   * 取得の本体。**`loading` の持ち主はここ 1 本**（規約は「seq を進めた者が持つ。例外は
   * `clear()` で、そこが『この取得にはもう後継が要る』と決める側」）。以前は立てるのと
   * 下ろすのが 4 つの関数に散っていて、経路ごとに「なぜここで下ろす／下ろさない」の
   * コメントが要った。
   *
   * `redetect` は更新ボタンから。**`gh` が見つかっていないときだけ検出し直す**: ここが
   * 再検出の唯一の入口なので、一時的な失敗（WSL の冷えた起動など）で「無い」に落ちた環境でも
   * 押せば戻る。逆に見つかっている状態で probe すると、一覧の前に外部プロセスをもう 1 本
   * 起こすだけになる。
   */
  async function load(redetect: boolean): Promise<void> {
    // 種類は呼んだ時点で固定する（取得中に切り替えても、応答は取りに行った側へ入る）。
    const k = kind.value
    const list = lists[k]
    const mySeq = ++list.seq
    list.loading = true
    try {
      if (redetect && !ghAvailable.value) await detect(true)
      if (mySeq !== list.seq) return
      // 条件を満たさないなら `gh issue list` は走らせない: GitHub でないリポジトリで
      // 叩いても、読めないエラー文が出るだけで誰の役にも立たない。
      const projectStore = useProjectStore()
      const project = projectStore.currentProject
      if (!project || !visible.value) {
        list.items = []
        list.error = null
        return
      }
      const result = await issuesList(project.shell, projectStore.activeRoot, LIMIT, k)
      if (mySeq !== list.seq) return
      list.items = result.issues
      list.error = result.error
      list.loaded = true
    } catch (e) {
      if (mySeq !== list.seq) return
      list.items = []
      list.error = String(e)
      list.loaded = true
    } finally {
      // **古くなった取得は下ろさない。** 下ろすと、切り替え後に走り始めた取得の最中に
      // スピナーが消える。立てたままになる心配は無い（`clear()` が自分で下ろす）。
      if (mySeq === list.seq) list.loading = false
    }
  }

  /**
   * 新規 issue の作成ページ（`<repo>/issues/new`）。**作成は Pike の中で持たない**ので、
   * ヘッダの「+」はブラウザへ逃がす（読み取り専用という位置づけを崩さない）。
   * `visible` のときしか押せないので、ここが null を返すのは remote が取れない過渡状態だけ。
   *
   * **PR の一覧では出さない**（#413）。PR はブランチを push してから作るもので、一覧の
   * 横から始める流れが無い。
   */
  const newIssueUrl = computed(() =>
    isGitHub.value && kind.value === 'issue' ? `${repoLink.value?.url}/issues/new` : null,
  )

  /** 更新ボタン。`gh` の再検出を挟む。 */
  async function refresh(): Promise<void> {
    if (loading.value) return
    await load(true)
  }

  /** パネルを開いたときの取得。今の種類をまだ 1 回も取っていないときだけ走る（再検出は挟まない）。 */
  async function ensureLoaded(): Promise<void> {
    if (current.value.loaded || loading.value) return
    await load(false)
  }

  function clear() {
    for (const list of Object.values(lists)) {
      // **seq を進めてから下ろす。** 取得中に切り替えると、飛んでいる `gh` の応答は seq で
      // 捨てられるぶん `loading` を下ろす者が居なくなり、次のプロジェクトの `ensureLoaded` が
      // 「取得中だから」で弾かれて空のまま座る（手で更新するまで直らない）。
      Object.assign(list, emptyList(), { seq: list.seq + 1 })
    }
    filter.value = ''
    collapsed.value = new Set()
    // `gh` の有無はシェルの性質なので、`detect` の watcher に任せて落とさない。
  }

  /**
   * **検出はストアの setup で 1 回だけ張る**（`useFocusPolling` と同じ理由で、`start()` の
   * 中に置くとコンポーネントの scope に入ってマウント解除で黙って止まる）。
   *
   * origin が GitHub だと分かってから探すので、GitHub 以外のプロジェクトでは `gh` を
   * 1 度も起動しない。答えは Rust 側がプロセス単位で覚えるので、同じシェルのウィンドウを
   * 何枚開いても実際に走るのは 1 回。
   */
  watch(
    [isGitHub, currentShell],
    ([github]) => {
      if (github) void detect()
    },
    { immediate: true },
  )

  return {
    issues,
    error,
    loading,
    filter,
    rows,
    view,
    setView,
    treeView,
    kind,
    setKind,
    collapsed,
    toggleCollapsed,
    toggleAll,
    collapseAction,
    newIssueUrl,
    ruledOut,
    visible,
    refresh,
    ensureLoaded,
    clear,
  }
})
