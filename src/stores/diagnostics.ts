import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { diagnosticsRun } from '../lib/tauri'
import type { Diagnostic, ProviderRun } from '../types/diagnostics'
import { useProjectStore } from './project'

export interface DiagnosticFileGroup {
  file: string
  diagnostics: Diagnostic[]
  errorCount: number
  warningCount: number
}

export interface DiagnosticLangGroup {
  /** Provider source label, e.g. 'rustc' | 'tsc' | 'go vet'. */
  source: string
  files: DiagnosticFileGroup[]
  errorCount: number
  warningCount: number
}

export const useDiagnosticsStore = defineStore('diagnostics', () => {
  const diagnostics = ref<Diagnostic[]>([])
  const providers = ref<ProviderRun[]>([])
  const running = ref(false)
  const truncated = ref(false)
  const error = ref<string | null>(null)
  const lastRunAt = ref<number | null>(null)
  let seq = 0

  // Single pass over the array, memoized — avoids three separate full scans.
  const counts = computed(() => {
    let error = 0
    let warning = 0
    for (const d of diagnostics.value) {
      if (d.severity === 'error') error++
      else if (d.severity === 'warning') warning++
    }
    return { error, warning, total: diagnostics.value.length }
  })
  const errorCount = computed(() => counts.value.error)
  const warningCount = computed(() => counts.value.warning)
  const total = computed(() => counts.value.total)

  /** Diagnostics grouped by provider source, then by file (sorted: errors first). */
  const grouped = computed<DiagnosticLangGroup[]>(() => {
    const bySource = new Map<string, Map<string, Diagnostic[]>>()
    for (const d of diagnostics.value) {
      let files = bySource.get(d.source)
      if (!files) {
        files = new Map()
        bySource.set(d.source, files)
      }
      const arr = files.get(d.file) ?? []
      arr.push(d)
      files.set(d.file, arr)
    }
    const groups: DiagnosticLangGroup[] = []
    for (const [source, files] of bySource) {
      const fileGroups: DiagnosticFileGroup[] = []
      for (const [file, diags] of files) {
        // Sort a copy — mutating `diags` would mutate the `diagnostics` ref's arrays.
        const sorted = [...diags].sort((a, b) => a.line - b.line || a.column - b.column)
        let errorCount = 0
        let warningCount = 0
        for (const d of sorted) {
          if (d.severity === 'error') errorCount++
          else if (d.severity === 'warning') warningCount++
        }
        fileGroups.push({ file, diagnostics: sorted, errorCount, warningCount })
      }
      fileGroups.sort((a, b) => b.errorCount - a.errorCount || a.file.localeCompare(b.file))
      groups.push({
        source,
        files: fileGroups,
        errorCount: fileGroups.reduce((n, f) => n + f.errorCount, 0),
        warningCount: fileGroups.reduce((n, f) => n + f.warningCount, 0),
      })
    }
    groups.sort((a, b) => b.errorCount - a.errorCount || a.source.localeCompare(b.source))
    return groups
  })

  async function run() {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    if (!project) return
    running.value = true
    error.value = null
    const mySeq = ++seq
    try {
      const result = await diagnosticsRun(project.shell, projectStore.activeRoot)
      if (mySeq !== seq) return
      diagnostics.value = result.diagnostics
      providers.value = result.providers
      truncated.value = result.truncated
      lastRunAt.value = Date.now()
    } catch (e) {
      if (mySeq !== seq) return
      error.value = String(e)
      diagnostics.value = []
      providers.value = []
    } finally {
      if (mySeq === seq) running.value = false
    }
  }

  // Auto-run: re-check on save / fs-watcher changes, but throttled so a burst
  // of edits can't spawn back-to-back cargo/tsc runs. Only active once the user
  // has opened the panel at least once (lastRunAt set) — we never kick off a
  // heavy check in the background unprompted.
  const MIN_INTERVAL_MS = 15_000
  const DEBOUNCE_MS = 1_500
  let autoTimer: ReturnType<typeof setTimeout> | null = null

  function triggerAutoRun() {
    if (!lastRunAt.value || autoTimer) return
    const since = Date.now() - lastRunAt.value
    const wait = Math.max(DEBOUNCE_MS, MIN_INTERVAL_MS - since)
    autoTimer = setTimeout(() => {
      autoTimer = null
      if (!running.value) run()
      else triggerAutoRun() // a run is in flight — retry after it settles
    }, wait)
  }

  function clear() {
    seq++
    if (autoTimer) {
      clearTimeout(autoTimer)
      autoTimer = null
    }
    diagnostics.value = []
    providers.value = []
    truncated.value = false
    error.value = null
    lastRunAt.value = null
  }

  return {
    diagnostics,
    providers,
    running,
    truncated,
    error,
    lastRunAt,
    errorCount,
    warningCount,
    total,
    grouped,
    run,
    triggerAutoRun,
    clear,
  }
})
