<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { highlightSelectionMatches } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { promptDialog } from '../../composables/useConfirmDialog'
import { useEditorInfo } from '../../composables/useEditorInfo'
import { markRecentlySaved } from '../../composables/useFsWatcher'
import { useOutlineSource } from '../../composables/useOutlineSource'
import { useI18n } from '../../i18n'
import { gitDiffGutter, setDiffLines } from '../../lib/editorGitGutter'
import { jumpToDefinitionExtension } from '../../lib/editorJumpTo'
import { minimap } from '../../lib/editorMinimap'
import { editorSearch, searchKeymap } from '../../lib/editorSearch'
import { getEditorTheme } from '../../lib/editorThemes'
import { formatLineRange } from '../../lib/format'
import { getLanguage, getLanguageLabel } from '../../lib/languages'
import { basename, extension } from '../../lib/paths'
import { fsReadFile, fsWriteFile, gitDiffLines, openUrlWithConfirm, pickSaveFile } from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import type { EditorTab } from '../../types/tab'

const { t } = useI18n()
const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()
const editorInfo = useEditorInfo()
const outlineSource = useOutlineSource()

// Dynamic compartments for settings that can change at runtime
const themeCompartment = new Compartment()
const minimapCompartment = new Compartment()
const wordWrapCompartment = new Compartment()
const tabSizeCompartment = new Compartment()
const indentUnitCompartment = new Compartment()

const tab = computed(() => tabStore.tabs.find((t): t is EditorTab => t.id === props.tabId && t.kind === 'editor'))

const editorRef = ref<HTMLDivElement>()
const previewRef = ref<HTMLDivElement>()
const mermaidRef = ref<HTMLDivElement>()
let editorView: EditorView | null = null
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
let savedContent = ''
const isDirty = ref(false)
const currentEncoding = ref('UTF-8')
const currentLineEnding = ref<'LF' | 'CRLF'>('LF')

// Markdown preview
const viewMode = ref<'edit' | 'split' | 'preview'>('edit')
const debouncedDocVersion = ref(0)
let docVersionTimer: ReturnType<typeof setTimeout> | null = null
let syncingScroll = false

function bumpDocVersion() {
  if (docVersionTimer) clearTimeout(docVersionTimer)
  docVersionTimer = setTimeout(() => {
    debouncedDocVersion.value++
  }, 250)
}

function registerOutlineSource() {
  if (!editorView || !tab.value) return
  outlineSource.set({
    tabId: props.tabId,
    path: tab.value.path ?? '',
    langId: tab.value.path ? extension(tab.value.path) : '',
    view: editorView,
  })
}

const fileExt = computed(() => (tab.value ? extension(tab.value.path) : ''))
const isMarkdown = computed(() => fileExt.value === 'md' || fileExt.value === 'markdown')
const isCsv = computed(() => fileExt.value === 'csv' || fileExt.value === 'tsv')
const isMermaid = computed(() => fileExt.value === 'mermaid' || fileExt.value === 'mmd')
const isSvg = computed(() => fileExt.value === 'svg')
const isJson = computed(() => fileExt.value === 'json' || fileExt.value === 'jsonc')
const isJsonl = computed(() => fileExt.value === 'jsonl' || fileExt.value === 'ndjson')

const jsonTokens = computed(() => getEditorTheme(settingsStore.editorThemeName).tokens)

const JSON_POPUP_MAX_LEN = 50_000
const jsonStringPopup = ref<{ content: string; x: number; y: number; truncated: boolean } | null>(null)

function openJsonStringPopup(content: string, x: number, y: number) {
  const maxWidth = 560
  const margin = 8
  const clampedX = Math.min(Math.max(margin, x), window.innerWidth - maxWidth - margin)
  const truncated = content.length > JSON_POPUP_MAX_LEN
  const body = truncated ? content.slice(0, JSON_POPUP_MAX_LEN) : content
  jsonStringPopup.value = { content: body, x: clampedX, y, truncated }
}

function closeJsonStringPopup() {
  jsonStringPopup.value = null
}
const hasPreview = computed(
  () => isMarkdown.value || isCsv.value || isMermaid.value || isSvg.value || isJson.value || isJsonl.value,
)

const showEditor = computed(() => viewMode.value !== 'preview')
const showPreview = computed(() => viewMode.value !== 'edit')

const SVG_PURIFY_OPTS = {
  ADD_TAGS: [
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'defs',
    'clipPath',
    'use',
    'marker',
    'foreignObject',
    'style',
  ],
  ADD_ATTR: [
    'viewBox',
    'xmlns',
    'd',
    'fill',
    'stroke',
    'stroke-width',
    'transform',
    'x',
    'y',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'width',
    'height',
    'points',
    'text-anchor',
    'dominant-baseline',
    'font-size',
    'font-family',
    'font-weight',
    'clip-path',
    'marker-end',
    'refX',
    'refY',
    'orient',
    'markerWidth',
    'markerHeight',
    'dx',
    'dy',
    'preserveAspectRatio',
    'startOffset',
    'data-id',
    'data-node-id',
    'data-look',
  ],
}

function buildCsvPreview(text: string): string {
  const ext = fileExt.value
  const delimiter = ext === 'tsv' ? '\t' : ','
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return '<p>Empty</p>'

  function parseLine(line: string): string[] {
    const result: string[] = []
    let current = '',
      inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"'
          i++
        } else if (ch === '"') inQuotes = false
        else current += ch
      } else {
        if (ch === '"') inQuotes = true
        else if (ch === delimiter) {
          result.push(current)
          current = ''
        } else current += ch
      }
    }
    result.push(current)
    return result
  }

  const maxRows = 10000
  const headers = parseLine(lines[0])
  let html = '<table><thead><tr><th>#</th>'
  for (const h of headers) html += `<th>${escapeHtml(h)}</th>`
  html += '</tr></thead><tbody>'
  const rowCount = Math.min(lines.length - 1, maxRows)
  for (let i = 0; i < rowCount; i++) {
    const cells = parseLine(lines[i + 1])
    html += `<tr><td class="csv-row-num">${i + 1}</td>`
    for (const c of cells) html += `<td>${escapeHtml(c)}</td>`
    html += '</tr>'
  }
  html += '</tbody></table>'
  if (lines.length - 1 > maxRows)
    html += `<p style="text-align:center;color:var(--text-secondary);font-size:12px">${escapeHtml(t('csv.truncated', { max: String(maxRows) }))}</p>`
  return html
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightJson(pretty: string): string {
  const escaped = escapeHtml(pretty)
  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (_match, strVal, colon, boolVal, nullVal, numVal) => {
      if (strVal) {
        if (colon) return `<span class="json-key">${strVal}</span>${colon}`
        const expandable = /\\[nr]/.test(strVal)
        const cls = expandable ? 'json-string json-string-expandable' : 'json-string'
        return `<span class="${cls}">${strVal}</span>`
      }
      if (boolVal) return `<span class="json-bool">${boolVal}</span>`
      if (nullVal) return `<span class="json-null">${nullVal}</span>`
      return `<span class="json-number">${numVal}</span>`
    },
  )
}

function buildJsonPreview(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return `<div class="json-empty">${escapeHtml(t('json.empty'))}</div>`
  try {
    const parsed = JSON.parse(trimmed)
    const pretty = JSON.stringify(parsed, null, 2)
    return `<pre class="json-pretty">${highlightJson(pretty)}</pre>`
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `<div class="json-error"><div class="json-error-title">${escapeHtml(t('json.parseError'))}</div><pre>${escapeHtml(msg)}</pre></div>`
  }
}

function buildJsonlPreview(text: string): string {
  const lines = text.split(/\r?\n/)
  const maxRecords = 1000
  let html = '<div class="jsonl-list">'
  let displayed = 0
  let total = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    total++
    if (displayed >= maxRecords) continue
    displayed++
    const lineNum = i + 1
    try {
      const parsed = JSON.parse(line)
      const pretty = JSON.stringify(parsed, null, 2)
      html += `<div class="jsonl-record"><div class="jsonl-index">${lineNum}</div><pre class="json-pretty">${highlightJson(pretty)}</pre></div>`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      html += `<div class="jsonl-record jsonl-record-error"><div class="jsonl-index">${lineNum}</div><div class="json-error"><pre>${escapeHtml(msg)}</pre></div></div>`
    }
  }
  html += '</div>'
  if (total > maxRecords) {
    html += `<p class="jsonl-truncated">${escapeHtml(t('jsonl.truncated', { max: String(maxRecords) }))}</p>`
  }
  return html
}

const previewHtml = computed(() => {
  void debouncedDocVersion.value
  if (!showPreview.value || !editorView) return ''
  const text = editorView.state.doc.toString()
  if (isCsv.value) return buildCsvPreview(text)
  if (isMermaid.value) return '' // rendered asynchronously
  if (isSvg.value) return DOMPurify.sanitize(text, SVG_PURIFY_OPTS)
  if (isJson.value) return buildJsonPreview(text)
  if (isJsonl.value) return buildJsonlPreview(text)
  return DOMPurify.sanitize(marked.parse(text) as string, SVG_PURIFY_OPTS)
})

const mermaidZoom = ref(1)

async function renderStandaloneMermaid() {
  await nextTick()
  if (!mermaidRef.value || !editorView) return
  const source = editorView.state.doc.toString().trim()
  if (!source) {
    mermaidRef.value.innerHTML = ''
    return
  }
  try {
    const { getMermaid } = await import('../../lib/mermaid')
    const mermaid = await getMermaid()
    const id = `mermaid-${props.tabId}-${Date.now()}`
    const { svg } = await mermaid.render(id, source)
    mermaidRef.value.innerHTML = `<div class="mermaid-inline">${svg}</div>`
  } catch (e) {
    const pre = document.createElement('pre')
    pre.className = 'mermaid-render-error'
    pre.textContent = String(e)
    mermaidRef.value.replaceChildren(pre)
  }
}

async function renderMarkdownMermaid() {
  await nextTick()
  if (!previewRef.value) return
  const codeBlocks = previewRef.value.querySelectorAll('code.language-mermaid')
  if (codeBlocks.length === 0) return
  try {
    const { getMermaid } = await import('../../lib/mermaid')
    const mermaid = await getMermaid()
    let idx = 0
    for (const block of codeBlocks) {
      const pre = block.parentElement
      if (!pre || pre.tagName !== 'PRE') continue
      const source = block.textContent ?? ''
      try {
        const id = `md-mermaid-${props.tabId}-${idx++}-${Date.now()}`
        const { svg } = await mermaid.render(id, source.trim())
        const wrapper = document.createElement('div')
        wrapper.className = 'mermaid-inline'
        wrapper.innerHTML = svg
        pre.replaceWith(wrapper)
      } catch {
        // Leave code block as-is on syntax error
      }
    }
  } catch {
    // mermaid not available
  }
}

// Standalone mermaid: re-render on content or view mode changes
watch([debouncedDocVersion, showPreview], () => {
  if (isMermaid.value && showPreview.value) renderStandaloneMermaid()
})
// Markdown mermaid: re-render after previewHtml is set
watch(previewHtml, () => {
  if (isMarkdown.value) renderMarkdownMermaid()
})

function updateTitle() {
  if (!tab.value) return
  const baseName = tab.value.path ? basename(tab.value.path) : tab.value.title.replace(/ \*$/, '')
  tabStore.setTabTitle(props.tabId, isDirty.value ? `${baseName} *` : baseName)
}

function updateDirtyState() {
  if (!editorView) return
  const current = editorView.state.doc.toString()
  const dirty = current !== savedContent
  if (dirty !== isDirty.value) {
    isDirty.value = dirty
    updateTitle()
  }
  // Sync content for untitled tabs (non-reactive Map to avoid $subscribe churn)
  if (tab.value && !tab.value.path) {
    tabStore.untitledContent.set(props.tabId, current)
  }
}

function updateCursorInfo() {
  if (!editorView || !tab.value) return
  if (tabStore.activeTabId !== props.tabId) return
  const pos = editorView.state.selection.main.head
  const line = editorView.state.doc.lineAt(pos)
  editorInfo.update({
    line: line.number,
    col: pos - line.from + 1,
    encoding: currentEncoding.value,
    lineEnding: currentLineEnding.value,
    fileType: getLanguageLabel(tab.value.path),
    tabSize: settingsStore.editorTabSize,
    tabId: props.tabId,
  })
}

/** Shell config for file I/O — falls back to PowerShell when no project is set. */
const shellForIO = computed(() => projectStore.currentProject?.shell ?? ({ kind: 'powershell' } as const))

async function save(overrideEncoding?: string) {
  if (!editorView || !tab.value || saving.value || tab.value.readOnly) return

  // Untitled tab: prompt for file path first
  if (!tab.value.path) {
    let chosen: string | null
    if (shellForIO.value.kind === 'wsl') {
      const root = projectStore.currentProject?.root ?? '/'
      const defaultPath = root.endsWith('/') ? root : `${root}/`
      chosen = await promptDialog(t('editor.saveAsPrompt'), defaultPath, t('editor.saveAsPlaceholder'))
    } else {
      chosen = await pickSaveFile()
    }
    if (!chosen) return
    tab.value.path = chosen
    tab.value.initialContent = undefined
    tabStore.untitledContent.delete(props.tabId)
  }

  const enc = overrideEncoding ?? currentEncoding.value
  saving.value = true
  try {
    let content = editorView.state.doc.toString()
    if (currentLineEnding.value === 'CRLF') {
      content = content.replace(/\n/g, '\r\n')
    }
    markRecentlySaved(tab.value.path)
    await fsWriteFile(shellForIO.value, tab.value.path, content, enc !== 'UTF-8' ? enc : undefined)
    if (overrideEncoding) {
      currentEncoding.value = enc
      updateCursorInfo()
    }
    savedContent = editorView.state.doc.toString()
    updateDirtyState()
    updateTitle()
    refreshDiffGutter()
  } catch (e) {
    error.value = String(e)
  } finally {
    saving.value = false
  }
}

async function loadContent(encoding?: string): Promise<string> {
  if (!tab.value) throw new Error('No tab')

  if (tab.value.initialContent !== undefined) {
    savedContent = tab.value.initialContent
    currentEncoding.value = 'UTF-8'
    currentLineEnding.value = tab.value.initialContent.includes('\r\n') ? 'CRLF' : 'LF'
    return savedContent
  }

  const result = await fsReadFile(shellForIO.value, tab.value.path, encoding)
  currentEncoding.value = result.encoding
  // Detect and normalize line endings for CodeMirror (which uses \n internally)
  currentLineEnding.value = result.content.includes('\r\n') ? 'CRLF' : 'LF'
  const normalized = result.content.replace(/\r\n/g, '\n')
  savedContent = normalized
  return normalized
}

// --- Git diff gutter ---
async function refreshDiffGutter() {
  if (!editorView || !tab.value || tab.value.readOnly || tab.value.initialContent !== undefined) return
  const project = projectStore.currentProject
  if (!project) return // git diff requires a project root
  try {
    const diff = await gitDiffLines(project.root, project.shell, tab.value.path)
    editorView?.dispatch({ effects: setDiffLines.of(diff) })
  } catch {
    // Not a git repo or file not tracked — ignore
  }
}

// --- Context menu ---
const ctxMenu = ref<{ x: number; y: number } | null>(null)
const ctxLineRange = ref<{ start: number; end: number } | null>(null)

function onEditorContextMenu(e: MouseEvent) {
  e.preventDefault()
  ctxHasSelection.value = editorView ? !editorView.state.selection.main.empty : false
  ctxLineRange.value = computeContextLineRange(e)
  ctxMenu.value = { x: e.clientX, y: e.clientY }
  nextTick(() => {
    window.addEventListener('mousedown', closeCtxMenu, { once: true })
  })
}

function computeContextLineRange(e: MouseEvent): { start: number; end: number } | null {
  if (!editorView) return null
  const sel = editorView.state.selection.main
  if (!sel.empty) {
    const start = editorView.state.doc.lineAt(sel.from).number
    const end = editorView.state.doc.lineAt(sel.to).number
    return { start, end }
  }
  const pos = editorView.posAtCoords({ x: e.clientX, y: e.clientY })
  if (pos == null) return null
  const line = editorView.state.doc.lineAt(pos).number
  return { start: line, end: line }
}

function closeCtxMenu() {
  ctxMenu.value = null
}

function execUndo() {
  closeCtxMenu()
  if (editorView) undo(editorView)
}

function execRedo() {
  closeCtxMenu()
  if (editorView) redo(editorView)
}

function execCut() {
  closeCtxMenu()
  if (!editorView) return
  editorView.focus()
  document.execCommand('cut')
}

function execCopy() {
  closeCtxMenu()
  if (!editorView) return
  editorView.focus()
  document.execCommand('copy')
}

async function execPaste() {
  closeCtxMenu()
  if (!editorView) return
  const text = await navigator.clipboard.readText()
  if (text) editorView.dispatch(editorView.state.replaceSelection(text))
}

function openGitHistory() {
  closeCtxMenu()
  if (!tab.value) return
  tabStore.addHistoryTab({ filePath: tab.value.path })
}

function openGitHistoryForLine() {
  const range = ctxLineRange.value
  closeCtxMenu()
  if (!tab.value || !range) return
  tabStore.addHistoryTab({ filePath: tab.value.path, lineRange: range })
}

const gitHistoryLineLabel = computed(() => {
  const range = ctxLineRange.value
  if (!range) return t('editor.gitHistoryRange', { range: '' })
  return t('editor.gitHistoryRange', { range: formatLineRange(range) })
})

const isReadOnlyTab = computed(() => tab.value?.readOnly ?? false)
// Snapshot selection state when context menu opens (not reactive — avoids stale computed)
const ctxHasSelection = ref(false)

function createEditorView(container: HTMLElement, content: string) {
  const isReadOnly = tab.value?.readOnly ?? false
  const lang = tab.value ? getLanguage(tab.value.path) : null
  const hasFile = tab.value && !tab.value.initialContent
  const extensions = [
    themeCompartment.of(getEditorTheme(settingsStore.editorThemeName).extension),
    lineNumbers(),
    highlightActiveLine(),
    history(),
    editorSearch(),
    highlightSelectionMatches(),
    tabSizeCompartment.of(EditorState.tabSize.of(settingsStore.editorTabSize)),
    indentUnitCompartment.of(indentUnit.of(' '.repeat(settingsStore.editorTabSize))),
    wordWrapCompartment.of(settingsStore.editorWordWrap ? EditorView.lineWrapping : []),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        updateDirtyState()
        bumpDocVersion()
        outlineSource.bumpVersion(props.tabId)
      }
      if (update.selectionSet || update.docChanged) {
        updateCursorInfo()
        outlineSource.updateCaret(props.tabId, update.state.selection.main.head)
      }
    }),
    EditorView.theme({
      '&': { height: '100%', fontSize: '13px' },
      '.cm-scroller': {
        fontFamily: "'PlemolJP Console NF', 'Cascadia Code', 'Fira Code', monospace",
      },
      '.cm-searchMatch': {
        backgroundColor: 'rgba(255, 213, 0, 0.25)',
      },
      '.cm-searchMatch-selected': {
        backgroundColor: 'rgba(255, 213, 0, 0.5)',
      },
    }),
  ]

  // Git diff gutter + minimap (only for real files)
  if (hasFile) {
    extensions.push(gitDiffGutter())
    extensions.push(minimapCompartment.of(settingsStore.editorMinimap ? minimap() : []))
  }

  // Go-to-definition (only for real files; previews / readonly snapshots skipped)
  if (hasFile) {
    extensions.push(
      jumpToDefinitionExtension({
        getContext: () => {
          const t = tab.value
          const project = projectStore.currentProject
          if (!t?.path || !project) return null
          return {
            filePath: t.path,
            projectRoot: project.root,
            shell: project.shell,
            langId: extension(t.path),
          }
        },
        onJump: (target) => {
          tabStore.addEditorTab({ path: target.path, initialLine: target.line })
        },
      }),
    )
  }

  if (!isReadOnly) {
    extensions.push(
      keymap.of([
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
        {
          key: 'Mod-s',
          run: () => {
            save()
            return true
          },
        },
      ]),
    )
  } else {
    extensions.push(EditorState.readOnly.of(true))
    extensions.push(keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]))
  }
  if (lang) extensions.push(lang)

  return new EditorView({
    state: EditorState.create({ doc: content, extensions }),
    parent: container,
  })
}

async function reopenWithEncoding(encoding: string) {
  if (!editorRef.value || !tab.value) return
  loading.value = true
  try {
    editorView?.destroy()
    editorView = null
    const content = await loadContent(encoding)
    if (!editorRef.value) return
    loading.value = false
    editorView = createEditorView(editorRef.value, content)
    if (viewMode.value === 'split') {
      editorView.scrollDOM.addEventListener('scroll', onEditorScroll)
    }
    isDirty.value = false
    updateTitle()
    updateCursorInfo()
    refreshDiffGutter()
    if (tabStore.activeTabId === props.tabId) {
      registerOutlineSource()
    }
  } catch (e) {
    loading.value = false
    error.value = String(e)
  }
}

function changeLineEnding(le: 'LF' | 'CRLF') {
  currentLineEnding.value = le
  // Mark as dirty since the save output will differ
  if (!isDirty.value) {
    isDirty.value = true
    updateTitle()
  }
  updateCursorInfo()
}

function jumpToLine(lineNum?: number) {
  if (!lineNum || !editorView) return
  const docLines = editorView.state.doc.lines
  const line = editorView.state.doc.line(Math.min(lineNum, docLines))
  editorView.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
  })
  if (tab.value) tab.value.initialLine = undefined
}

function onGlobalKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && jsonStringPopup.value) {
    closeJsonStringPopup()
  }
}

onMounted(async () => {
  document.addEventListener('keydown', onGlobalKeyDown)
  if (!editorRef.value || !tab.value) return

  try {
    const content = await loadContent()
    if (!editorRef.value) return
    loading.value = false
    editorView = createEditorView(editorRef.value, content)
    jumpToLine(tab.value?.initialLine)
    updateCursorInfo()
    refreshDiffGutter()

    // Register callbacks for StatusBar to change encoding/line ending
    editorInfo.registerCallbacks(
      (enc) => reopenWithEncoding(enc),
      (le) => changeLineEnding(le),
      (enc) => save(enc),
    )

    if (tabStore.activeTabId === props.tabId) {
      registerOutlineSource()
    }
  } catch (e) {
    loading.value = false
    error.value = String(e)
  }
})

// Scroll sync
function onEditorScroll() {
  if (syncingScroll || viewMode.value !== 'split' || !previewRef.value || !editorView) return
  const scroller = editorView.scrollDOM
  const ratio = scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight || 1)
  syncingScroll = true
  previewRef.value.scrollTop = ratio * (previewRef.value.scrollHeight - previewRef.value.clientHeight)
  requestAnimationFrame(() => {
    syncingScroll = false
  })
}

function onPreviewScroll() {
  if (syncingScroll || viewMode.value !== 'split' || !previewRef.value || !editorView) return
  const preview = previewRef.value
  const ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight || 1)
  syncingScroll = true
  const scroller = editorView.scrollDOM
  scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight)
  requestAnimationFrame(() => {
    syncingScroll = false
  })
}

function resolveLocalPath(href: string): string | null {
  const project = projectStore.currentProject
  if (!project || !tab.value) return null

  // Prevent opening arbitrary protocol handlers (mailto:, javascript:, data:, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:\\/.test(href)) return null

  // Decode URL-encoded characters (%20 → space, etc.)
  try {
    href = decodeURIComponent(href)
  } catch {
    return null
  }

  const root = project.root
  const isWsl = project.shell.kind === 'wsl'
  const sep = isWsl ? '/' : '\\'

  // Determine the directory containing the current file
  const filePath = tab.value.path
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const dir = lastSep > 0 ? filePath.slice(0, lastSep) : root

  // Normalize all separators to forward slash for resolution, then convert back
  const joined = `${dir}/${href}`.replace(/\\/g, '/')
  const parts = joined.split('/')

  // Resolve . and .. segments, preserving leading empty string for absolute paths
  const resolved: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '.') continue
    if (part === '' && i > 0) continue // skip empty parts except the leading one
    if (part === '..') {
      // Don't pop past the root (keep at least the drive letter or leading empty string)
      if (resolved.length > 1) resolved.pop()
    } else {
      resolved.push(part)
    }
  }

  const fullPath = resolved.join(sep)

  // Security: ensure the resolved path is within the project root
  const normalizedRoot = root.replace(/[/\\]+$/, '')
  const normalizedFull = fullPath.replace(/[/\\]+$/, '')
  // Case-insensitive comparison on Windows
  const rootCheck = isWsl ? normalizedFull : normalizedFull.toLowerCase()
  const rootPrefix = isWsl ? normalizedRoot : normalizedRoot.toLowerCase()
  if (rootCheck !== rootPrefix && !rootCheck.startsWith(rootPrefix + (isWsl ? '/' : '\\'))) {
    return null
  }

  return fullPath
}

async function onPreviewClick(e: MouseEvent) {
  const strEl = (e.target as HTMLElement).closest('.json-string-expandable')
  if (strEl) {
    try {
      const raw = strEl.textContent ?? ''
      const decoded = JSON.parse(raw)
      const rect = strEl.getBoundingClientRect()
      openJsonStringPopup(String(decoded), rect.left, rect.bottom + 4)
    } catch {
      /* skip malformed */
    }
    return
  }

  const target = (e.target as HTMLElement).closest('a')
  if (!target) return
  const href = target.getAttribute('href')
  if (!href) return
  e.preventDefault()

  if (href.startsWith('http://') || href.startsWith('https://')) {
    await openUrlWithConfirm(href)
    return
  }

  if (href.startsWith('#')) return

  // Local file link → resolve and open in editor
  const resolved = resolveLocalPath(href)
  if (resolved) {
    tabStore.addEditorTab({ path: resolved })
  }
}

// Jump to line when initialLine changes on an existing tab
watch(
  () => tab.value?.initialLine,
  (lineNum) => {
    if (lineNum) jumpToLine(lineNum)
  },
)

// Reload file content when requested (e.g. from CLI)
watch(
  () => tab.value?.reloadRequested,
  (val) => {
    if (val) reopenWithEncoding(currentEncoding.value)
  },
)

// External file change detection
const externalChangeNotice = ref<'modified' | 'deleted' | null>(null)
let pendingReload: ReturnType<typeof setTimeout> | null = null

watch(
  () => tab.value?.externalChange,
  (change) => {
    if (!change || !tab.value) return
    tab.value.externalChange = undefined

    if (change === 'deleted') {
      externalChangeNotice.value = 'deleted'
      return
    }
    // modified — debounce to coalesce burst events
    if (!isDirty.value) {
      if (pendingReload) clearTimeout(pendingReload)
      pendingReload = setTimeout(() => {
        pendingReload = null
        reopenWithEncoding(currentEncoding.value)
      }, 300)
    } else {
      externalChangeNotice.value = 'modified'
    }
  },
)

function reloadExternal() {
  externalChangeNotice.value = null
  reopenWithEncoding(currentEncoding.value)
}

function overwriteExternal() {
  externalChangeNotice.value = null
  save()
}

function dismissExternal() {
  externalChangeNotice.value = null
}

watch(
  () => viewMode.value,
  (mode) => {
    if (mode === 'split' && editorView) {
      editorView.scrollDOM.addEventListener('scroll', onEditorScroll)
    } else if (editorView) {
      editorView.scrollDOM.removeEventListener('scroll', onEditorScroll)
    }
  },
)

watch(
  () => tabStore.activeTabId,
  (id) => {
    if (id === props.tabId && editorView) {
      editorView.requestMeasure()
      updateCursorInfo()
      editorInfo.registerCallbacks(
        (enc) => reopenWithEncoding(enc),
        (le) => changeLineEnding(le),
      )
      registerOutlineSource()
    } else if (id !== props.tabId) {
      editorInfo.clear()
      outlineSource.clear(props.tabId)
    }
  },
)

// Live-apply editor settings changes
watch(
  () => settingsStore.editorThemeName,
  (name) => {
    if (!editorView) return
    editorView.dispatch({ effects: themeCompartment.reconfigure(getEditorTheme(name).extension) })
  },
)

watch(
  () => settingsStore.editorMinimap,
  (on) => {
    if (!editorView) return
    editorView.dispatch({ effects: minimapCompartment.reconfigure(on ? minimap() : []) })
  },
)

watch(
  () => settingsStore.editorWordWrap,
  (on) => {
    if (!editorView) return
    editorView.dispatch({ effects: wordWrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) })
  },
)

watch(
  () => settingsStore.editorTabSize,
  (size) => {
    if (!editorView) return
    editorView.dispatch({
      effects: [
        tabSizeCompartment.reconfigure(EditorState.tabSize.of(size)),
        indentUnitCompartment.reconfigure(indentUnit.of(' '.repeat(size))),
      ],
    })
  },
)

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeyDown)
  if (docVersionTimer) clearTimeout(docVersionTimer)
  editorView?.scrollDOM.removeEventListener('scroll', onEditorScroll)
  editorView?.destroy()
  editorView = null
  if (tabStore.activeTabId === props.tabId) {
    editorInfo.clear()
  }
  outlineSource.clear(props.tabId)
})
</script>

<template>
  <div class="editor-tab">
    <div v-if="hasPreview && !loading && !error" class="preview-toolbar">
      <button class="preview-toggle" :class="{ active: viewMode === 'edit' }" @click="viewMode = 'edit'">{{ t('editor.edit') }}</button>
      <button class="preview-toggle" :class="{ active: viewMode === 'split' }" @click="viewMode = 'split'">{{ t('editor.split') }}</button>
      <button class="preview-toggle" :class="{ active: viewMode === 'preview' }" @click="viewMode = 'preview'">{{ t('editor.preview') }}</button>
      <template v-if="isMermaid && showPreview">
        <span class="toolbar-spacer" />
        <button class="preview-toggle" @click="mermaidZoom = Math.max(0.25, mermaidZoom - 0.25)">−</button>
        <span class="zoom-label">{{ Math.round(mermaidZoom * 100) }}%</span>
        <button class="preview-toggle" @click="mermaidZoom = Math.min(4, mermaidZoom + 0.25)">+</button>
        <button class="preview-toggle" @click="mermaidZoom = 1">{{ t('mermaid.reset') }}</button>
      </template>
    </div>
    <!-- External change warning bar -->
    <div v-if="externalChangeNotice === 'modified'" class="external-change-bar">
      <span>{{ t('editor.externalModified') }}</span>
      <div class="external-change-actions">
        <button @click="reloadExternal">{{ t('editor.reload') }}</button>
        <button @click="overwriteExternal">{{ t('editor.overwrite') }}</button>
        <button @click="dismissExternal">{{ t('editor.dismiss') }}</button>
      </div>
    </div>
    <div v-if="externalChangeNotice === 'deleted'" class="external-change-bar warning">
      <span>{{ t('editor.externalDeleted') }}</span>
      <div class="external-change-actions">
        <button @click="save()">{{ t('editor.save') }}</button>
        <button @click="dismissExternal">{{ t('editor.dismiss') }}</button>
      </div>
    </div>
    <div v-if="loading" class="editor-status">{{ t('common.loading') }}</div>
    <div v-else-if="error" class="editor-status error">{{ error }}</div>
    <div class="editor-body" :class="{ split: viewMode === 'split' }" v-show="!loading && !error">
      <div v-show="showEditor" ref="editorRef" class="editor-container" @contextmenu.prevent="onEditorContextMenu"></div>
      <div
        v-if="showPreview && !isMermaid"
        ref="previewRef"
        class="preview-pane"
        :class="{
          'md-preview': isMarkdown,
          'csv-preview': isCsv,
          'svg-preview': isSvg,
          'json-preview': isJson || isJsonl,
        }"
        v-html="previewHtml"
        @scroll="onPreviewScroll"
        @click="onPreviewClick"
      ></div>
      <div
        v-if="showPreview && isMermaid"
        ref="mermaidRef"
        class="preview-pane mermaid-preview"
        :style="{ '--mermaid-zoom': mermaidZoom }"
      ></div>
    </div>
    <div v-if="saving" class="save-indicator">{{ t('editor.saving') }}</div>

    <!-- Context Menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="editor-ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @mousedown.stop
      >
        <button @click="execUndo" :disabled="isReadOnlyTab"><span>{{ t('editor.undo') }}</span><span class="ctx-key">Ctrl+Z</span></button>
        <button @click="execRedo" :disabled="isReadOnlyTab"><span>{{ t('editor.redo') }}</span><span class="ctx-key">Ctrl+Shift+Z</span></button>
        <div class="ctx-separator"></div>
        <button @click="execCut" :disabled="isReadOnlyTab || !ctxHasSelection"><span>{{ t('editor.cut') }}</span><span class="ctx-key">Ctrl+X</span></button>
        <button @click="execCopy" :disabled="!ctxHasSelection"><span>{{ t('editor.copy') }}</span><span class="ctx-key">Ctrl+C</span></button>
        <button @click="execPaste" :disabled="isReadOnlyTab"><span>{{ t('editor.paste') }}</span><span class="ctx-key">Ctrl+V</span></button>
        <div class="ctx-separator"></div>
        <button @click="openGitHistory"><span>{{ t('editor.gitHistory') }}</span><span class="ctx-key">Alt+H</span></button>
        <button @click="openGitHistoryForLine" :disabled="!ctxLineRange">
          <span>{{ gitHistoryLineLabel }}</span>
        </button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="jsonStringPopup"
        class="json-string-popup-backdrop"
        @mousedown="closeJsonStringPopup"
      >
        <div
          class="json-string-popup"
          :style="{ left: jsonStringPopup.x + 'px', top: jsonStringPopup.y + 'px' }"
          @mousedown.stop
        >
          <div class="json-string-popup-header">
            <span>{{ t('json.stringPopup') }}</span>
            <button class="json-string-popup-close" @click="closeJsonStringPopup">×</button>
          </div>
          <pre class="json-string-popup-body">{{ jsonStringPopup.content }}</pre>
          <div v-if="jsonStringPopup.truncated" class="json-string-popup-footer">
            {{ t('json.stringTruncated', { max: String(JSON_POPUP_MAX_LEN) }) }}
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.editor-tab {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.preview-toolbar {
  display: flex;
  gap: 1px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.preview-toggle {
  padding: 3px 10px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
}

.preview-toggle.active {
  background: var(--accent);
  color: var(--text-active);
}

.preview-toggle:hover:not(.active) {
  background: var(--tab-hover-bg);
}

.toolbar-spacer {
  flex: 1;
}

.zoom-label {
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 36px;
  text-align: center;
  line-height: 24px;
}

.editor-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.editor-body.split {
  flex-direction: row;
}

.editor-body.split > .editor-container,
.editor-body.split > .preview-pane {
  width: 50%;
  border-right: 1px solid var(--border);
}

.editor-body.split > .preview-pane {
  border-right: none;
}

.editor-container {
  flex: 1;
  overflow: auto;
  min-width: 0;
}

.editor-container :deep(.cm-editor) {
  height: 100%;
}

.md-preview {
  flex: 1;
  overflow: auto;
  padding: 16px 24px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-primary);
}

.md-preview :deep(h1),
.md-preview :deep(h2),
.md-preview :deep(h3),
.md-preview :deep(h4) {
  color: var(--text-active);
  margin: 1.2em 0 0.5em;
  line-height: 1.3;
}

.md-preview :deep(h1) { font-size: 1.8em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
.md-preview :deep(h2) { font-size: 1.4em; border-bottom: 1px solid var(--border); padding-bottom: 0.2em; }
.md-preview :deep(h3) { font-size: 1.15em; }

.md-preview :deep(code) {
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 3px;
  font-family: "PlemolJP Console NF", "Cascadia Code", monospace;
  font-size: 0.9em;
}

.md-preview :deep(pre) {
  background: var(--bg-tertiary);
  padding: 12px 16px;
  border-radius: 4px;
  overflow-x: auto;
}

.md-preview :deep(pre code) {
  background: transparent;
  padding: 0;
}

.md-preview :deep(blockquote) {
  border-left: 3px solid var(--accent);
  margin: 0;
  padding: 4px 16px;
  color: var(--text-secondary);
}

.md-preview :deep(a) { color: var(--accent); }

.md-preview :deep(table) { border-collapse: collapse; width: 100%; }
.md-preview :deep(th),
.md-preview :deep(td) { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
.md-preview :deep(th) { background: var(--bg-tertiary); }

.md-preview :deep(img) { max-width: 100%; }
.md-preview :deep(.mermaid-inline) { text-align: center; margin: 16px 0; }
.md-preview :deep(.mermaid-inline svg) { max-width: 100%; height: auto; }
.md-preview :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
.md-preview :deep(ul),
.md-preview :deep(ol) { padding-left: 1.5em; }

.csv-preview {
  flex: 1;
  overflow: auto;
}

.csv-preview :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}

.csv-preview :deep(th),
.csv-preview :deep(td) {
  border: 1px solid var(--border);
  padding: 4px 8px;
  text-align: left;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.csv-preview :deep(th) {
  background: var(--bg-tertiary);
  color: var(--text-active);
  font-weight: 600;
  position: sticky;
  top: 0;
  z-index: 1;
}

.csv-preview :deep(tbody tr:hover) {
  background: var(--tab-hover-bg);
}

.csv-preview :deep(.csv-row-num) {
  color: var(--text-secondary);
  text-align: right;
  min-width: 40px;
  font-size: 11px;
}

.json-preview {
  flex: 1;
  overflow: auto;
  padding: 12px 16px;
  background: var(--bg-primary);
  font-family: var(--terminal-font, 'Cascadia Code', 'Fira Code', monospace);
  font-size: 13px;
  line-height: 1.5;
}

.json-preview :deep(.json-pretty) {
  margin: 0;
  white-space: pre;
  color: var(--text-primary);
  tab-size: 2;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

.json-preview :deep(.json-key) {
  color: v-bind('jsonTokens.key');
}

.json-preview :deep(.json-string) {
  color: v-bind('jsonTokens.string');
}

.json-preview :deep(.json-string-expandable) {
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}

.json-preview :deep(.json-string-expandable:hover) {
  filter: brightness(1.2);
}

.json-preview :deep(.json-number) {
  color: v-bind('jsonTokens.number');
}

.json-preview :deep(.json-bool) {
  color: v-bind('jsonTokens.bool');
}

.json-preview :deep(.json-null) {
  color: v-bind('jsonTokens.null');
}

.json-preview :deep(.json-empty) {
  color: var(--text-secondary);
  font-style: italic;
}

.json-preview :deep(.json-error) {
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-left: 3px solid #ff5370;
  padding: 8px 12px;
  border-radius: 4px;
}

.json-preview :deep(.json-error-title) {
  color: #ff5370;
  font-weight: 600;
  margin-bottom: 4px;
}

.json-preview :deep(.json-error pre) {
  margin: 0;
  white-space: pre-wrap;
  font-size: 12px;
}

.json-preview :deep(.jsonl-list) {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.json-preview :deep(.jsonl-record) {
  display: grid;
  grid-template-columns: 48px 1fr;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 8px;
  background: var(--bg-secondary);
}

.json-preview :deep(.jsonl-record-error) {
  border-left: 3px solid #ff5370;
}

.json-preview :deep(.jsonl-index) {
  color: var(--text-secondary);
  font-size: 11px;
  text-align: right;
  user-select: none;
  padding-top: 2px;
}

.json-preview :deep(.jsonl-truncated) {
  text-align: center;
  color: var(--text-secondary);
  font-size: 12px;
  margin-top: 12px;
}

.svg-preview {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 16px;
  background: var(--bg-primary);
}

.svg-preview :deep(svg) {
  max-width: 100%;
  height: auto;
}

.mermaid-preview {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8px;
}

.mermaid-preview :deep(.mermaid-inline) {
  width: 100%;
  transform: scale(var(--mermaid-zoom, 1));
  transform-origin: top center;
}

.mermaid-preview :deep(.mermaid-inline svg) {
  display: block;
  margin: 0 auto;
  height: auto;
}

.mermaid-preview :deep(.mermaid-render-error) {
  color: var(--danger);
  font-size: 13px;
  white-space: pre-wrap;
  font-family: monospace;
}

.editor-status {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 14px;
}

.editor-status.error {
  color: var(--danger);
  padding: 20px;
  white-space: pre-wrap;
}

.save-indicator {
  position: absolute;
  bottom: 8px;
  right: 16px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  padding: 2px 8px;
  border-radius: 3px;
}

.external-change-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--accent);
  color: var(--text-primary);
  flex-shrink: 0;
}

.external-change-bar.warning {
  border-bottom-color: var(--danger);
}

.external-change-actions {
  display: flex;
  gap: 4px;
}

.external-change-actions button {
  padding: 2px 8px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11px;
  border-radius: 3px;
  cursor: pointer;
}

.external-change-actions button:hover {
  background: var(--accent);
  color: var(--text-active);
  border-color: var(--accent);
}
</style>

<style>
/* Context menu — unscoped so Teleport works */
.editor-ctx-menu {
  position: fixed;
  z-index: 9999;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 0;
  min-width: 160px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.editor-ctx-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 14px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  gap: 16px;
}

.editor-ctx-menu button:hover:not(:disabled) {
  background: var(--tab-hover-bg);
}

.editor-ctx-menu button:disabled {
  color: var(--text-secondary);
  opacity: 0.5;
  cursor: default;
}

.editor-ctx-menu .ctx-separator {
  height: 1px;
  background: var(--border);
  margin: 4px 0;
}

/* JSON string popup */
.json-string-popup-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
}

.json-string-popup {
  position: fixed;
  z-index: 9999;
  max-width: 560px;
  max-height: 60vh;
  min-width: 240px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.json-string-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  user-select: none;
}

.json-string-popup-close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
}

.json-string-popup-close:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.json-string-popup-body {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  color: var(--text-primary);
  font-family: var(--terminal-font, 'Cascadia Code', 'Fira Code', monospace);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.json-string-popup-footer {
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  text-align: center;
}

/* Custom search panel */
.cm-panels {
  background: transparent !important;
  border: none !important;
}

.cm-search-custom {
  display: flex;
  flex-direction: column;
  gap: 4px;
  position: absolute;
  top: 4px;
  right: 72px;
  z-index: 10;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}

.cm-search-custom .search-row,
.cm-search-custom .replace-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.cm-search-custom .search-field {
  width: 180px;
  padding: 3px 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-size: 12px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  outline: none;
}

.cm-search-custom .search-field:focus {
  border-color: var(--accent);
}

.cm-search-custom .search-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 3px;
  cursor: pointer;
  flex-shrink: 0;
}

.cm-search-custom .search-icon-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.cm-search-custom .search-close-btn:hover {
  color: var(--danger);
}

.cm-search-custom .search-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-weight: 600;
  flex-shrink: 0;
}

.cm-search-custom .search-toggle-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.cm-search-custom .search-toggle-btn.active {
  background: rgba(var(--accent-rgb, 0, 122, 204), 0.2);
  border-color: var(--accent);
  color: var(--accent);
}

.cm-search-custom .search-match-info {
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 60px;
  text-align: center;
  white-space: nowrap;
  padding: 0 2px;
}

.cm-search-custom .toggle-replace {
  width: 18px;
  height: 18px;
  padding: 0;
}

.cm-search-custom .replace-row {
  padding-left: 20px;
}
</style>
