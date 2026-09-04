<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { highlightSelectionMatches } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import DOMPurify from 'dompurify'
import { ArrowUp, RefreshCw } from 'lucide-vue-next'
import { Marked } from 'marked'
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useAnchoredPopup } from '../../composables/useAnchoredPopup'
import { confirmDialog, dialogOpen, promptDialog } from '../../composables/useConfirmDialog'
import { useEditorInfo } from '../../composables/useEditorInfo'
import { markRecentlySaved } from '../../composables/useFsWatcher'
import { useMarkdownImages } from '../../composables/useMarkdownImages'
import { useMarkdownLinkPaste } from '../../composables/useMarkdownLinkPaste'
import { type OutlineJump, useOutlineSource } from '../../composables/useOutlineSource'
import { injectToTerminal } from '../../composables/useTerminalInject'
import { useI18n } from '../../i18n'
import { conflictHighlight, hasConflictMarkers } from '../../lib/editorConflict'
import { diagnosticsExtension, type EditorDiagnostic, setDiagnostics } from '../../lib/editorDiagnostics'
import { gitDiffGutter, setDiffLines } from '../../lib/editorGitGutter'
import { jumpToDefinitionExtension } from '../../lib/editorJumpTo'
import {
  isHttpUrl,
  type MarkdownAction,
  markdownAssistKeymap,
  runMarkdownAction,
  type ToolbarAction,
} from '../../lib/editorMarkdown'
import { minimap } from '../../lib/editorMinimap'
import { presetKeymap } from '../../lib/editorPresetKeys'
import { editorSearch, searchKeymap } from '../../lib/editorSearch'
import { getEditorTheme } from '../../lib/editorThemes'
import { imageHostOf, remoteImageDataUrl, retryRemoteImage } from '../../lib/externalImages'
import { buildFontFamily } from '../../lib/fontDetection'
import { formatLineRange } from '../../lib/format'
import { detectFrontmatter } from '../../lib/frontmatter'
import { parseFrontmatter } from '../../lib/frontmatterParse'
import { chordLabel } from '../../lib/keys'
import { firstLineOf, getLanguage, getLanguageLabel } from '../../lib/languages'
import { footnotes } from '../../lib/markdownFootnotes'
import { isExternalLink, openUrlWithConfirm } from '../../lib/openUrl'
import {
  basename,
  dirname,
  extension,
  isEmbeddableImage,
  isMarkdownPath,
  mimeType,
  pathSep,
  toRelativePath,
} from '../../lib/paths'
import { relativeToBase } from '../../lib/projectPaths'
import { buildRstPreview } from '../../lib/rstPreview'
import { ALLOWED_URI_REGEXP } from '../../lib/sanitizeHtml'
import { createHeadingSlugger } from '../../lib/slug'
import { fsDirsExist, fsReadFile, fsReadFileBase64, fsWriteFile, gitDiffLines, pickSaveFile } from '../../lib/tauri'
import { escapeHtml, splitDelimited } from '../../lib/text'
import { useDiagnosticsStore } from '../../stores/diagnostics'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import { type EditorTab, shellToPlatform } from '../../types/tab'
import MarkdownToolbar from '../editor/MarkdownToolbar.vue'
import MinimapToggle from '../editor/MinimapToggle.vue'
import WrapToggle from '../editor/WrapToggle.vue'
import HelpButton from '../HelpButton.vue'

// Own `marked` instances: the footnote extension (#241) belongs to this preview
// and must not leak into the agent chat's Markdown.
//
// Two of them, because registering a block-level extension is not free. It puts
// marked on its `startBlock` path, which copies the rest of the document once
// per paragraph — quadratic in the file, on a preview that re-renders while you
// type. Measured on concatenated manual pages: +13% at 49 KB, +136% at 390 KB,
// all of it paid by documents that have no footnotes at all. One `includes`
// keeps them on the plain parser.
const markedPlain = new Marked()
const markedFootnotes = new Marked(footnotes())

/** The parser this text needs. */
function parserFor(text: string): Marked {
  return text.includes('[^') ? markedFootnotes : markedPlain
}

const { t, locale } = useI18n()
const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const projectStore = useProjectStore()
const settingsStore = useSettingsStore()
const editorInfo = useEditorInfo()
const outlineSource = useOutlineSource()
const statusMessageStore = useStatusMessageStore()
const diagStore = useDiagnosticsStore()

// Dynamic compartments for settings that can change at runtime
const themeCompartment = new Compartment()
const minimapCompartment = new Compartment()
const wordWrapCompartment = new Compartment()
const tabSizeCompartment = new Compartment()
const indentUnitCompartment = new Compartment()
const fontCompartment = new Compartment()
const backdropCompartment = new Compartment()
// The conflict extension builds its button labels as raw DOM, so it has to be
// re-registered to pick up a new UI language (#223).
const conflictCompartment = new Compartment()
/** プリセットで変わる CodeMirror のキー（#261）。 */
const presetKeymapCompartment = new Compartment()
// A Save As turns an untitled buffer into a real file without rebuilding the
// view, so everything the file's kind decides — its language and the Markdown
// assist bindings (#241) — has to be reconfigurable rather than settled once.
//
// Two compartments rather than one because they sit at different depths in the
// extension list, and that ordering is load-bearing: `defaultKeymap` binds
// `Mod-i` to `selectParentSyntax`, so the assist keymap only wins by being
// registered ahead of it. The language stays where it has always been, last.
const languageCompartment = new Compartment()
const markdownCompartment = new Compartment()

/** Editor font theme driven by the editor's own font settings. */
function fontTheme() {
  return EditorView.theme({
    '&': { fontSize: `${settingsStore.editorFontSize}px` },
    '.cm-scroller': { fontFamily: buildFontFamily(settingsStore.editorFontName) },
  })
}

/**
 * Window transparency (issue #162): when a backdrop is active, strip the editor
 * theme's opaque background so the translucent app surface (and the desktop
 * behind it) shows through. `!important` overrides the base theme's `&`
 * background regardless of stylesheet order.
 */
function backdropTheme() {
  if (settingsStore.windowBackdrop === 'none') return []
  return EditorView.theme({
    '&': { backgroundColor: 'transparent !important' },
    '.cm-gutters': { backgroundColor: 'transparent !important' },
  })
}

const tab = computed(() => tabStore.tabs.find((t): t is EditorTab => t.id === props.tabId && t.kind === 'editor'))

const editorRef = ref<HTMLDivElement>()
const previewRef = ref<HTMLDivElement>()
const mermaidRef = ref<HTMLDivElement>()
let editorView: EditorView | null = null
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
/** The path turned out to be a directory: offer ways to open it, not an error. */
const isDirectory = ref(false)
/** Directory actions target a new window by default — opening one in this
 *  window is a project switch, which kills every tab including the terminal the
 *  path was clicked in. */
const openInNewWindow = ref(true)
const directoryProject = computed(() =>
  isDirectory.value && tab.value?.path ? projectStore.projectForRoot(tab.value.path) : null,
)
let savedContent = ''
const isDirty = ref(false)
const currentEncoding = ref('UTF-8')
const currentLineEnding = ref<'LF' | 'CRLF'>('LF')

// Markdown preview
const viewMode = ref<'edit' | 'split' | 'preview'>('edit')
// Floating "back to top" button: shown once the preview is scrolled past this.
const previewScrolled = ref(false)
const BACK_TO_TOP_THRESHOLD = 300
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
const isMarkdown = computed(() => isMarkdownPath(tab.value?.path ?? ''))
const isCsv = computed(() => fileExt.value === 'csv' || fileExt.value === 'tsv')
const isMermaid = computed(() => fileExt.value === 'mermaid' || fileExt.value === 'mmd')
const isSvg = computed(() => fileExt.value === 'svg')
const isJson = computed(() => fileExt.value === 'json' || fileExt.value === 'jsonc')
const isJsonl = computed(() => fileExt.value === 'jsonl' || fileExt.value === 'ndjson')
const isRst = computed(() => fileExt.value === 'rst')

/**
 * 本文を HTML として出すプレビュー（#284）。**画像の `data:` 化と見出し id を通す種別**という
 * 意味で、CSV / JSON のような表形式とは分かれる。3 か所（watcher 2 つと CSS クラス）が同じ
 * 条件を書いていたので、概念に名前を付けて 1 度だけ宣言する。
 */
const isProsePreview = computed(() => isMarkdown.value || isRst.value)

const jsonTokens = computed(() => getEditorTheme(settingsStore.effectiveEditorThemeName).tokens)

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
  () =>
    isMarkdown.value || isRst.value || isCsv.value || isMermaid.value || isSvg.value || isJson.value || isJsonl.value,
)

const showEditor = computed(() => viewMode.value !== 'preview')
const showPreview = computed(() => viewMode.value !== 'edit')

// Header (plain editor): breadcrumb from the project root to the file.
const breadcrumbSegments = computed(() => {
  const p = tab.value?.path
  if (!p) return []
  return toRelativePath(p, projectStore.activeRoot).split(/[/\\]/).filter(Boolean)
})

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
  ALLOWED_URI_REGEXP,
}

function buildCsvPreview(text: string): string {
  const ext = fileExt.value
  const delimiter = ext === 'tsv' ? '\t' : ','
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  if (lines.length === 0) return '<p>Empty</p>'

  // RFC 4180 の引用符の扱いは `lib/text.ts` と共有する（rst の `csv-table` も同じ規則）。
  const parseLine = (line: string) => splitDelimited(line, delimiter)

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

const JSON_TOKEN =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

/**
 * **色分けは生の JSON に当てて、エスケープは切り出したあとに行う。** 共有の `escapeHtml`
 * （`lib/text.ts`）は属性値のために `"` も `&#34;` にするので、エスケープ済みの文字列に
 * 文字列リテラルの規則を当てても 1 件も当たらないうえ、数値の規則が実体参照の中の `34` を
 * 拾ってタグを割り込ませる（`{"a":1}` が `&#<span class="json-number">34</span>;a…` になる）。
 */
function highlightJson(pretty: string): string {
  let html = ''
  let last = 0
  for (const m of pretty.matchAll(JSON_TOKEN)) {
    const [match, strVal, colon, boolVal, nullVal, numVal] = m
    html += escapeHtml(pretty.slice(last, m.index))
    last = m.index + match.length
    if (strVal) {
      const body = escapeHtml(strVal)
      if (colon) {
        html += `<span class="json-key">${body}</span>${colon}`
      } else {
        const cls = /\\[nr]/.test(strVal) ? 'json-string json-string-expandable' : 'json-string'
        html += `<span class="${cls}">${body}</span>`
      }
    } else if (boolVal) html += `<span class="json-bool">${boolVal}</span>`
    else if (nullVal) html += `<span class="json-null">${nullVal}</span>`
    else html += `<span class="json-number">${numVal}</span>`
  }
  return html + escapeHtml(pretty.slice(last))
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

/**
 * Whether the front matter block is expanded; null until the user decides. A plain
 * variable, not a ref: the preview HTML is rebuilt from scratch on every edit, so the
 * state has to survive outside the DOM, but making it reactive would rebuild the whole
 * preview (mermaid re-render and one IPC read per local image) on every disclosure click.
 */
let frontmatterOpen: boolean | null = null

/**
 * Front matter fools CommonMark: the opening `---` is a thematic break and the closing
 * one underlines it into a setext heading, so the whole block lands in the body as an
 * `<h2>`. Slice it off and render it as metadata instead.
 */
function buildMarkdownPreview(text: string): string {
  const block = detectFrontmatter(text)
  if (!block) return parserFor(text).parse(text) as string

  const parsed = parseFrontmatter(block)
  let cls = ''
  let body: string
  if (!parsed.ok) {
    const message = parsed.reason === 'not-mapping' ? t('frontmatter.notMapping') : parsed.message
    cls = ' frontmatter-invalid'
    body = `<div class="frontmatter-error">${escapeHtml(message)}</div><pre>${escapeHtml(block.raw.trim())}</pre>`
  } else if (parsed.entries.length === 0) {
    body = `<div class="frontmatter-empty">${escapeHtml(t('frontmatter.empty'))}</div>`
  } else {
    const rows = parsed.entries
      .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
      .join('')
    body = `<table><tbody>${rows}</tbody></table>`
  }
  // Collapsed by default, but a block we couldn't parse is worth showing unasked.
  const open = parsed.ok ? '' : ' open'
  // **rst の `.. meta::` も同じマークアップを出す**（#302。`lib/rstPreview.ts` の `metaBlock`）。
  // 下の `.md-preview :deep(.frontmatter > …)` は子結合子なので、ここの入れ子を変えると
  // あちらが黙って素の `<details>` に戻る。`trackFrontmatterToggle` も両方が使う。
  const label = `<summary>${escapeHtml(t('frontmatter.title'))}<span class="frontmatter-kind">${block.kind.toUpperCase()}</span></summary>`
  const meta = `<details class="frontmatter${cls}"${open}>${label}${body}</details>`
  const rest = text.slice(block.bodyFrom)
  return meta + (parserFor(rest).parse(rest) as string)
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
  // rst は SVG を出さない（mermaid も watcher で除外している）ので、`SVG_PURIFY_OPTS` の
  // 追加許可（`foreignObject` や SVG の属性）を持ち込まない。
  if (isRst.value) return DOMPurify.sanitize(buildRstPreview(text), { ALLOWED_URI_REGEXP })
  return DOMPurify.sanitize(buildMarkdownPreview(text), SVG_PURIFY_OPTS)
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
    // Insert mermaid's rendered SVG as-is (its documented usage). Mermaid runs
    // in 'antiscript' mode and sanitizes label text internally with DOMPurify;
    // running it through our SVG_PURIFY_OPTS here would strip the foreignObject
    // label contents and blank every label.
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
      if (pre?.tagName !== 'PRE') continue
      const source = block.textContent ?? ''
      try {
        const id = `md-mermaid-${props.tabId}-${idx++}-${Date.now()}`
        const { svg } = await mermaid.render(id, source.trim())
        const wrapper = document.createElement('div')
        wrapper.className = 'mermaid-inline'
        // Mermaid-generated SVG (label text already sanitized by mermaid in
        // 'antiscript' mode); insert as-is — our SVG sanitizer would blank the
        // foreignObject labels.
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
/**
 * Give every <img> in the preview a source the webview is allowed to load.
 *
 * Neither kind can be loaded from the markup itself: the webview cannot read a
 * disk-relative path, and the CSP blocks remote hosts. Both end up as `data:`
 * URLs — local files through the usual file IPC, remote ones (#239) only for
 * hosts the user approved, with a chip offering to approve the rest.
 */
async function resolveMarkdownImages() {
  await nextTick()
  const container = previewRef.value
  if (!container) return
  // A matching <source> outranks the <img> we resolve, and a remote srcset
  // outranks its own src, so neither can be left to win.
  for (const source of container.querySelectorAll('picture source')) source.remove()
  const tasks: Promise<void>[] = []
  for (const img of container.querySelectorAll('img')) {
    img.removeAttribute('srcset')
    const src = img.getAttribute('src')
    if (!src || src.startsWith('data:')) continue
    const host = imageHostOf(src)
    if (host) {
      tasks.push(resolveRemoteImage(img, src, host))
      continue
    }
    // http: is neither loadable nor offerable — leave it as the markup had it.
    if (/^https?:/i.test(src)) continue
    tasks.push(resolveLocalImage(img, src))
  }
  // Independent reads: a slow host must not hold up the images next to it.
  await Promise.all(tasks)
}

async function resolveLocalImage(img: HTMLImageElement, src: string) {
  const project = projectStore.currentProject
  if (!project || !tab.value) return
  // `img.png?v=2` and `img.png#top` name the same file: the suffix tells a
  // browser how to cache or where to scroll, and is no part of the path on disk.
  const resolved = resolveLocalPath(src.replace(/[?#].*$/, '')) // stays within the project root
  if (!resolved || !isEmbeddableImage(resolved)) return
  try {
    const base64 = await fsReadFileBase64(project.shell, resolved)
    img.src = `data:${mimeType(resolved)};base64,${base64}`
  } catch {
    // leave the image broken if it can't be read
  }
}

async function resolveRemoteImage(img: HTMLImageElement, url: string, host: string) {
  // This pass also re-runs on approval, so start from a clean slate: the chip
  // and the hiding are what the previous pass decided, not what the markup says.
  const stale = img.nextElementSibling
  if (stale?.classList.contains('external-image')) stale.remove()
  // Hidden until we know what to show: the src in the markup is the remote one,
  // which the CSP blocks — leaving it visible flashes a broken-image icon.
  img.hidden = true
  if (!settingsStore.allowedImageHosts.includes(host)) {
    showImageChip(img, host, url, t('preview.externalImageShow', { host }))
    return
  }
  const dataUrl = await remoteImageDataUrl(url)
  if (dataUrl) {
    img.src = dataUrl
    img.hidden = false
    return
  }
  // Fetch failed — say so on the chip, which retries when clicked.
  showImageChip(img, host, url, t('preview.externalImageFailed', { host }))
}

/**
 * Stand a button carrying the host where an image the preview will not load
 * would have been. The <img> keeps its original src (the CSP is what stops the
 * request) and is only hidden, so the next pass can resolve it in place.
 */
function showImageChip(img: HTMLImageElement, host: string, url: string, label: string) {
  img.hidden = true
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'external-image'
  btn.dataset.host = host
  btn.dataset.url = url
  btn.textContent = label
  btn.title = t('preview.externalImageHint')
  img.after(btn)
}

// Give preview headings GitHub-style ids so in-page `#anchor` links can scroll.
async function assignHeadingIds() {
  await nextTick()
  const container = previewRef.value
  if (!container) return
  const slug = createHeadingSlugger()
  for (const h of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    h.id = slug(h.textContent ?? '')
  }
}

/**
 * Restore the disclosure state and watch for changes. Re-run on every render: v-html
 * throws the previous element (and its listener) away.
 */
async function trackFrontmatterToggle() {
  await nextTick()
  const details = previewRef.value?.querySelector<HTMLDetailsElement>('details.frontmatter')
  if (!details) return
  if (frontmatterOpen !== null) details.open = frontmatterOpen
  details.addEventListener('toggle', () => {
    frontmatterOpen = details.open
  })
}

// Markdown mermaid / local images / heading ids: re-process after previewHtml is set
//
// **rst も画像と見出し id の処理を通す（#284）。** `.. image::` が出す `<img src="foo.png">` は
// この経路で `data:` URL にならないと、相対パスは webview から読めず、外部ホストは CSP に
// 弾かれて必ず壊れた画像になる。mermaid だけは Markdown 固有なので通さない。
//
// **折り畳みの追従も両方で要る（#302）。** rst の `.. meta::` は Markdown のフロントマターと
// 同じ `details.frontmatter` で出すので、通さないと打鍵のたびに開いた状態が閉じる。
watch(previewHtml, () => {
  if (isMarkdown.value) renderMarkdownMermaid()
  if (isProsePreview.value) {
    trackFrontmatterToggle()
    resolveMarkdownImages()
    assignHeadingIds()
  }
})

// An approval (or a language switch) changes what the images resolve to, but
// not the markup — re-run the pass instead of invalidating previewHtml, which
// would also re-render every mermaid diagram.
watch([() => settingsStore.allowedImageHosts, locale], () => {
  if (isProsePreview.value) resolveMarkdownImages()
})

// Switching view mode re-creates the preview pane at the top — hide the
// back-to-top button. (Not reset on every edit, so it stays put while typing.)
watch(viewMode, () => {
  previewScrolled.value = false
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
    fileType: langLabel,
    tabSize: settingsStore.editorTabSize,
    tabId: props.tabId,
  })
}

/** Shell config for file I/O. 判断の実体は `projectStore.shellForIO`（そこの doc を参照）。 */
const shellForIO = computed(() => projectStore.shellForIO)

async function save(overrideEncoding?: string, auto = false) {
  if (!editorView || !tab.value || saving.value || tab.value.readOnly) return

  // Untitled tab: prompt for file path first
  if (!tab.value.path) {
    let chosen: string | null
    if (shellForIO.value.kind === 'wsl') {
      const root = projectStore.activeRoot || '/'
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
    // **書いた内容を控えておく。** ディスクに載るのはこの時点の文書で、`await` の
    // あいだに打たれた文字は入っていない。完了後にライブの doc を読み直して
    // `savedContent` にすると、書き込み中の打鍵が「保存済み」に化けて `*` が消え、
    // その後の自動リロード（clean なタブが対象）で黙って消える。自動保存は打鍵が
    // 止まってから書くので、少し考えてから打ち直すという普通の操作で当たる。
    const written = editorView.state.doc.toString()
    let content = written
    if (currentLineEnding.value === 'CRLF') {
      content = content.replace(/\n/g, '\r\n')
    }
    markRecentlySaved(tab.value.path)
    await fsWriteFile(shellForIO.value, tab.value.path, content, enc !== 'UTF-8' ? enc : undefined)
    if (overrideEncoding) {
      currentEncoding.value = enc
      updateCursorInfo()
    }
    savedContent = written
    autoSaveFailed = false
    tab.value.isNewFile = false
    updateDirtyState()
    updateTitle()
    refreshDiffGutter()
    diagStore.triggerAutoRun()
  } catch (e) {
    // **自動保存の失敗で本文を隠さない。** `error` が立つとエディタ本体が `v-show` で
    // 消え、画面に残るのは「破棄して読み直す」ボタンだけになる。人が `Ctrl+S` を押した
    // 結果ならその画面でよいが、WSL が落ちた等で**何も操作していないのに**そうなるのは、
    // 未保存の内容を捨てる操作しか残らないという最悪の形になる。自動保存では StatusBar に
    // 出すだけにして、次の契機で普通に再試行する。
    if (!auto) {
      error.value = String(e)
    } else if (!autoSaveFailed) {
      autoSaveFailed = true
      statusMessageStore.show({ text: t('editor.autoSaveFailed', { error: String(e) }), variant: 'error' })
    }
  } finally {
    saving.value = false
  }
}

/** 自動保存が失敗している最中か。同じ失敗を契機のたびに通知しないための記憶。 */
let autoSaveFailed = false

/**
 * 自動保存の入口（#262）。**保存の主体は人のまま**で、これは `Ctrl+S` の押し忘れを
 * 代行するだけ、というのが #276 で決めた原則。したがって
 *
 * - **書くのは `save()` を呼ぶことだけ**。別経路を作らない（CRLF 変換・エンコード・
 *   `markRecentlySaved`・ガター更新・診断の trigger が 1 箇所に残る）
 * - **止める条件はここに書く。`save()` の中には書かない。** あちらは人が押したときの
 *   経路で、下の理由のどれにも従わない（外部変更の警告バーの「上書き」がまさにそれ）
 *
 * 止めるのは 4 つ。
 *
 * 1. **無題タブ** … `save()` は保存先を聞くので、勝手にダイアログが開く
 * 2. **読み取り専用** … `git show` のスナップショット
 * 3. **外部変更の警告中** … 人が Reload / Overwrite を選ぶまで待つ。ここで書くと、
 *    エージェントや別のエディタが加えた変更を黙って潰す
 * 4. **コンフリクトのマーカーが残っている** … 解消の中間状態を勝手に残さない
 */
function maybeAutoSave() {
  if (settingsStore.autoSave === 'off') return
  if (!isDirty.value || saving.value) return
  if (!tab.value?.path || tab.value.readOnly) return
  if (externalChangeNotice.value) return
  if (editorView && hasConflictMarkers(editorView.state)) return
  // 見えていないタブ（別プロジェクトのぶんを保持している、#264）では書かない。
  // `shellForIO` は**今表示しているプロジェクト**のシェルを返すので、切り替えたあとに
  // 待っていたタイマーが発火すると、WSL のパスを PowerShell で書きに行く。人が押す
  // `Ctrl+S` は見えているタブにしか届かないため、この不変条件は自動保存で初めて壊れる。
  if (!tabStore.visibleTabs.some((t) => t.id === props.tabId)) return
  // 人に何かを聞いているあいだは黙って書かない。とくに「未保存の変更を破棄しますか」は
  // 答えを待つあいだコンポーネントが生きているので、そのまま撃つと破棄したはずの内容が
  // ディスクに残る。
  if (dialogOpen()) return
  void save(undefined, true)
}

/** `afterDelay` のタイマー。打鍵のたびに張り直す。 */
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  if (settingsStore.autoSave !== 'afterDelay') return
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null
    maybeAutoSave()
  }, settingsStore.autoSaveDelay)
}

/**
 * Report why the file could not be loaded. A directory fails the same read as an
 * unreadable file, so the reason is checked here and turned into the "open this
 * directory" actions instead of a raw error string — clicking a path in terminal
 * output lands here whenever that path is a directory.
 */
async function reportLoadError(e: unknown, seq: number) {
  error.value = String(e)
  isDirectory.value = false
  const path = tab.value?.path
  if (!path) return
  const dirs = await fsDirsExist(shellForIO.value, [path]).catch(() => [false])
  // A reload started while the probe was in flight owns the state now
  if (seq !== loadSeq) return
  isDirectory.value = dirs[0] === true
}

/** Open the directory this tab points at, then drop the tab: it only ever
 *  existed to report that the path is not a file. A switch kills it anyway. */
async function openDirectoryTab(as: 'directory' | 'project') {
  const path = tab.value?.path
  if (!path) return
  const mode = openInNewWindow.value ? 'window' : 'switch'
  if (as === 'project') {
    await projectStore.openDirectoryAsProject(path, mode)
  } else {
    // ここは「ディレクトリを開く」と「プロジェクトとして開く」を並べて選ばせた直後なので、
    // 登録するかを聞き直さない（#286）。
    await projectStore.openDirectory(path, mode, { alreadyChose: true })
  }
  if (mode === 'window') await tabStore.closeTab(props.tabId)
}

async function loadContent(encoding?: string): Promise<string> {
  if (!tab.value) throw new Error('No tab')

  if (tab.value.initialContent !== undefined) {
    savedContent = tab.value.initialContent
    currentEncoding.value = 'UTF-8'
    currentLineEnding.value = tab.value.initialContent.includes('\r\n') ? 'CRLF' : 'LF'
    return savedContent
  }

  // allowMissing: a nonexistent path opens as a blank new file (vim-like);
  // the first Ctrl+S creates it. The tab shows a "new" badge until then.
  const result = await fsReadFile(shellForIO.value, tab.value.path, encoding, { allowMissing: true })
  tab.value.isNewFile = result.isNew
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
    const diff = await gitDiffLines(projectStore.activeRoot, project.shell, tab.value.path)
    editorView?.dispatch({ effects: setDiffLines.of(diff) })
  } catch {
    // Not a git repo or file not tracked — ignore
  }
}

// --- Diagnostics squiggles ---
// Push the subset of store diagnostics that belong to this file into the editor.
let lastDiagCount = 0
function refreshDiagnosticsLayer() {
  if (!editorView || !tab.value?.path) return
  const list: EditorDiagnostic[] = diagStore.forFile(tab.value.path).map((d) => ({
    line: d.line,
    column: d.column,
    endLine: d.endLine ?? undefined,
    endColumn: d.endColumn ?? undefined,
    severity: d.severity,
    message: d.message,
    source: d.source,
    code: d.code ?? undefined,
  }))
  // Most open files have no diagnostics — skip the no-op transaction when this
  // file was already clean (avoids an empty dispatch per tab on every re-check).
  if (list.length === 0 && lastDiagCount === 0) return
  lastDiagCount = list.length
  editorView.dispatch({ effects: setDiagnostics.of(list) })
}

watch(
  () => diagStore.diagnostics,
  () => refreshDiagnosticsLayer(),
)

// --- Context menu ---
const ctxMenu = ref(false)
const {
  style: ctxMenuStyle,
  placeAt: placeCtxMenu,
  reset: resetCtxMenu,
} = useAnchoredPopup(useTemplateRef<HTMLElement>('ctxMenuEl'))
const ctxLineRange = ref<{ start: number; end: number } | null>(null)

async function onEditorContextMenu(e: MouseEvent) {
  e.preventDefault()
  ctxHasSelection.value = editorView ? !editorView.state.selection.main.empty : false
  ctxLineRange.value = computeContextLineRange(e)
  resetCtxMenu()
  ctxMenu.value = true
  // Measured, then clamped (#204): a right-click low in the editor used to open
  // a menu whose bottom entries were off-screen.
  await placeCtxMenu({ x: e.clientX, y: e.clientY })
  window.addEventListener('mousedown', closeCtxMenu, { once: true })
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
  ctxMenu.value = false
  resetCtxMenu()
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

// Send the current selection to a terminal as a `relpath:lines` reference plus
// the selected text, so the user can ask their agent about that exact code.
function sendSelectionToTerminal() {
  closeCtxMenu()
  if (!editorView || !tab.value) return
  const sel = editorView.state.selection.main
  if (sel.empty) return
  const text = editorView.state.doc.sliceString(sel.from, sel.to)
  const start = editorView.state.doc.lineAt(sel.from).number
  const end = editorView.state.doc.lineAt(sel.to).number
  const rel = toRelativePath(tab.value.path, projectStore.activeRoot)
  const loc = start === end ? `${rel}:${start}` : `${rel}:${start}-${end}`
  injectToTerminal(`${loc}\n${text}`)
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

/**
 * このタブだけの折り返し。null は「設定に従う」。
 *
 * **タブ単位にしてあるのは分割表示のため**（#241）。エディタ側が半分の幅になるので、
 * その文書だけ折り返したいことがある。タブのコンポーネントは `v-show` で生き続けるので、
 * 切り替えて戻っても保たれる（`viewMode` と同じ寿命で、セッションには残さない）。
 *
 * 一度触ったタブは、以後この値のまま。設定を変えても追従しないが、ボタンがその場に
 * あるので戻すのは 1 クリックで済む。
 */
const wordWrapOverride = ref<boolean | null>(null)
const wordWrapOn = computed(() => wordWrapOverride.value ?? settingsStore.editorWordWrap)

/** ミニマップも同じ形でタブ単位に上書きできる（#282）。折り返しの隣にボタンを置くので、
 *  片方だけ設定を直に触る作りにすると、並んだ 2 つで効き方が変わる。 */
const minimapOverride = ref<boolean | null>(null)
const minimapOn = computed(() => minimapOverride.value ?? settingsStore.editorMinimap)

/**
 * 実ファイルのタブか。diff ガター・診断・ミニマップ・定義ジャンプはこれが真のときだけ入る
 * （`git show` のスナップショットは `initialContent` を持ち、ディスク上の状態と結び付かない）。
 * **ミニマップのボタンもこれで出し分ける**: 拡張が入っていないタブに出すと、押しても何も
 * 起きないボタンが点いたままになる。
 */
const hasFile = computed(() => !!tab.value && !tab.value.initialContent)

const markdownLinkPaste = useMarkdownLinkPaste()

/** Is this a file to write Markdown into? Gates the toolbar and its shortcuts
 *  together — one without the other is a half-feature. Read-only tabs (a
 *  `git show` snapshot) get neither. */
const markdownAssistOn = computed(() => isMarkdown.value && !isReadOnlyTab.value)

/** The Markdown assist bindings, or nothing when they do not apply here. */
function markdownAssist() {
  if (!markdownAssistOn.value) return []
  return [
    keymap.of(markdownAssistKeymap(() => runMarkdownToolbarAction({ kind: 'link' }))),
    // 差し替え位置の追跡もここに置く。基本の拡張リストに入れると、Markdown でないタブや
    // 読み取り専用タブ — pending が入りようのないタブ — でも打鍵のたびに update が走る。
    markdownLinkPaste.extension,
    EditorView.domEventHandlers({
      ...markdownImages.handlers,
      // 画像が先。ファイルを伴う貼り付けはあちらの担当で、URL の判定まで行かせない。
      // どちらも「受け持たなければ false」の規約なので、そのまま繋げられる。
      paste: (event, view) =>
        markdownImages.handlers.paste(event, view) || markdownLinkPaste.handlers.paste(event, view),
    }),
  ]
}

/**
 * Run a toolbar button or shortcut against the editor.
 *
 * Link is the one action that has to look outside the document first: a URL
 * sitting on the clipboard is nearly always the target the author meant, and
 * pre-filling it saves the paste.
 */
async function runMarkdownToolbarAction(action: ToolbarAction) {
  if (!editorView) return
  if (action.kind === 'pickImage') {
    await markdownImages.insertFromPicker(editorView)
    return
  }
  const resolved: MarkdownAction = action.kind === 'link' ? { kind: 'link', url: await clipboardUrl() } : action
  runMarkdownAction(editorView, resolved)
}

/** The clipboard's contents when they are a URL, else undefined. */
async function clipboardUrl(): Promise<string | undefined> {
  try {
    const text = (await navigator.clipboard.readText()).trim()
    // 貼り付け側（`useMarkdownLinkPaste`）と同じ述語を通す。許容する文字が食い違うと、
    // ツールバーの「リンク」と貼り付けで通る URL が割れる。
    return isHttpUrl(text) && !/\s/.test(text) ? text : undefined
  } catch {
    // No clipboard permission (or nothing textual on it) — insert an empty target.
    return undefined
  }
}

// Images are a feature of their own — see the composable for where they land.
const markdownImages = useMarkdownImages(
  computed(() => (tab.value?.path ? dirname(tab.value.path) : '')),
  shellForIO,
  computed(() => projectStore.activeRoot),
)

// Snapshot selection state when context menu opens (not reactive — avoids stale computed)
const ctxHasSelection = ref(false)

/**
 * StatusBar に出すファイル種別（#312）。**判定の入力ではなく結果を控える。**
 *
 * ハイライトを決めるのは開いたときと Save As の 2 回だけなので、種別も同じ機会に決めた値を
 * 使わないと 2 つが食い違う。`updateCursorInfo` は打鍵のたびに走るため、そこでライブの
 * 1 行目から引き直すと、拡張子の無いファイルに `#!/bin/bash` を書き足したときに**種別だけ
 * 即座に Shell になり、本文はプレーンのまま**になる。
 *
 * **1 行目のほうを控える形にしない**こと: それだと「ライブの値を渡すな」という警告を
 * コメントで支え続けることになる。結果を持てば、渡せる入力が存在しないので誤用が書けない。
 */
let langLabel = 'Plain Text'

/** 言語と種別を、いま与えられた 1 行目から決め直す。**この 2 つは必ず一緒に更新する。** */
function resolveLanguage(path: string | undefined, firstLine: string): ReturnType<typeof getLanguage> {
  langLabel = getLanguageLabel(path ?? '', firstLine)
  return path ? getLanguage(path, firstLine) : null
}

function createEditorView(container: HTMLElement, content: string) {
  const isReadOnly = tab.value?.readOnly ?? false
  const lang = resolveLanguage(tab.value?.path, firstLineOf(content))
  const extensions = [
    themeCompartment.of(getEditorTheme(settingsStore.effectiveEditorThemeName).extension),
    backdropCompartment.of(backdropTheme()),
    lineNumbers(),
    highlightActiveLine(),
    history(),
    editorSearch(),
    highlightSelectionMatches(),
    conflictCompartment.of(conflictHighlight()),
    markdownCompartment.of(markdownAssist()),
    tabSizeCompartment.of(EditorState.tabSize.of(settingsStore.editorTabSize)),
    indentUnitCompartment.of(indentUnit.of(' '.repeat(settingsStore.editorTabSize))),
    wordWrapCompartment.of(wordWrapOn.value ? EditorView.lineWrapping : []),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        updateDirtyState()
        bumpDocVersion()
        outlineSource.bumpVersion(props.tabId)
        scheduleAutoSave()
      }
      // **タブ切替でも発火する**（`v-show` の `display: none` はフォーカスを外す）ので、
      // `activeTabId` を別に見る必要はない。
      if (update.focusChanged && !update.view.hasFocus && settingsStore.autoSave === 'onFocusChange') {
        maybeAutoSave()
      }
      if (update.selectionSet || update.docChanged) {
        updateCursorInfo()
        outlineSource.updateCaret(props.tabId, update.state.selection.main.head)
      }
    }),
    fontCompartment.of(fontTheme()),
    EditorView.theme({
      '&': { height: '100%' },
      '.cm-searchMatch': {
        backgroundColor: 'rgba(255, 213, 0, 0.25)',
      },
      '.cm-searchMatch-selected': {
        backgroundColor: 'rgba(255, 213, 0, 0.5)',
      },
    }),
  ]

  // Git diff gutter + diagnostics squiggles + minimap (only for real files)
  if (hasFile.value) {
    extensions.push(gitDiffGutter())
    extensions.push(diagnosticsExtension())
    extensions.push(minimapCompartment.of(minimapOn.value ? minimap() : []))
  }

  // Go-to-definition (only for real files; previews / readonly snapshots skipped)
  if (hasFile.value) {
    extensions.push(
      jumpToDefinitionExtension({
        getContext: () => {
          const t = tab.value
          const project = projectStore.currentProject
          if (!t?.path || !project) return null
          return {
            filePath: t.path,
            projectRoot: projectStore.activeRoot,
            shell: project.shell,
            langId: extension(t.path),
          }
        },
        onJump: (target) => {
          tabStore.addEditorTab({ path: target.path, initialLine: target.line })
        },
        onStatus: (status) => {
          if (status.kind === 'searching') {
            statusMessageStore.show({ text: t('jumpTo.searching'), variant: 'loading' })
          } else if (status.kind === 'opened') {
            statusMessageStore.show({
              text: t('jumpTo.opened', { name: basename(status.target.path) }),
              variant: 'success',
              durationMs: 2500,
            })
          } else {
            statusMessageStore.show({ text: t('jumpTo.notFound'), variant: 'warn', durationMs: 2500 })
          }
        },
      }),
    )
  }

  if (!isReadOnly) {
    extensions.push(
      // プリセットで変わるキー（#261）。**`defaultKeymap` より前に置くこと**: IDEA 互換の
      // タブ移動 `Alt+←→` を CodeMirror の既定（`cursorSyntaxLeft/Right`）から奪い返す
      // 空のコマンドが入っている。
      presetKeymapCompartment.of(presetKeymap()),
      keymap.of([
        ...searchKeymap,
        // CodeMirror's own redo is `Mod-y` plus a Linux-only `Ctrl-Shift-z`, so
        // on Windows the Ctrl+Shift+Z every shortcut list here advertises did
        // nothing. Both work now.
        { key: 'Mod-Shift-z', run: redo, preventDefault: true },
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
    // No `presetKeymap` here on purpose: search is useful in a read-only view,
    // replace has nothing to write to.
    extensions.push(keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]))
  }
  extensions.push(languageCompartment.of(lang ?? []))

  return new EditorView({
    state: EditorState.create({ doc: content, extensions }),
    parent: container,
  })
}

// Monotonic token so overlapping loads (mount / auto-reload / manual reload)
// don't each append an EditorView into the same container — only the latest wins.
let loadSeq = 0

async function reopenWithEncoding(encoding: string) {
  if (!editorRef.value || !tab.value) return
  const seq = ++loadSeq
  loading.value = true
  try {
    editorView?.destroy()
    editorView = null
    const content = await loadContent(encoding)
    if (seq !== loadSeq || !editorRef.value) return
    loading.value = false
    error.value = null
    isDirectory.value = false
    editorView = createEditorView(editorRef.value, content)
    if (viewMode.value === 'split') {
      editorView.scrollDOM.addEventListener('scroll', onEditorScroll)
    }
    isDirty.value = false
    updateTitle()
    updateCursorInfo()
    refreshDiffGutter()
    refreshDiagnosticsLayer()
    // previewHtml reads the (non-reactive) editorView — force a recompute so
    // the preview pane reflects the reloaded document.
    bumpDocVersion()
    if (tabStore.activeTabId === props.tabId) {
      registerOutlineSource()
    }
  } catch (e) {
    if (seq !== loadSeq) return
    loading.value = false
    await reportLoadError(e, seq)
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

  const seq = ++loadSeq
  try {
    const content = await loadContent()
    if (!editorRef.value) return
    loading.value = false
    if (seq === loadSeq) {
      editorView = createEditorView(editorRef.value, content)
    }
    // Open in the requested view mode (e.g. 'preview' from a Markdown link). Set
    // it after the editor exists so the preview computes its content right away.
    // One-shot: consume it so it isn't persisted / re-forced on session restore.
    if (tab.value?.initialViewMode) {
      if (hasPreview.value) viewMode.value = tab.value.initialViewMode
      tab.value.initialViewMode = undefined
    }
    jumpToLine(tab.value?.initialLine)
    updateCursorInfo()
    refreshDiffGutter()
    refreshDiagnosticsLayer()

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
    await reportLoadError(e, seq)
  }
})

/** Swallow the scroll event a programmatic scroll is about to fire, so the
 *  split-mode sync doesn't mirror it back onto the other pane. Call before the
 *  scroll assignment. */
function suppressSyncFrame() {
  syncingScroll = true
  requestAnimationFrame(() => {
    syncingScroll = false
  })
}

// Scroll sync
function onEditorScroll() {
  if (syncingScroll || viewMode.value !== 'split' || !previewRef.value || !editorView) return
  const scroller = editorView.scrollDOM
  const ratio = scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight || 1)
  suppressSyncFrame()
  previewRef.value.scrollTop = ratio * (previewRef.value.scrollHeight - previewRef.value.clientHeight)
}

function onPreviewScroll() {
  // Toggle the floating "back to top" button (works in preview-only mode too,
  // before the split-only scroll-sync early-return below).
  if (previewRef.value) previewScrolled.value = previewRef.value.scrollTop > BACK_TO_TOP_THRESHOLD
  if (syncingScroll || viewMode.value !== 'split' || !previewRef.value || !editorView) return
  const preview = previewRef.value
  const ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight || 1)
  suppressSyncFrame()
  const scroller = editorView.scrollDOM
  scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight)
}

/** Scroll behaviour for in-preview navigation (anchors, back-to-top). */
function previewScrollBehavior(): ScrollBehavior {
  return settingsStore.previewSmoothScroll ? 'smooth' : 'auto'
}

/** Scroll the preview to a heading/anchor id. Returns whether it was found. */
function scrollPreviewToAnchor(id: string): boolean {
  const el = previewRef.value?.querySelector(`#${CSS.escape(id)}`)
  if (!el) return false
  el.scrollIntoView({ behavior: previewScrollBehavior(), block: 'start' })
  return true
}

function scrollPreviewToTop() {
  previewRef.value?.scrollTo({ top: 0, behavior: previewScrollBehavior() })
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

  const root = projectStore.activeRoot
  const sep = pathSep(project.shell)

  // Determine the directory containing the current file. A leading slash is
  // repo-relative in Markdown (the way GitHub and VS Code read it) rather than
  // a filesystem path, so resolving it against the file's own directory sent
  // those images somewhere nothing lives.
  const filePath = tab.value.path
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const dir = href.startsWith('/') ? root : lastSep > 0 ? filePath.slice(0, lastSep) : root

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

  // Security: ensure the resolved path is within the project root.
  //
  // **判定は `relativeToBase` に任せる**（区切りの正規化・末尾スラッシュ・Windows での
  // 大小折り畳みを持っている）。ここへ書き写していたころは、プレビュー画像の内外判定
  // （`useMarkdownImages` の `isOurs`）と別実装になっていて、`unix` を足したときに
  // 両方へ別々に同じ手を入れる必要があった。
  //
  // `relativeToBase` は base 自身に対して null を返すので、末尾に 1 セグメント足して
  // 聞く。root 自身も root の配下も真になり、外は偽のままになる。
  const probe = `${fullPath}/probe`
  if (relativeToBase(root, probe, shellToPlatform(project.shell)) === null) {
    return null
  }

  return fullPath
}

async function onPreviewClick(e: MouseEvent) {
  // Approve a host for external images (#239). The chips are rebuilt on every
  // render, so the listener lives here rather than on each button.
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.external-image')
  if (chip) {
    e.preventDefault()
    const host = chip.dataset.host
    if (!host) return
    // Already approved → the chip is a failed fetch; clicking it tries again.
    if (settingsStore.allowedImageHosts.includes(host)) {
      retryRemoteImage(chip.dataset.url ?? '')
      resolveMarkdownImages()
      return
    }
    if (await confirmDialog(t('confirm.allowImageHost', { host }))) {
      settingsStore.allowImageHost(host)
    }
    return
  }

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

  if (isExternalLink(href)) {
    await openUrlWithConfirm(href)
    return
  }

  // In-page anchor → scroll the preview to the matching heading id.
  if (href.startsWith('#')) {
    // Tolerate malformed `%` sequences (decodeURIComponent would throw).
    let id = href.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      /* use the raw value */
    }
    if (id) scrollPreviewToAnchor(id)
    return
  }

  // Local file link → resolve and open in editor
  const resolved = resolveLocalPath(href)
  if (resolved) {
    // Markdown → Markdown: keep the reader in the same preview/split mode.
    tabStore.addEditorTab({
      path: resolved,
      initialViewMode: isMarkdownPath(resolved) && viewMode.value !== 'edit' ? viewMode.value : undefined,
    })
  }
}

// Jump to line when initialLine changes on an existing tab
watch(
  () => tab.value?.initialLine,
  (lineNum) => {
    if (lineNum) jumpToLine(lineNum)
  },
)

// Outline click also scrolls a visible preview (#177). The panel already
// scrolled the editor via the shared EditorView; anchor the preview to the
// heading slug for Markdown, otherwise fall back to a source-line ratio.
watch(
  () => outlineSource.jumpRequest.value,
  (req) => {
    if (!req || req.tabId !== props.tabId || !showPreview.value) return
    scrollPreviewToJump(req)
  },
)

function scrollPreviewToJump(req: OutlineJump) {
  const preview = previewRef.value
  if (!preview || !editorView) return
  // Hold the split-mode sync guard across this frame so the editor's own
  // scrollIntoView (dispatched by the panel) doesn't overwrite our position.
  suppressSyncFrame()
  // Markdown headings anchor precisely; otherwise scroll by source-line ratio.
  if (isMarkdown.value && req.slug && scrollPreviewToAnchor(req.slug)) return
  const ratio = (req.line - 1) / Math.max(1, editorView.state.doc.lines - 1)
  preview.scrollTo({ top: ratio * (preview.scrollHeight - preview.clientHeight), behavior: previewScrollBehavior() })
}

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
      // A modify after a (transient) delete means the file is back — drop the notice.
      externalChangeNotice.value = null
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

/** Reload the file from disk (header button). Confirms before discarding unsaved edits. */
async function reloadFromDisk() {
  if (isDirty.value && !(await confirmDialog(t('editor.reloadDiscardConfirm')))) return
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
  (id, prev) => {
    if (id === props.tabId && editorView) {
      editorView.requestMeasure()
      updateCursorInfo()
      editorInfo.registerCallbacks(
        (enc) => reopenWithEncoding(enc),
        (le) => changeLineEnding(le),
      )
      registerOutlineSource()
    } else if (prev === props.tabId) {
      // **降りるのは自分がアクティブでなくなったときだけ。** この watcher は開いている
      // エディタタブ全部で走るので、`id !== props.tabId`（＝自分ではない）で消すと、
      // 無関係なタブまで StatusBar を空にする。しかも watcher が走る順はタブのマウント順
      // なので、**先に開いたタブへ戻ると、新しくアクティブになった側が update した後に
      // 別のタブが clear する**（カーソルを動かすまで種別も行番号も出ない、という形で出る）。
      editorInfo.clear()
      outlineSource.clear(props.tabId)
    }
  },
)

// The conflict buttons' labels are baked into DOM when it is built, so switching
// the UI language has to rebuild that extension (#223).
watch(locale, () => {
  if (!editorView) return
  editorView.dispatch({ effects: conflictCompartment.reconfigure(conflictHighlight()) })
})

// Live-apply editor settings changes
watch(
  () => settingsStore.effectiveEditorThemeName,
  (name) => {
    if (!editorView) return
    editorView.dispatch({ effects: themeCompartment.reconfigure(getEditorTheme(name).extension) })
  },
)

// Window transparency (issue #162): re-apply the transparent-background override
// when the backdrop mode toggles.
watch(
  () => settingsStore.windowBackdrop,
  () => {
    if (!editorView) return
    editorView.dispatch({ effects: backdropCompartment.reconfigure(backdropTheme()) })
  },
)

watch(minimapOn, (on) => {
  if (!editorView) return
  editorView.dispatch({ effects: minimapCompartment.reconfigure(on ? minimap() : []) })
})

watch(wordWrapOn, (on) => {
  if (!editorView) return
  editorView.dispatch({ effects: wordWrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) })
})

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

// キーのプリセット（#261）を変えたら、開いているタブのキーも張り直す。
watch(
  () => settingsStore.shortcutPreset,
  () => {
    editorView?.dispatch({ effects: presetKeymapCompartment.reconfigure(presetKeymap()) })
  },
)

// Save As names an untitled buffer, which is what decides its language: without
// this the buffer stays plain text after saving as `notes.md` — no highlighting
// and, for Markdown, none of the language's own Enter/paste handling either.
watch(
  () => tab.value?.path,
  (path) => {
    const lang = resolveLanguage(path, editorView ? firstLineOf(editorView.state.doc.line(1).text) : '')
    editorView?.dispatch({
      effects: [languageCompartment.reconfigure(lang ?? []), markdownCompartment.reconfigure(markdownAssist())],
    })
    // 種別の表示も同じスナップショットで更新する（次の打鍵まで古い値が残らないように）。
    updateCursorInfo()
    // The outline panel was handed this tab's path when the view was built, and
    // the tab is already active, so nothing else will hand it the new one.
    if (tabStore.activeTabId === props.tabId) registerOutlineSource()
  },
)

// The editor has its own font family / size — apply changes live.
watch(
  () => [settingsStore.editorFontName, settingsStore.editorFontSize],
  () => {
    if (!editorView) return
    editorView.dispatch({ effects: fontCompartment.reconfigure(fontTheme()) })
  },
)

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeyDown)
  if (docVersionTimer) clearTimeout(docVersionTimer)
  // 待っていた自動保存はここで捨てる。閉じるときに未保存なら、これまでどおり確認
  // ダイアログが先に出ている（保存の主体は人、という原則のまま）。
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
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
      <MarkdownToolbar v-if="markdownAssistOn && showEditor" @run="runMarkdownToolbarAction" />
      <span class="toolbar-spacer" />
      <WrapToggle :on="wordWrapOn" @toggle="wordWrapOverride = !wordWrapOn" />
      <MinimapToggle v-if="hasFile" :on="minimapOn" @toggle="minimapOverride = !minimapOn" />
      <HelpButton page="editor-and-preview.md" :size="15" />
    </div>
    <!-- Plain editor header: breadcrumb + reload + help -->
    <!-- パスの有無で出し分けない: 無題バッファにも折り返しの切り替えが要る
         （マニュアルは「タブごとに切り替えられる」と書いている）。パンくずだけを
         パスのあるときに出す。 -->
    <div v-if="!hasPreview && !loading && !error" class="editor-header">
      <div v-if="tab?.path" class="breadcrumb">
        <template v-for="(seg, i) in breadcrumbSegments" :key="i">
          <span v-if="i > 0" class="crumb-sep">›</span>
          <span class="crumb" :class="{ leaf: i === breadcrumbSegments.length - 1 }">{{ seg }}</span>
        </template>
      </div>
      <div class="editor-header-actions">
        <WrapToggle :on="wordWrapOn" @toggle="wordWrapOverride = !wordWrapOn" />
        <MinimapToggle v-if="hasFile" :on="minimapOn" @toggle="minimapOverride = !minimapOn" />
        <!-- Readonly snapshots (git show) carry initialContent — reloading from disk is meaningless there -->
        <button
          v-if="!tab?.readOnly && tab?.initialContent === undefined"
          class="header-icon-btn"
          :title="t('editor.reloadFromDisk')"
          @click="reloadFromDisk"
        >
          <RefreshCw :size="14" :stroke-width="2" />
        </button>
        <HelpButton page="editor-and-preview.md" :size="15" />
      </div>
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
    <!-- ディレクトリはエディタでは開けないので、開き方を選ばせる -->
    <div v-else-if="isDirectory" class="editor-status directory">
      <div class="dir-path">{{ tab?.path }}</div>
      <div class="dir-note">
        {{
          directoryProject
            ? t('editor.dirRegistered', { name: directoryProject.name })
            : t('editor.dirUnregistered')
        }}
      </div>
      <div class="dir-actions">
        <button v-if="!directoryProject" @click="openDirectoryTab('directory')">
          {{ t('editor.dirOpenDirectory') }}
        </button>
        <button class="dir-primary" @click="openDirectoryTab('project')">
          {{ directoryProject ? t('editor.dirOpenProject') : t('editor.dirOpenAsProject') }}
        </button>
      </div>
      <label class="dir-window">
        <input v-model="openInNewWindow" type="checkbox" />
        {{ t('editor.dirNewWindow') }}
      </label>
    </div>
    <div v-else-if="error" class="editor-status error">
      <span>{{ error }}</span>
      <button v-if="tab?.path && tab?.initialContent === undefined" class="error-retry" @click="reloadFromDisk">
        {{ t('editor.reload') }}
      </button>
    </div>
    <div class="editor-body" :class="{ split: viewMode === 'split' }" v-show="!loading && !error && !isDirectory">
      <div v-show="showEditor" ref="editorRef" class="editor-container" @contextmenu.prevent="onEditorContextMenu"></div>
      <div
        v-if="showPreview && !isMermaid"
        ref="previewRef"
        class="preview-pane"
        :class="{
          // rst にも `md-preview` を当てる（#284）。見出し・段落・リスト・コード・表の
          // 見た目は同じでよく、rst 固有の要素だけを `rst-preview` 側で足す。
          'md-preview': isProsePreview,
          'rst-preview': isRst,
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
      <button
        v-if="showPreview && !isMermaid && previewScrolled"
        class="back-to-top"
        :title="t('editor.backToTop')"
        @click="scrollPreviewToTop"
      >
        <ArrowUp :size="18" :stroke-width="2" />
      </button>
    </div>
    <div v-if="saving" class="save-indicator popup-surface">{{ t('editor.saving') }}</div>

    <!-- Context Menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        ref="ctxMenuEl"
        class="editor-ctx-menu popup-surface"
        :style="ctxMenuStyle"
        @mousedown.stop
      >
        <button @click="execUndo" :disabled="isReadOnlyTab"><span>{{ t('editor.undo') }}</span><span class="ctx-key">{{ chordLabel('Mod+Z') }}</span></button>
        <button @click="execRedo" :disabled="isReadOnlyTab"><span>{{ t('editor.redo') }}</span><span class="ctx-key">{{ chordLabel('Mod+Shift+Z') }}</span></button>
        <div class="ctx-separator"></div>
        <button @click="execCut" :disabled="isReadOnlyTab || !ctxHasSelection"><span>{{ t('editor.cut') }}</span><span class="ctx-key">{{ chordLabel('Mod+X') }}</span></button>
        <button @click="execCopy" :disabled="!ctxHasSelection"><span>{{ t('editor.copy') }}</span><span class="ctx-key">{{ chordLabel('Mod+C') }}</span></button>
        <button @click="execPaste" :disabled="isReadOnlyTab"><span>{{ t('editor.paste') }}</span><span class="ctx-key">{{ chordLabel('Mod+V') }}</span></button>
        <div class="ctx-separator"></div>
        <button @click="sendSelectionToTerminal" :disabled="!ctxHasSelection"><span>{{ t('editor.sendToTerminal') }}</span></button>
        <div class="ctx-separator"></div>
        <button @click="openGitHistory"><span>{{ t('editor.gitHistory') }}</span><span class="ctx-key">{{ chordLabel('Alt+H') }}</span></button>
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
          class="json-string-popup popup-surface"
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
  align-items: center;
  gap: 1px;
  padding: 4px 8px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.editor-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 6px 3px 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.breadcrumb {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  overflow: hidden;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-secondary);
}

.crumb {
  overflow: hidden;
  text-overflow: ellipsis;
}

.crumb.leaf {
  color: var(--text-primary);
  flex-shrink: 0;
}

.crumb-sep {
  margin: 0 4px;
  color: var(--text-secondary);
  opacity: 0.6;
  flex-shrink: 0;
}

.editor-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.header-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
}

.header-icon-btn:hover {
  color: var(--text-active);
  background: var(--tab-hover-bg);
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
  position: relative;
}

/* Floating "back to top" button, shown over the bottom-right of the preview. */
.back-to-top {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0.75;
  box-shadow: 0 2px 8px var(--shadow-color);
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}

.back-to-top:hover {
  opacity: 1;
  color: var(--text-active);
  background: var(--accent);
  border-color: var(--accent);
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

/* Footnotes (#241). The definitions render where they are written, so the rule
   above the first one is what separates them from the body text; the `:not()`
   picks the one that does not follow another footnote. */
.md-preview :deep(.footnote-ref) { font-size: 0.75em; }
.md-preview :deep(.footnote) {
  font-size: 0.9em;
  color: var(--text-secondary);
  margin: 2px 0;
}
.md-preview :deep(.footnote:not(.footnote + .footnote)) {
  margin-top: 16px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.md-preview :deep(.footnote-num) { color: var(--text-primary); }
.md-preview :deep(.footnote-back) { text-decoration: none; }

.md-preview :deep(table) { border-collapse: collapse; width: 100%; }
.md-preview :deep(th),
.md-preview :deep(td) { border: 1px solid var(--border); padding: 6px 12px; text-align: left; }
.md-preview :deep(th) { background: var(--bg-tertiary); }

.md-preview :deep(img) { max-width: 100%; }

/* rst 固有の要素（#284）。見出しや表は Markdown と同じ規則を使うので、ここには
   Markdown に相当物が無いものだけを置く。 */
.rst-preview :deep(.rst-admonition) {
  margin: 0.8em 0;
  padding: 8px 12px;
  border-left: 3px solid var(--accent);
  border-radius: 0 3px 3px 0;
  background: var(--bg-tertiary);
}

.rst-preview :deep(.rst-admonition-title) {
  margin: 0 0 4px;
  color: var(--text-active);
  font-weight: 600;
  font-size: 0.9em;
}

/* 注意を促す種別は色を変える。docutils の分類に合わせて 2 段階だけ持つ。
   黄色はテーマに変数が無いので、git diff ガターの「変更」と同じ値を直に置く
   （あちらと同じく、両テーマで読める明度を選んである）。 */
.rst-preview :deep(.rst-warning),
.rst-preview :deep(.rst-caution),
.rst-preview :deep(.rst-attention) { border-left-color: #d29922; }

.rst-preview :deep(.rst-danger),
.rst-preview :deep(.rst-error) { border-left-color: var(--danger); }

/* フィールドリスト（`:key: value`）。値の幅を主にしたいので、キー側だけ詰める。 */
.rst-preview :deep(.rst-fields) { width: auto; }
.rst-preview :deep(.rst-fields th) { white-space: nowrap; width: 1%; }

/* 脚注・引用は Markdown の脚注（#241）の見た目を共有する。段落を 2 つ以上持つ本文だけは
   `buildRstPreview` を通るので `<p>` が入り、そのままだと番号・本文・戻りリンクが 3 行に
   割れる。1 つ目の段落だけ番号と同じ行に置く。 */
.rst-preview :deep(.footnote > p:first-of-type) {
  display: inline;
}

/* Stand-in for an image whose host is not approved yet (#239). Sized like a
   badge so a row of them keeps the surrounding line intact. */
.md-preview :deep(.external-image) {
  display: inline-block;
  padding: 1px 6px;
  border: 1px dashed var(--border);
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.85em;
  line-height: 1.6;
  cursor: pointer;
}
.md-preview :deep(.external-image:hover) {
  border-color: var(--accent);
  color: var(--text-primary);
}
.md-preview :deep(.mermaid-inline) { text-align: center; margin: 16px 0; }
.md-preview :deep(.mermaid-inline svg) { max-width: 100%; height: auto; }
.md-preview :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
.md-preview :deep(ul),
.md-preview :deep(ol) { padding-left: 1.5em; }

.md-preview :deep(.frontmatter) {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-secondary);
  margin-bottom: 1.2em;
  font-size: 0.9em;
}

.md-preview :deep(.frontmatter > summary) {
  cursor: pointer;
  padding: 6px 12px;
  color: var(--text-secondary);
  user-select: none;
}

.md-preview :deep(.frontmatter-kind) {
  margin-left: 8px;
  font-size: 0.85em;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  opacity: 0.8;
}

.md-preview :deep(.frontmatter > table) {
  border-top: 1px solid var(--border);
}

.md-preview :deep(.frontmatter th) {
  width: 1%;
  white-space: nowrap;
  vertical-align: top;
  font-weight: normal;
  background: transparent;
  color: var(--text-secondary);
}

.md-preview :deep(.frontmatter th),
.md-preview :deep(.frontmatter td) {
  border: none;
  border-top: 1px solid var(--border);
  padding: 4px 12px;
}

.md-preview :deep(.frontmatter > table tr:first-child th),
.md-preview :deep(.frontmatter > table tr:first-child td) {
  border-top: none;
}

.md-preview :deep(.frontmatter-empty) {
  padding: 4px 12px 8px;
  color: var(--text-secondary);
}

.md-preview :deep(.frontmatter-invalid) {
  border-color: var(--danger);
}

.md-preview :deep(.frontmatter-error) {
  padding: 4px 12px;
  color: var(--danger);
}

.md-preview :deep(.frontmatter > pre) {
  margin: 0 12px 12px;
}

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
  gap: 12px;
}

.editor-status.directory {
  flex-direction: column;
  /* .editor-status は中央寄せなので、縦並びにしたときも軸を揃える */
  align-items: center;
  text-align: center;
  gap: 8px;
  padding: 20px;
  color: var(--text-primary);
}

.dir-path {
  max-width: 100%;
  font-family: var(--font-mono, monospace);
  word-break: break-all;
}

.dir-note {
  color: var(--text-secondary);
}

.dir-actions {
  display: flex;
  gap: 8px;
}

.dir-actions .dir-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.dir-window {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}

.error-retry,
.dir-actions button {
  padding: 3px 12px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  flex-shrink: 0;
}

.error-retry:hover,
.dir-actions button:hover {
  background: var(--tab-hover-bg);
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
