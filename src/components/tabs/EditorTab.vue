<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { EditorView, lineNumbers, highlightActiveLine, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, indentWithTab, history, historyKeymap, undo, redo } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { highlightSelectionMatches } from "@codemirror/search";
import { editorSearch, searchKeymap } from "../../lib/editorSearch";
import { oneDark } from "@codemirror/theme-one-dark";
import { useTabStore } from "../../stores/tabs";
import { useProjectStore } from "../../stores/project";
import { useSettingsStore } from "../../stores/settings";
import { fsReadFile, fsWriteFile, gitDiffLines } from "../../lib/tauri";
import { getLanguage, getLanguageLabel } from "../../lib/languages";
import { basename, extension } from "../../lib/paths";
import { useEditorInfo } from "../../composables/useEditorInfo";
import { gitDiffGutter, setDiffLines } from "../../lib/editorGitGutter";
import { minimap } from "../../lib/editorMinimap";
import { marked } from "marked";
import type { EditorTab } from "../../types/tab";

const props = defineProps<{ tabId: string }>();
const tabStore = useTabStore();
const projectStore = useProjectStore();
const settingsStore = useSettingsStore();
const editorInfo = useEditorInfo();

// Dynamic compartments for settings that can change at runtime
const minimapCompartment = new Compartment();
const wordWrapCompartment = new Compartment();
const tabSizeCompartment = new Compartment();
const indentUnitCompartment = new Compartment();

const tab = computed(() =>
  tabStore.tabs.find((t): t is EditorTab => t.id === props.tabId && t.kind === "editor")
);

const editorRef = ref<HTMLDivElement>();
const previewRef = ref<HTMLDivElement>();
let editorView: EditorView | null = null;
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
let savedContent = "";
const isDirty = ref(false);
const currentEncoding = ref("UTF-8");
const currentLineEnding = ref<'LF' | 'CRLF'>('LF');

// Markdown preview
const viewMode = ref<'edit' | 'split' | 'preview'>('edit');
const debouncedDocVersion = ref(0);
let docVersionTimer: ReturnType<typeof setTimeout> | null = null;
let syncingScroll = false;

function bumpDocVersion() {
  if (docVersionTimer) clearTimeout(docVersionTimer);
  docVersionTimer = setTimeout(() => {
    debouncedDocVersion.value++;
  }, 250);
}

const isMarkdown = computed(() => {
  if (!tab.value) return false;
  const ext = extension(tab.value.path);
  return ext === 'md' || ext === 'markdown';
});

const showEditor = computed(() => viewMode.value !== 'preview');
const showPreview = computed(() => viewMode.value !== 'edit');

const previewHtml = computed(() => {
  void debouncedDocVersion.value;
  if (!showPreview.value || !editorView) return '';
  return marked.parse(editorView.state.doc.toString()) as string;
});

function updateTitle() {
  if (!tab.value) return;
  const baseName = basename(tab.value.path) + (tab.value.readOnly ? '' : '');
  tabStore.setTabTitle(props.tabId, isDirty.value ? baseName + " *" : baseName);
}

function updateDirtyState() {
  if (!editorView) return;
  const current = editorView.state.doc.toString();
  const dirty = current !== savedContent;
  if (dirty !== isDirty.value) {
    isDirty.value = dirty;
    updateTitle();
  }
}

function updateCursorInfo() {
  if (!editorView || !tab.value) return;
  if (tabStore.activeTabId !== props.tabId) return;
  const pos = editorView.state.selection.main.head;
  const line = editorView.state.doc.lineAt(pos);
  editorInfo.update({
    line: line.number,
    col: pos - line.from + 1,
    encoding: currentEncoding.value,
    lineEnding: currentLineEnding.value,
    fileType: getLanguageLabel(tab.value.path),
    tabSize: settingsStore.editorTabSize,
    tabId: props.tabId,
  });
}

async function save(overrideEncoding?: string) {
  if (!editorView || !tab.value || saving.value || tab.value.readOnly) return;
  const project = projectStore.currentProject;
  if (!project) return;

  const enc = overrideEncoding ?? currentEncoding.value;
  saving.value = true;
  try {
    let content = editorView.state.doc.toString();
    if (currentLineEnding.value === 'CRLF') {
      content = content.replace(/\n/g, '\r\n');
    }
    await fsWriteFile(project.shell, tab.value.path, content,
      enc !== 'UTF-8' ? enc : undefined);
    if (overrideEncoding) {
      currentEncoding.value = enc;
      updateCursorInfo();
    }
    savedContent = editorView.state.doc.toString();
    updateDirtyState();
    refreshDiffGutter();
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}

async function loadContent(encoding?: string): Promise<string> {
  if (!tab.value) throw new Error('No tab');

  if (tab.value.initialContent !== undefined) {
    savedContent = tab.value.initialContent;
    currentEncoding.value = 'UTF-8';
    currentLineEnding.value = tab.value.initialContent.includes('\r\n') ? 'CRLF' : 'LF';
    return savedContent;
  }

  const project = projectStore.currentProject;
  if (!project) throw new Error('No project');

  const result = await fsReadFile(project.shell, tab.value.path, encoding);
  currentEncoding.value = result.encoding;
  // Detect and normalize line endings for CodeMirror (which uses \n internally)
  currentLineEnding.value = result.content.includes('\r\n') ? 'CRLF' : 'LF';
  const normalized = result.content.replace(/\r\n/g, '\n');
  savedContent = normalized;
  return normalized;
}

// --- Git diff gutter ---
async function refreshDiffGutter() {
  if (!editorView || !tab.value || tab.value.readOnly || tab.value.initialContent !== undefined) return;
  const project = projectStore.currentProject;
  if (!project) return;
  try {
    const diff = await gitDiffLines(project.root, project.shell, tab.value.path);
    editorView?.dispatch({ effects: setDiffLines.of(diff) });
  } catch {
    // Not a git repo or file not tracked — ignore
  }
}

// --- Context menu ---
const ctxMenu = ref<{ x: number; y: number } | null>(null);

function onEditorContextMenu(e: MouseEvent) {
  e.preventDefault();
  ctxHasSelection.value = editorView ? !editorView.state.selection.main.empty : false;
  ctxMenu.value = { x: e.clientX, y: e.clientY };
  nextTick(() => {
    window.addEventListener("mousedown", closeCtxMenu, { once: true });
  });
}

function closeCtxMenu() {
  ctxMenu.value = null;
}

function execUndo() {
  closeCtxMenu();
  if (editorView) undo(editorView);
}

function execRedo() {
  closeCtxMenu();
  if (editorView) redo(editorView);
}

function execCut() {
  closeCtxMenu();
  if (!editorView) return;
  editorView.focus();
  document.execCommand('cut');
}

function execCopy() {
  closeCtxMenu();
  if (!editorView) return;
  editorView.focus();
  document.execCommand('copy');
}

async function execPaste() {
  closeCtxMenu();
  if (!editorView) return;
  const text = await navigator.clipboard.readText();
  if (text) editorView.dispatch(editorView.state.replaceSelection(text));
}

function openGitHistory() {
  closeCtxMenu();
  if (!tab.value) return;
  tabStore.addHistoryTab({ filePath: tab.value.path });
}

const isReadOnlyTab = computed(() => tab.value?.readOnly ?? false);
// Snapshot selection state when context menu opens (not reactive — avoids stale computed)
const ctxHasSelection = ref(false);


function createEditorView(container: HTMLElement, content: string) {
  const isReadOnly = tab.value?.readOnly ?? false;
  const lang = tab.value ? getLanguage(tab.value.path) : null;
  const hasFile = tab.value && !tab.value.initialContent;
  const extensions = [
    oneDark,
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
        updateDirtyState();
        bumpDocVersion();
      }
      if (update.selectionSet || update.docChanged) updateCursorInfo();
    }),
    EditorView.theme({
      "&": { height: "100%", fontSize: "13px" },
      ".cm-scroller": {
        fontFamily: "'PlemolJP Console NF', 'Cascadia Code', 'Fira Code', monospace",
      },
      ".cm-searchMatch": {
        backgroundColor: "rgba(255, 213, 0, 0.25)",
      },
      ".cm-searchMatch-selected": {
        backgroundColor: "rgba(255, 213, 0, 0.5)",
      },
    }),
  ];

  // Git diff gutter + minimap (only for real files)
  if (hasFile) {
    extensions.push(gitDiffGutter());
    extensions.push(minimapCompartment.of(settingsStore.editorMinimap ? minimap() : []));
  }

  if (!isReadOnly) {
    extensions.push(keymap.of([
      ...searchKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
      { key: "Mod-s", run: () => { save(); return true; } },
    ]));
  } else {
    extensions.push(EditorState.readOnly.of(true));
    extensions.push(keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]));
  }
  if (lang) extensions.push(lang);

  return new EditorView({
    state: EditorState.create({ doc: content, extensions }),
    parent: container,
  });
}

async function reopenWithEncoding(encoding: string) {
  if (!editorRef.value || !tab.value) return;
  loading.value = true;
  try {
    editorView?.destroy();
    editorView = null;
    const content = await loadContent(encoding);
    if (!editorRef.value) return;
    loading.value = false;
    editorView = createEditorView(editorRef.value, content);
    if (viewMode.value === 'split') {
      editorView.scrollDOM.addEventListener('scroll', onEditorScroll);
    }
    isDirty.value = false;
    updateTitle();
    updateCursorInfo();
    refreshDiffGutter();
  } catch (e) {
    loading.value = false;
    error.value = String(e);
  }
}

function changeLineEnding(le: 'LF' | 'CRLF') {
  currentLineEnding.value = le;
  // Mark as dirty since the save output will differ
  if (!isDirty.value) {
    isDirty.value = true;
    updateTitle();
  }
  updateCursorInfo();
}

function jumpToLine(lineNum?: number) {
  if (!lineNum || !editorView) return;
  const docLines = editorView.state.doc.lines;
  const line = editorView.state.doc.line(Math.min(lineNum, docLines));
  editorView.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
  });
  if (tab.value) tab.value.initialLine = undefined;
}

onMounted(async () => {
  if (!editorRef.value || !tab.value) return;

  try {
    const content = await loadContent();
    if (!editorRef.value) return;
    loading.value = false;
    editorView = createEditorView(editorRef.value, content);
    jumpToLine(tab.value?.initialLine);
    updateCursorInfo();
    refreshDiffGutter();

    // Register callbacks for StatusBar to change encoding/line ending
    editorInfo.registerCallbacks(
      (enc) => reopenWithEncoding(enc),
      (le) => changeLineEnding(le),
      (enc) => save(enc),
    );
  } catch (e) {
    loading.value = false;
    error.value = String(e);
  }
});

// Scroll sync
function onEditorScroll() {
  if (syncingScroll || viewMode.value !== 'split' || !previewRef.value || !editorView) return;
  const scroller = editorView.scrollDOM;
  const ratio = scroller.scrollTop / (scroller.scrollHeight - scroller.clientHeight || 1);
  syncingScroll = true;
  previewRef.value.scrollTop = ratio * (previewRef.value.scrollHeight - previewRef.value.clientHeight);
  requestAnimationFrame(() => { syncingScroll = false; });
}

function onPreviewScroll() {
  if (syncingScroll || viewMode.value !== 'split' || !previewRef.value || !editorView) return;
  const preview = previewRef.value;
  const ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight || 1);
  syncingScroll = true;
  const scroller = editorView.scrollDOM;
  scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
  requestAnimationFrame(() => { syncingScroll = false; });
}

// Jump to line when initialLine changes on an existing tab
watch(
  () => tab.value?.initialLine,
  (lineNum) => {
    if (lineNum) jumpToLine(lineNum);
  }
);

watch(
  () => viewMode.value,
  (mode) => {
    if (mode === 'split' && editorView) {
      editorView.scrollDOM.addEventListener('scroll', onEditorScroll);
    } else if (editorView) {
      editorView.scrollDOM.removeEventListener('scroll', onEditorScroll);
    }
  }
);

watch(
  () => tabStore.activeTabId,
  (id) => {
    if (id === props.tabId && editorView) {
      editorView.requestMeasure();
      updateCursorInfo();
      editorInfo.registerCallbacks(
        (enc) => reopenWithEncoding(enc),
        (le) => changeLineEnding(le),
      );
    } else if (id !== props.tabId) {
      editorInfo.clear();
    }
  }
);

// Live-apply editor settings changes
watch(() => settingsStore.editorMinimap, (on) => {
  if (!editorView) return;
  editorView.dispatch({ effects: minimapCompartment.reconfigure(on ? minimap() : []) });
});

watch(() => settingsStore.editorWordWrap, (on) => {
  if (!editorView) return;
  editorView.dispatch({ effects: wordWrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
});

watch(() => settingsStore.editorTabSize, (size) => {
  if (!editorView) return;
  editorView.dispatch({ effects: [
    tabSizeCompartment.reconfigure(EditorState.tabSize.of(size)),
    indentUnitCompartment.reconfigure(indentUnit.of(' '.repeat(size))),
  ] });
});

onUnmounted(() => {
  if (docVersionTimer) clearTimeout(docVersionTimer);
  editorView?.scrollDOM.removeEventListener('scroll', onEditorScroll);
  editorView?.destroy();
  editorView = null;
  if (tabStore.activeTabId === props.tabId) {
    editorInfo.clear();
  }
});
</script>

<template>
  <div class="editor-tab">
    <div v-if="isMarkdown && !loading && !error" class="preview-toolbar">
      <button class="preview-toggle" :class="{ active: viewMode === 'edit' }" @click="viewMode = 'edit'">Edit</button>
      <button class="preview-toggle" :class="{ active: viewMode === 'split' }" @click="viewMode = 'split'">Split</button>
      <button class="preview-toggle" :class="{ active: viewMode === 'preview' }" @click="viewMode = 'preview'">Preview</button>
    </div>
    <div v-if="loading" class="editor-status">Loading...</div>
    <div v-else-if="error" class="editor-status error">{{ error }}</div>
    <div class="editor-body" :class="{ split: viewMode === 'split' }" v-show="!loading && !error">
      <div v-show="showEditor" ref="editorRef" class="editor-container" @contextmenu.prevent="onEditorContextMenu"></div>
      <div v-if="showPreview" ref="previewRef" class="md-preview" v-html="previewHtml" @scroll="onPreviewScroll"></div>
    </div>
    <div v-if="saving" class="save-indicator">Saving...</div>

    <!-- Context Menu -->
    <Teleport to="body">
      <div
        v-if="ctxMenu"
        class="editor-ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @mousedown.stop
      >
        <button @click="execUndo" :disabled="isReadOnlyTab"><span>Undo</span><span class="ctx-key">Ctrl+Z</span></button>
        <button @click="execRedo" :disabled="isReadOnlyTab"><span>Redo</span><span class="ctx-key">Ctrl+Shift+Z</span></button>
        <div class="ctx-separator"></div>
        <button @click="execCut" :disabled="isReadOnlyTab || !ctxHasSelection"><span>Cut</span><span class="ctx-key">Ctrl+X</span></button>
        <button @click="execCopy" :disabled="!ctxHasSelection"><span>Copy</span><span class="ctx-key">Ctrl+C</span></button>
        <button @click="execPaste" :disabled="isReadOnlyTab"><span>Paste</span><span class="ctx-key">Ctrl+V</span></button>
        <div class="ctx-separator"></div>
        <button @click="openGitHistory"><span>Git History</span><span class="ctx-key">Alt+H</span></button>
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
.editor-body.split > .md-preview {
  width: 50%;
  border-right: 1px solid var(--border);
}

.editor-body.split > .md-preview {
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
.md-preview :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 1.5em 0; }
.md-preview :deep(ul),
.md-preview :deep(ol) { padding-left: 1.5em; }

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
