import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { t } from '../i18n'
import { relativeToBase } from '../lib/projectPaths'
import { searchDetectBackend, searchExecute } from '../lib/tauri'
import type { SearchBackendInfo, SearchMatch, SearchOptions } from '../types/search'
import { shellToPlatform } from '../types/tab'
import { useProjectStore } from './project'
import { createShellProbe } from './shellProbe'
import { useTabStore } from './tabs'

/** 検出に失敗したときの想定。grep に PCRE2 は無い。 */
const GREP_ONLY: SearchBackendInfo = {
  backend: 'grep',
  version: null,
  pcre2: false,
}

export const useSearchStore = defineStore('search', () => {
  /**
   * バックエンドを探すラッチ（仕組みは `stores/shellProbe.ts`）。**TTL は持たない**
   * （シェルが変わるまで有効）。rg を入れ替える運用は無いので、聞き直す理由が無い。
   *
   * **失敗もそのまま覚える。** grep への落ちは「検出できなかった」ではなく答えそのもので、
   * 覚えないと検索のたびに `wsl.exe` が 1 本上がる。
   */
  const backendProbe = createShellProbe<SearchBackendInfo>((shell) => searchDetectBackend(shell).catch(() => GREP_ONLY))
  /**
   * 今のシェルのバックエンド。**シェルごとの表を引く**ので、切り替えて probe が返るまでの
   * あいだ前のシェルの答え（別 distro の rg の機能）が出ることはない。
   */
  const backendInfo = computed<SearchBackendInfo | null>(() =>
    backendProbe.answerFor(useProjectStore().currentProject?.shell),
  )

  /**
   * キーから「開いてフォーカスしろ」と言われた合図（#307）。`seed` は選択していた文字列。
   *
   * **持ち回りの状態が要るのは、パネルが遅延マウントだから。** サイドバーは `v-else-if` ＋
   * `defineAsyncComponent` なので、アクションが走る時点ではチャンクすら読まれておらず、
   * `nextTick` を挟んでも template ref が null になる。ref を渡す既存の手
   * （`SideBar` の `fileTreeRef` 等）が使えない。
   *
   * **押すたびにオブジェクトごと差し替える**（`useOutlineSource` の `jumpRequest` と同じ形）
   * ので、同じ内容で押し直しても watcher が再発火する。**受け取った側は null に戻す**:
   * 残すと、パネルを閉じて開き直したときに `immediate` の watcher が古い合図を拾って
   * フォーカスを奪う。
   */
  const pendingOpen = ref<{ seed: string | null } | null>(null)

  /**
   * 検索する範囲を絞ったフォルダ（#376。ファイルツリーの右クリック「このフォルダ内を
   * 検索」）。絶対パスで持ち、**今の `activeRoot` の配下にあるときだけ効く**
   * （`scopeRel`）。プロジェクトや worktree を切り替えると自然に外れるので、切り替えの
   * 経路ごとに消す約束を持たなくてよい（`clear()` は検索語を消したときにも呼ばれるので、
   * そこで消すと絞り込みが打ち直しのたびに外れる）。
   */
  const scope = ref<string | null>(null)

  /** 絞ったフォルダの、プロジェクトのルートからの相対パス（`/` 区切り）。無効なら null。 */
  const scopeRel = computed(() => {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!scope.value || !project) return null
    return relativeToBase(projectStore.activeRoot, scope.value, shellToPlatform(project.shell))
  })

  function requestOpen(seed: string | null) {
    pendingOpen.value = { seed }
  }

  /**
   * 範囲を絞る（null で全体に戻す）。**範囲を変える入口はこれだけ。**
   *
   * **前の結果は捨てる**（#376）。パネルは `v-else-if` でマウントし直されるので入力欄は
   * 空に戻るが、ここを触らないとストアの結果だけが前の検索のまま残る。「In: src/lib」と
   * 出ているのに一覧はプロジェクト全体のヒット、という食い違いになり、しかも
   * `results.length` が非 0 なので「結果をタブで開く」が出たままになる。押すと
   * `lastOptions.query` を**新しい範囲で**引き直すので、画面と中身の違うタブができる。
   */
  function setScope(folder: string | null) {
    if (folder === scope.value) return
    scope.value = folder
    clear()
  }

  /** 検索の起点。絞っていればそのフォルダ、無ければプロジェクト（worktree）のルート。 */
  function searchRoot(): string {
    const projectStore = useProjectStore()
    return scopeRel.value ? (scope.value as string) : projectStore.activeRoot
  }
  const results = ref<SearchMatch[]>([])
  /**
   * いま出ている結果がどのクエリのものか（#307）。null は「結果が無い」。
   *
   * **キーで押し直したときに、同じ検索をもう一度走らせないための目印。** `searchSeq` は
   * 遅れて届いた結果を捨てるだけで**子プロセスは止めない**ので、連打するとプロジェクト
   * 全体の rg が並列に積み上がる。一方でプロジェクトの切り替えは `clear()` を呼ぶだけで
   * 入力欄の中身は残るため、「語は入っているのに 0 件」から抜け出す道も要る。
   */
  const resultsFor = computed(() => lastOptions.value?.query ?? null)
  /** いま出ている結果を作った指定。書き出し（`extractToTab`）は同じ条件で検索し直す。 */
  const lastOptions = ref<SearchOptions | null>(null)
  const truncated = ref(false)
  const searching = ref(false)
  const error = ref<string | null>(null)
  let searchSeq = 0

  /** SideBar のヘッダが読む。機能の有無は `backendInfo` から直に読む（聞き方を 2 通りにしない）。 */
  const backend = computed(() => backendInfo.value?.backend ?? null)

  /**
   * 検出は**べき等**にしてある（#304）。バックエンドはシェルごとに違いうる（Windows は
   * 同梱のサイドカー、WSL は distro のもの）ので、シェルごとに覚えて、変わったときだけ
   * 取り直す。**呼ぶ側に「無効化」を持たせないため**で、以前はプロジェクトストアが
   * `resetBackend()` を呼ぶ約束になっていた。シェルを差し替える経路を足した人がそれを
   * 忘れると、別の distro の rg の機能でトグルが出たままになる。
   */
  async function detectBackend(): Promise<void> {
    const projectStore = useProjectStore()
    await backendProbe.ask(projectStore.currentProject?.shell, projectStore.activeRoot)
  }

  async function search(options: SearchOptions) {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project || !options.query.trim()) return
    if (!backendInfo.value) await detectBackend()
    if (!backendInfo.value) return

    searching.value = true
    error.value = null
    const mySeq = ++searchSeq
    try {
      const result = await searchExecute(project.shell, searchRoot(), options)
      if (mySeq !== searchSeq) return
      results.value = result.matches
      lastOptions.value = options
      truncated.value = result.truncated
    } catch (e) {
      // **失敗も seq で捨てる**（#376）。1 本目が 30 秒の `wait_with_timeout` や rg の
      // exit 2 で落ちるころには、2 本目の結果が出ていることがある。`lastOptions` まで
      // 消すと「結果をタブで開く」も何も起こさなくなる。
      if (mySeq !== searchSeq) return
      error.value = String(e)
      results.value = []
      lastOptions.value = null
    } finally {
      if (mySeq === searchSeq) searching.value = false
    }
  }

  /**
   * いま出ている結果を捨てる（プロジェクトや worktree の切り替え、範囲の変更、語を消したとき）。
   *
   * **`searching` の扱いは `stores/issues.ts` の `load` の doc が正本**（「seq を進めた者が
   * 持つ。例外は `clear()`」）。ここもその形で、`searchSeq` を進めて自分で下ろす。
   *
   * search 固有の帰結（#376）: 進めないと、捨てた直後に前の検索が返って `results` と
   * `lastOptions` を書き戻す。範囲を絞った場合は「In: そのフォルダ」の下にプロジェクト
   * 全体のヒットが並び、しかも「結果をタブで開く」が押せる、という `setScope` の doc が
   * 防ぐと書いた状態そのものになる。
   */
  function clear() {
    searchSeq++
    results.value = []
    lastOptions.value = null
    truncated.value = false
    error.value = null
    searching.value = false
  }

  const extracting = ref(false)

  /**
   * いまの結果と同じ条件で、上限を広げて検索し直し、grep の出力の形でエディタのタブに
   * 書き出す（#376）。パスはプロジェクトのルートからの相対で、`パス:行: 内容` の 1 行ずつ。
   * タブでは `Ctrl+Click` / F12 でその行のファイルへ飛べる（`lib/editorPathJump.ts`）。
   *
   * **無題のタブにする**（ファイルに書かない）。保存すれば残せるし、閉じれば消える。
   */
  async function extractToTab(): Promise<void> {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    const options = lastOptions.value
    if (!project || !options || extracting.value) return
    extracting.value = true
    const tabStore = useTabStore()
    // **タブは先に出す**（#376）。書き出しは上限 10,000 件で rg を回し直すので、押してから
    // 数秒かかる。結果が揃ってから作る形だと、そのあいだ画面が何も変わらず、押せていない
    // ように見える。`setUntitledContent` が届いたところで中身を差し替える。
    const tabId = tabStore.addBlankEditorTab({
      title: t('search.extractTitle', { query: options.query }),
      content: `# ${t('search.extracting', { query: options.query })}\n`,
    })
    try {
      const root = projectStore.activeRoot
      const result = await searchExecute(project.shell, searchRoot(), { ...options, extract: true })
      const rel = (p: string) => relativeToBase(root, p, shellToPlatform(project.shell)) ?? p
      const header = [
        `# ${t('search.extractHeader', { query: options.query, count: String(result.matches.length) })}${scopeRel.value ? ` (${scopeRel.value})` : ''}`,
        `# ${t('search.extractHint')}`,
      ]
      if (result.truncated) header.push(`# ${t('search.extractTruncated', { max: String(result.matches.length) })}`)
      const body = result.matches.map((m) => `${rel(m.path)}:${m.line}: ${m.content}`)
      tabStore.setUntitledContent(tabId, `${[...header, '', ...body].join('\n')}\n`)
    } catch (e) {
      error.value = String(e)
      // **失敗もタブに出す**（先に出した「検索中」のまま残さない）。パネルのエラー帯は
      // 見えていないことがある（書き出しのあとはタブへ目が移っている）。
      tabStore.setUntitledContent(tabId, `# ${t('search.extractFailed')}\n# ${String(e)}\n`)
    } finally {
      extracting.value = false
    }
  }

  return {
    scopeRel,
    setScope,
    extracting,
    extractToTab,
    backend,
    backendInfo,
    pendingOpen,
    requestOpen,
    resultsFor,
    results,
    truncated,
    searching,
    error,
    detectBackend,
    search,
    clear,
  }
})
