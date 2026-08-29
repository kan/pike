import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { fsWatcher, isRecentlySaved, markRecentlySaved } from '../composables/useFsWatcher'
import { pathSep } from '../lib/paths'
import { ensurePikeDir } from '../lib/pikeDir'
import { fsReadFile, fsWriteFile } from '../lib/tauri'
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
  /**
   * 書き出し待ちの内容・宛先・タイマーを 1 つに持つ。**分けないこと**: 宛先は予約した
   * 時点で確定させる必要がある（切り替え中の編集が切り替え先へ書き込まれる）一方で、
   * `load` は「保存待ちなら読まない」を見るので、タイマーだけ残ると読み込みが恒久的に
   * 止まる。1 つの null 許容にすれば、その食い違いが起こりようがない。
   */
  let pending: {
    loc: NonNullable<ReturnType<typeof location>>
    content: string
    timer: ReturnType<typeof setTimeout>
  } | null = null

  const tasks = computed(() => lines.value.filter((l): l is TodoTask => l.kind === 'task'))
  const progress = computed(() => {
    const total = tasks.value.length
    const done = tasks.value.filter((t) => t.done).length
    return { done, total, remaining: total - done }
  })

  /**
   * `.pike/todo.md` の場所。基準は `activeRoot`（選択中の worktree）で、`project.root`
   * ではない（#269）。`pike todo` CLI は cwd から上に辿って `.git` を持つディレクトリを
   * 採るので、worktree で開いたターミナルからはその worktree の `.pike/todo.md` を書く。
   * ここを main 固定にすると、パネルと CLI が別のファイルを見ることになる。
   */
  function location() {
    const p = projectStore.currentProject
    const root = projectStore.activeRoot
    if (!p || !root) return null
    const sep = pathSep(p.shell)
    return { shell: p.shell, root, path: `${root}${sep}.pike${sep}todo.md` }
  }

  const filePath = computed(() => location()?.path ?? null)

  async function load() {
    const loc = location()
    if (!loc) {
      lines.value = []
      return
    }
    loading.value = true
    try {
      const { content } = await fsReadFile(loc.shell, loc.path)
      // Don't clobber: the referenced file changed mid-read — a project *or*
      // worktree switch — or the user has pending local edits about to be
      // written (a save is queued).
      if (filePath.value !== loc.path || pending) return
      // Drop a single trailing empty line produced by the file's final newline.
      const parsed = parse(content)
      if (parsed.length && parsed[parsed.length - 1].kind === 'raw' && parsed[parsed.length - 1].text === '') {
        parsed.pop()
      }
      lines.value = parsed
    } catch {
      if (filePath.value === loc.path && !pending) lines.value = [] // file not created yet
    } finally {
      loading.value = false
    }
  }

  /**
   * 書き込み先 `loc` は**保存を予約した時点のもの**（`pendingSave`）で、`location()` を
   * 呼び直さない。プロジェクトや worktree を切り替えると参照先が変わるので、待機中の
   * 編集が切り替え先のファイルへ書き込まれてしまう。
   */
  async function persistNow(loc: NonNullable<ReturnType<typeof location>>, content: string) {
    await ensurePikeDir(loc.shell, loc.root)
    markRecentlySaved(loc.path)
    await fsWriteFile(loc.shell, loc.path, content).catch(() => {})
  }

  function scheduleSave() {
    const loc = location()
    if (!loc) return
    if (pending) clearTimeout(pending.timer)
    pending = {
      loc,
      content: `${serialize(lines.value)}\n`,
      timer: setTimeout(flushSave, SAVE_DEBOUNCE_MS),
    }
  }

  /** 待機中の編集を、予約した時点の宛先へ即座に書き出す。 */
  function flushSave() {
    const p = pending
    pending = null
    if (!p) return
    clearTimeout(p.timer)
    void persistNow(p.loc, p.content)
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

  // Reload when the referenced file changes — a project or worktree switch.
  // **先に待機中の編集を書き出す**（宛先は切り替え前のファイル）。`load` は保存待ちの
  // あいだ読み込みを捨てるので、流さずに切り替えると切り替え前のタスクを表示したまま
  // になり、次の編集がその内容を切り替え先のファイルへ書き込む。
  watch(
    filePath,
    () => {
      flushSave()
      void load()
    },
    { immediate: true },
  )

  // Reload when the todo file changes on disk (external edit or another window),
  // ignoring our own debounced writes.
  fsWatcher.onFileChange((files) => {
    const path = filePath.value
    if (path && files.some((f) => f.path === path && !isRecentlySaved(f.path))) void load()
  })

  return { lines, tasks, progress, loading, filePath, load, toggle, setText, setDetail, remove, add, move, clear }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTodoStore, import.meta.hot))
}
