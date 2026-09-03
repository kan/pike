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
  const results = ref<SearchMatch[]>([])
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

  async function detectBackend() {
    const project = useProjectStore().currentProject
    if (!project) return
    const key = shellId(project.shell)
    if (backendInfo.value && detectedShell.value === key) return
    detecting.value = true
    try {
      backendInfo.value = await searchDetectBackend(project.shell)
    } catch {
      backendInfo.value = GREP_ONLY
    } finally {
      detectedShell.value = key
      detecting.value = false
    }
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
      truncated.value = result.truncated
    } catch (e) {
      error.value = String(e)
      results.value = []
    } finally {
      searching.value = false
    }
  }

  function clear() {
    results.value = []
    truncated.value = false
    error.value = null
  }

  return {
    backend,
    backendInfo,
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
