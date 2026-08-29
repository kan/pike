import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { normalizeSep, toRelativePath } from '../lib/paths'
import { loadJson, saveJson } from '../lib/storage'
import { diagnosticsRun } from '../lib/tauri'
import type { Diagnostic, ProviderRun } from '../types/diagnostics'
import { useProjectStore } from './project'

/** Projects whose runs include golangci-lint, by id. Off by default: it type
 *  checks the whole module on top of dozens of linters, so it belongs behind a
 *  choice — and a per-project one, since a single global flag would start
 *  running another project's (possibly containerized) linter the moment its
 *  Problems panel opened. */
const GOLANGCI_KEY = 'pike:diagnostics-golangci'

function loadGolangciProjects(): string[] {
  const raw = loadJson<unknown>(GOLANGCI_KEY, [])
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
}

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
  const golangciAvailable = ref(false)
  const golangciProjects = ref(loadGolangciProjects())
  const golangciEnabled = computed(() => {
    const id = useProjectStore().currentProject?.id
    return !!id && golangciProjects.value.includes(id)
  })
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

  // Diagnostics indexed by file (canonical '/' separator), built once per run.
  // Lets each editor tab look up its file in O(1) instead of scanning the array.
  const byFile = computed(() => {
    const m = new Map<string, Diagnostic[]>()
    for (const d of diagnostics.value) {
      const key = normalizeSep(d.file, '/')
      const arr = m.get(key)
      if (arr) arr.push(d)
      else m.set(key, [d])
    }
    return m
  })

  /** Diagnostics for one file, matched by its root-relative or absolute path.
   *  Resolves the project root internally (single source of truth). */
  function forFile(absPath: string): Diagnostic[] {
    const root = useProjectStore().activeRoot
    const rel = normalizeSep(toRelativePath(absPath, root), '/')
    const abs = normalizeSep(absPath, '/')
    return byFile.value.get(rel) ?? byFile.value.get(abs) ?? []
  }

  async function run() {
    const projectStore = useProjectStore()
    const project = projectStore.currentProject
    // 走っているあいだは重ねない（#270）。以前は SideBar のボタンの disabled だけが
    // 止めていたので、パレットから 2 回叩くと `cargo check` / `tsc`（最長 180 秒）が
    // 並行して走った。
    if (!project || running.value) return
    running.value = true
    error.value = null
    const mySeq = ++seq
    try {
      const result = await diagnosticsRun(
        project.shell,
        projectStore.activeRoot,
        golangciEnabled.value,
        project.golangciCommand,
      )
      if (mySeq !== seq) return
      diagnostics.value = result.diagnostics
      providers.value = result.providers
      truncated.value = result.truncated
      golangciAvailable.value = result.golangciAvailable
      lastRunAt.value = Date.now()
    } catch (e) {
      if (mySeq !== seq) return
      error.value = String(e)
      diagnostics.value = []
      providers.value = []
    } finally {
      // **`mySeq === seq` で条件を付けないこと。** `clear()`（プロジェクト切替）が
      // seq を進めるので、`cargo check` / `tsc` の最中に切り替えると立てたままになる。
      // 上のガードがあるぶん「新しい run が既に走っている」ことは起こらないので、
      // 立てた側が必ず下ろすのが正しい（付けていたころは、切り替えた先の Problems が
      // 「確認中…」のまま二度と動かなかった）。
      running.value = false
    }
  }

  /** Add or drop golangci-lint for this project, then re-check with it. */
  function toggleGolangci() {
    const id = useProjectStore().currentProject?.id
    if (!id) return
    golangciProjects.value = golangciEnabled.value
      ? golangciProjects.value.filter((p) => p !== id)
      : [...golangciProjects.value, id]
    saveJson(GOLANGCI_KEY, golangciProjects.value)
    run()
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
    // Availability is a property of the project, unlike the user's preference.
    golangciAvailable.value = false
  }

  return {
    diagnostics,
    providers,
    running,
    truncated,
    error,
    lastRunAt,
    golangciAvailable,
    golangciEnabled,
    errorCount,
    warningCount,
    total,
    grouped,
    forFile,
    run,
    toggleGolangci,
    triggerAutoRun,
    clear,
  }
})
