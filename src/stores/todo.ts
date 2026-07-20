import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { fsWatcher, isRecentlySaved, markRecentlySaved } from '../composables/useFsWatcher'
import { pathSep } from '../lib/paths'
import { fsCreateDir, fsReadFile, fsWriteFile } from '../lib/tauri'
import type { TodoLine, TodoTask } from '../types/todo'
import { useProjectStore } from './project'

const TASK_RE = /^(\s*[-*]\s+)\[([ xX])\]\s?(.*)$/
const SAVE_DEBOUNCE_MS = 400

let addedCounter = 0

const indentOf = (line: string) => line.length - line.trimStart().length

/**
 * Strip the block's own base indent (taken from its first non-blank line) so
 * relative nesting inside the detail is kept while the outer indent is not.
 */
function dedent(lines: string[]): string {
  const first = lines.find((l) => l.trim())
  const base = first ? first.slice(0, indentOf(first)) : ''
  return lines.map((l) => (l.startsWith(base) ? l.slice(base.length) : l.trimStart())).join('\n')
}

function parse(text: string): TodoLine[] {
  const raw = text.split('\n').map((l) => l.replace(/\r$/, '')) // tolerate CRLF
  const out: TodoLine[] = []
  let taskCount = 0
  let i = 0
  while (i < raw.length) {
    const m = raw[i].match(TASK_RE)
    if (!m) {
      out.push({ kind: 'raw', text: raw[i] })
      i++
      continue
    }
    // Continuation lines: indented deeper than the bullet and not tasks
    // themselves (a nested `- [ ]` stays its own task). Blank lines are taken
    // greedily, then given back, so they only stay when the block resumes.
    const indent = indentOf(m[1])
    const body: string[] = []
    let j = i + 1
    while (j < raw.length) {
      const blank = !raw[j].trim()
      if (!blank && (TASK_RE.test(raw[j]) || indentOf(raw[j]) <= indent)) break
      body.push(blank ? '' : raw[j])
      j++
    }
    while (body.length && !body[body.length - 1]) {
      body.pop()
      j--
    }
    out.push({
      kind: 'task',
      // Position-derived, so a reload (external edit, `pike todo` in a terminal)
      // keeps the panel's per-row UI state attached to the same task.
      id: `todo-${++taskCount}`,
      prefix: m[1],
      done: m[2].toLowerCase() === 'x',
      text: m[3],
      detail: dedent(body),
    })
    i = j
  }
  return out
}

function serialize(lines: TodoLine[]): string {
  const out: string[] = []
  for (const l of lines) {
    if (l.kind !== 'task') {
      out.push(l.text)
      continue
    }
    out.push(`${l.prefix}[${l.done ? 'x' : ' '}] ${l.text}`)
    if (!l.detail) continue
    const pad = ' '.repeat(indentOf(l.prefix) + 2)
    for (const d of l.detail.split('\n')) out.push(d ? `${pad}${d}` : '')
  }
  return out.join('\n')
}

/** Trim surrounding blank lines; the writer re-indents what remains. */
const normalizeDetail = (detail: string) => detail.replace(/\s+$/, '').replace(/^\n+/, '')

export const useTodoStore = defineStore('todo', () => {
  const projectStore = useProjectStore()

  const lines = ref<TodoLine[]>([])
  const loading = ref(false)
  /** Absolute path of the todo file currently loaded (for self-write filtering). */
  const loadedPath = ref<string | null>(null)
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let gitignoreEnsured = false

  const tasks = computed(() => lines.value.filter((l): l is TodoTask => l.kind === 'task'))
  const progress = computed(() => {
    const total = tasks.value.length
    const done = tasks.value.filter((t) => t.done).length
    return { done, total, remaining: total - done }
  })

  /** Project-fixed `.pike/todo.md` location (not worktree-specific, like uploads). */
  function location() {
    const p = projectStore.currentProject
    if (!p?.root) return null
    const sep = pathSep(p.shell)
    const pikeDir = `${p.root}${sep}.pike`
    return { shell: p.shell, sep, pikeDir, path: `${pikeDir}${sep}todo.md` }
  }

  const filePath = computed(() => location()?.path ?? null)

  async function load() {
    const loc = location()
    if (!loc) {
      lines.value = []
      loadedPath.value = null
      return
    }
    loadedPath.value = loc.path
    const projectId = projectStore.currentProject?.id
    loading.value = true
    try {
      const { content } = await fsReadFile(loc.shell, loc.path)
      // Don't clobber: the project switched mid-read (stale), or the user has
      // pending local edits about to be written (a save is queued).
      if (projectId !== projectStore.currentProject?.id || saveTimer) return
      // Drop a single trailing empty line produced by the file's final newline.
      const parsed = parse(content)
      if (parsed.length && parsed[parsed.length - 1].kind === 'raw' && parsed[parsed.length - 1].text === '') {
        parsed.pop()
      }
      lines.value = parsed
    } catch {
      if (projectId === projectStore.currentProject?.id && !saveTimer) lines.value = [] // file not created yet
    } finally {
      loading.value = false
    }
  }

  async function persistNow() {
    const loc = location()
    if (!loc) return
    await fsCreateDir(loc.shell, loc.pikeDir).catch(() => {}) // ensure .pike/ exists
    if (!gitignoreEnsured) {
      gitignoreEnsured = true
      // Keep .pike out of the repo, but never clobber a hand-edited .gitignore.
      const gi = `${loc.pikeDir}${loc.sep}.gitignore`
      fsReadFile(loc.shell, gi).catch(() => fsWriteFile(loc.shell, gi, '*\n').catch(() => {}))
    }
    markRecentlySaved(loc.path)
    await fsWriteFile(loc.shell, loc.path, `${serialize(lines.value)}\n`).catch(() => {})
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persistNow()
    }, SAVE_DEBOUNCE_MS)
  }

  function toggle(id: string) {
    const t = lines.value.find((l): l is TodoTask => l.kind === 'task' && l.id === id)
    if (!t) return
    t.done = !t.done
    scheduleSave()
  }

  function setText(id: string, text: string) {
    const t = lines.value.find((l): l is TodoTask => l.kind === 'task' && l.id === id)
    if (!t || t.text === text) return
    t.text = text
    scheduleSave()
  }

  function setDetail(id: string, detail: string) {
    const t = lines.value.find((l): l is TodoTask => l.kind === 'task' && l.id === id)
    const next = normalizeDetail(detail)
    if (!t || t.detail === next) return
    t.detail = next
    scheduleSave()
  }

  function remove(id: string) {
    const i = lines.value.findIndex((l) => l.kind === 'task' && l.id === id)
    if (i === -1) return
    lines.value.splice(i, 1)
    scheduleSave()
  }

  function add(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    // Distinct from the position-derived ids above; the next parse renumbers it.
    const id = `todo-new-${++addedCounter}`
    lines.value.push({ kind: 'task', id, prefix: '- ', done: false, text: trimmed, detail: '' })
    scheduleSave()
  }

  /** Remove task lines, keeping headings and free-text (raw) lines. With
   *  `doneOnly`, sweeps just the checked ones. */
  function clear(doneOnly = false) {
    const drop = (l: TodoLine) => l.kind === 'task' && (!doneOnly || l.done)
    if (!lines.value.some(drop)) return
    lines.value = lines.value.filter((l) => !drop(l))
    scheduleSave()
  }

  /** Reorder: move the dragged task to just before the drop-target task. */
  function move(fromId: string, toId: string) {
    if (fromId === toId) return
    const from = lines.value.findIndex((l) => l.kind === 'task' && l.id === fromId)
    let to = lines.value.findIndex((l) => l.kind === 'task' && l.id === toId)
    if (from === -1 || to === -1) return
    const [moved] = lines.value.splice(from, 1)
    if (from < to) to--
    lines.value.splice(to, 0, moved)
    scheduleSave()
  }

  // Reload when the project changes.
  watch(
    () => projectStore.currentProject?.id,
    () => void load(),
    { immediate: true },
  )

  // Reload when the todo file changes on disk (external edit or another window),
  // ignoring our own debounced writes.
  fsWatcher.onFileChange((files) => {
    const path = loadedPath.value
    if (path && files.some((f) => f.path === path && !isRecentlySaved(f.path))) void load()
  })

  return { lines, tasks, progress, loading, filePath, load, toggle, setText, setDetail, remove, add, move, clear }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTodoStore, import.meta.hot))
}
