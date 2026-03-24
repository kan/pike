<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { EditorView, lineNumbers, highlightActiveLine, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { oneDark } from "@codemirror/theme-one-dark";
import { useTabStore } from "../../stores/tabs";
import { useProjectStore } from "../../stores/project";
import { fsReadFile, fsWriteFile } from "../../lib/tauri";
import { getLanguage } from "../../lib/languages";
import { basename } from "../../lib/paths";
import type { EditorTab } from "../../types/tab";

const props = defineProps<{ tabId: string }>();
const tabStore = useTabStore();
const projectStore = useProjectStore();

const tab = computed(() =>
  tabStore.tabs.find((t): t is EditorTab => t.id === props.tabId && t.kind === "editor")
);

const editorRef = ref<HTMLDivElement>();
let editorView: EditorView | null = null;
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
let savedContent = "";
const isDirty = ref(false);

function updateDirtyState() {
  if (!editorView) return;
  const current = editorView.state.doc.toString();
  const dirty = current !== savedContent;
  if (dirty !== isDirty.value) {
    isDirty.value = dirty;
    if (tab.value) {
      const baseName = basename(tab.value.path);
      tabStore.setTabTitle(props.tabId, dirty ? baseName + " *" : baseName);
    }
  }
}

async function save() {
  if (!editorView || !tab.value || saving.value) return;
  const project = projectStore.currentProject;
  if (!project) return;

  saving.value = true;
  try {
    const content = editorView.state.doc.toString();
    await fsWriteFile(project.shell, tab.value.path, content);
    savedContent = content;
    updateDirtyState();
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (!editorRef.value || !tab.value) return;
  const project = projectStore.currentProject;
  if (!project) return;

  try {
    const content = await fsReadFile(project.shell, tab.value.path);
    if (!editorRef.value) return; // component unmounted during load
    savedContent = content;
    loading.value = false;

    const lang = getLanguage(tab.value.path);
    const extensions = [
      oneDark,
      lineNumbers(),
      highlightActiveLine(),
      keymap.of([
        ...defaultKeymap,
        indentWithTab,
        { key: "Mod-s", run: () => { save(); return true; } },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) updateDirtyState();
      }),
      EditorView.theme({
        "&": {
          height: "100%",
          fontSize: "13px",
        },
        ".cm-scroller": {
          fontFamily: "'PlemolJP Console NF', 'Cascadia Code', 'Fira Code', monospace",
        },
      }),
    ];
    if (lang) extensions.push(lang);

    editorView = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: editorRef.value,
    });
  } catch (e) {
    loading.value = false;
    error.value = String(e);
  }
});

// Refit editor when tab becomes active
watch(
  () => tabStore.activeTabId,
  (id) => {
    if (id === props.tabId && editorView) {
      editorView.requestMeasure();
    }
  }
);

onUnmounted(() => {
  editorView?.destroy();
  editorView = null;
});
</script>

<template>
  <div class="editor-tab">
    <div v-if="loading" class="editor-status">Loading...</div>
    <div v-else-if="error" class="editor-status error">{{ error }}</div>
    <div ref="editorRef" class="editor-container"></div>
    <div v-if="saving" class="save-indicator">Saving...</div>
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

.editor-container {
  flex: 1;
  overflow: auto;
}

.editor-container :deep(.cm-editor) {
  height: 100%;
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
</style>
