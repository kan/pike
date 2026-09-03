import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { searchDetectBackend, searchExecute } from '../lib/tauri'
import type { SearchBackendInfo, SearchMatch, SearchOptions } from '../types/search'
import { shellId } from '../types/tab'
import { useProjectStore } from './project'

/** 検出に失敗したときの想定。grep に PCRE2 は無い。 */
const GREP_ONLY: SearchBackendInfo = {
  backend: 'grep',
  version: null,
  pcre2: false,
}

export const useSearchStore = defineStore('search', () => {
  const backendInfo = ref<SearchBackendInfo | null>(null)
  const detecting = ref(false)

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

  function requestOpen(seed: string | null) {
    pendingOpen.value = { seed }
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
  const resultsFor = ref<string | null>(null)
  const truncated = ref(false)
  const searching = ref(false)
  const error = ref<string | null>(null)
  let searchSeq = 0

  /** SideBar のヘッダが読む。機能の有無は `backendInfo` から直に読む（聞き方を 2 通りにしない）。 */
  const backend = computed(() => backendInfo.value?.backend ?? null)

  /**
   * 検出は**べき等**にしてある（#304）。バックエンドはシェルごとに違いうる（Windows は
   * 同梱のサイドカー、WSL は distro のもの）ので、検出済みのシェルを覚えて、変わったときだけ
   * 取り直す。**呼ぶ側に「無効化」を持たせないため**で、以前はプロジェクトストアが
   * `resetBackend()` を呼ぶ約束になっていた。シェルを差し替える経路を足した人がそれを
   * 忘れると、別の distro の rg の機能でトグルが出たままになる。
   */
  const detectedShell = ref<string | null>(null)

  /**
   * 走っている検出。**べき等のガードは結果が入ってからしか効かない**ので、これが無いと
   * 同じ tick に 2 回頼まれたときに 2 回走る（パネルを開くと `detectBackend` と、seed 付きの
   * 検索から呼ばれるものが重なる。WSL では `wsl.exe` が 2 本立つ）。
   */
  let inFlight: Promise<void> | null = null

  async function detectBackend(): Promise<void> {
    const project = useProjectStore().currentProject
    if (!project) return
    const key = shellId(project.shell)
    if (backendInfo.value && detectedShell.value === key) return
    if (inFlight) return inFlight

    detecting.value = true
    inFlight = (async () => {
      try {
        backendInfo.value = await searchDetectBackend(project.shell)
      } catch {
        backendInfo.value = GREP_ONLY
      } finally {
        detectedShell.value = key
        detecting.value = false
        inFlight = null
      }
    })()
    return inFlight
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
      const result = await searchExecute(project.shell, projectStore.activeRoot, options)
      if (mySeq !== searchSeq) return
      results.value = result.matches
      resultsFor.value = options.query
      truncated.value = result.truncated
    } catch (e) {
      error.value = String(e)
      results.value = []
      resultsFor.value = null
    } finally {
      searching.value = false
    }
  }

  function clear() {
    results.value = []
    resultsFor.value = null
    truncated.value = false
    error.value = null
  }

  return {
    backend,
    backendInfo,
    pendingOpen,
    requestOpen,
    resultsFor,
    detecting,
    results,
    truncated,
    searching,
    error,
    detectBackend,
    search,
    clear,
  }
})
