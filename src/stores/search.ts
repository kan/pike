import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SearchMatch, SearchBackend } from '../types/search'
import { searchDetectBackend, searchExecute } from '../lib/tauri'
import { useProjectStore } from './project'

export const useSearchStore = defineStore('search', () => {
  const backend = ref<SearchBackend | null>(null)
  const detecting = ref(false)
  const results = ref<SearchMatch[]>([])
  const truncated = ref(false)
  const searching = ref(false)
  const error = ref<string | null>(null)
  let searchSeq = 0

  async function detectBackend() {
    const project = useProjectStore().currentProject
    if (!project) return
    detecting.value = true
    try {
      backend.value = await searchDetectBackend(project.shell)
    } catch {
      backend.value = 'grep'
    } finally {
      detecting.value = false
    }
  }

  async function search(
    query: string,
    isRegex: boolean,
    globInclude?: string,
    globExclude?: string,
  ) {
    const project = useProjectStore().currentProject
    if (!project || !query.trim()) return
    if (!backend.value) await detectBackend()
    if (!backend.value) return

    searching.value = true
    error.value = null
    const mySeq = ++searchSeq
    try {
      const result = await searchExecute(
        project.shell,
        project.root,
        query,
        isRegex,
        globInclude || undefined,
        globExclude || undefined,
      )
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
