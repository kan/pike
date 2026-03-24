<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { useProjectStore } from "../../stores/project";
import { useTabStore } from "../../stores/tabs";
import { useSidebarStore } from "../../stores/sidebar";
import { useGitStore } from "../../stores/git";
import { fsListDir, fsReadFileBase64, fsRename, fsDelete, fsCopy, type FsEntry } from "../../lib/tauri";
import { fileIcon } from "../../lib/fileIcons";
import { gitStatusColor, isImageFile, mimeType, basename } from "../../lib/paths";

const projectStore = useProjectStore();
const tabStore = useTabStore();
const sidebar = useSidebarStore();
const gitStore = useGitStore();

const tree = ref<Record<string, FsEntry[]>>({});
const expanded = ref<Set<string>>(new Set());
const loading = ref<Set<string>>(new Set());

function sep(): string {
  return projectStore.currentProject?.shell?.kind === "wsl" ? "/" : "\\";
}

function join(parent: string, child: string): string {
  const s = sep();
  return parent.endsWith(s) ? parent + child : parent + s + child;
}

async function loadDir(path: string) {
  const project = projectStore.currentProject;
  if (!project) return;
  loading.value.add(path);
  try {
    tree.value[path] = await fsListDir(project.shell, path);
  } catch {
    tree.value[path] = [];
  } finally {
    loading.value.delete(path);
  }
}

function toggleDir(path: string) {
  if (expanded.value.has(path)) {
    expanded.value.delete(path);
  } else {
    expanded.value.add(path);
    if (!tree.value[path]) loadDir(path);
  }
}

// Precomputed git status map: full path → status string
const gitStatusMap = computed(() => {
  const status = gitStore.status;
  const root = projectStore.currentProject?.root;
  if (!status || !root) return new Map<string, string>();
  const s = sep();
  const map = new Map<string, string>();
  for (const list of [status.unstaged, status.staged]) {
    for (const f of list) {
      const full = root + s + f.path.replace(/\//g, s);
      map.set(full, f.status);
      // Propagate to parent directories
      let dir = full;
      while ((dir = dir.substring(0, dir.lastIndexOf(s))).length > root.length) {
        if (!map.has(dir)) map.set(dir, f.status);
      }
    }
  }
  return map;
});

async function openFile(path: string) {
  if (isImageFile(path)) {
    const project = projectStore.currentProject;
    if (!project) return;
    const base64 = await fsReadFileBase64(project.shell, path);
    const dataUrl = `data:${mimeType(path)};base64,${base64}`;
    tabStore.addPreviewTab({ path, dataUrl });
  } else {
    tabStore.addEditorTab({ path });
  }
}

// Context menu
const ctxMenu = ref<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
const renaming = ref<string | null>(null);
const renameValue = ref("");

function onContextMenu(e: MouseEvent, path: string, isDir: boolean) {
  e.preventDefault();
  ctxMenu.value = { x: e.clientX, y: e.clientY, path, isDir };
  nextTick(() => {
    window.addEventListener("mousedown", closeCtxMenu, { once: true });
  });
}

function closeCtxMenu() {
  ctxMenu.value = null;
}

function startRename(path: string) {
  closeCtxMenu();
  renaming.value = path;
  renameValue.value = basename(path);
  nextTick(() => {
    const input = document.querySelector('.rename-input') as HTMLInputElement;
    input?.select();
  });
}

async function commitRename() {
  if (!renaming.value || !renameValue.value.trim()) {
    renaming.value = null;
    return;
  }
  const project = projectStore.currentProject;
  if (!project) return;
  const oldPath = renaming.value;
  const s = sep();
  const parentDir = oldPath.substring(0, oldPath.lastIndexOf(s));
  const newPath = parentDir + s + renameValue.value.trim();
  if (newPath !== oldPath) {
    await fsRename(project.shell, oldPath, newPath);
    await loadDir(parentDir);
  }
  renaming.value = null;
}

async function deleteItem() {
  if (!ctxMenu.value) return;
  const project = projectStore.currentProject;
  if (!project) return;
  const path = ctxMenu.value.path;
  const name = basename(path);
  closeCtxMenu();
  if (!confirm(`Delete "${name}"?`)) return;
  await fsDelete(project.shell, path);
  const s = sep();
  const parentDir = path.substring(0, path.lastIndexOf(s));
  await loadDir(parentDir);
}

function showGitHistory() {
  if (!ctxMenu.value) return;
  const filePath = ctxMenu.value.path;
  const s = sep();
  const root = projectStore.currentProject?.root ?? '';
  const rel = filePath.startsWith(root + s) ? filePath.slice(root.length + s.length) : filePath;
  closeCtxMenu();
  tabStore.addHistoryTab({ filePath: rel });
}

// Drag & Drop
const dragPath = ref<string | null>(null);
const dropTarget = ref<string | null>(null);

function onDragStart(e: DragEvent, path: string) {
  dragPath.value = path;
  e.dataTransfer?.setData("text/plain", path);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "all";
}

function onDragOver(e: DragEvent, path: string, isDir: boolean) {
  if (!dragPath.value) return;
  const s = sep();
  const targetDir = isDir ? path : path.substring(0, path.lastIndexOf(s));
  // Prevent dropping a directory into itself or its descendants
  if (targetDir === dragPath.value || targetDir.startsWith(dragPath.value + s)) return;
  e.preventDefault();
  dropTarget.value = targetDir;
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
  }
}

function onDragLeave() {
  dropTarget.value = null;
}

function onDragEnd() {
  dragPath.value = null;
  dropTarget.value = null;
}

async function onDrop(e: DragEvent, path: string, isDir: boolean) {
  e.preventDefault();
  const source = dragPath.value;
  dragPath.value = null;
  dropTarget.value = null;
  if (!source) return;
  const project = projectStore.currentProject;
  if (!project) return;

  const s = sep();
  const targetDir = isDir ? path : path.substring(0, path.lastIndexOf(s));
  const name = basename(source);
  const dest = targetDir + s + name;

  if (source === dest) return;

  try {
    if (e.ctrlKey) {
      await fsCopy(project.shell, source, dest);
    } else {
      await fsRename(project.shell, source, dest);
    }
    const sourceDir = source.substring(0, source.lastIndexOf(s));
    await Promise.all([loadDir(sourceDir), loadDir(targetDir)]);
  } catch (err) {
    alert(String(err));
  }
}

async function refresh() {
  const root = projectStore.currentProject?.root;
  if (!root) return;
  const paths = [root, ...expanded.value];
  await Promise.all(paths.map((p) => loadDir(p)));
}

interface FlatNode {
  entry: FsEntry;
  path: string;
  depth: number;
}

const flatNodes = computed((): FlatNode[] => {
  const root = projectStore.currentProject?.root;
  if (!root) return [];
  const result: FlatNode[] = [];

  function walk(parentPath: string, depth: number) {
    const children = tree.value[parentPath];
    if (!children) return;
    for (const entry of children) {
      const path = join(parentPath, entry.name);
      result.push({ entry, path, depth });
      if (entry.isDir && expanded.value.has(path)) {
        walk(path, depth + 1);
      }
    }
  }

  walk(root, 0);
  return result;
});

function initTree() {
  tree.value = {};
  expanded.value.clear();
  const root = projectStore.currentProject?.root;
  if (root) {
    expanded.value.add(root);
    loadDir(root);
  }
}

watch(() => projectStore.currentProject?.id, initTree);
watch(() => sidebar.activePanel, (panel) => {
  if (panel === "files" && projectStore.currentProject) {
    const root = projectStore.currentProject.root;
    if (!tree.value[root]) initTree();
  }
});

onMounted(() => {
  if (sidebar.activePanel === "files" && projectStore.currentProject) {
    initTree();
  }
});

defineExpose({ refresh });
</script>

<template>
  <div class="filetree-panel">
    <div v-if="!projectStore.currentProject" class="empty">No project selected</div>
    <template v-else>
      <template v-for="node in flatNodes" :key="node.path">
        <div
          v-if="renaming === node.path"
          class="tree-item"
          :style="{ paddingLeft: (node.depth * 16 + 4) + 'px' }"
        >
          <span class="tree-chevron-space"></span>
          <input
            class="rename-input"
            v-model="renameValue"
            @keydown.enter="commitRename"
            @keydown.esc="renaming = null"
            @blur="commitRename"
          />
        </div>
        <div
          v-else
          class="tree-item"
          :class="{ 'drop-target': dropTarget === node.path }"
          :style="{ paddingLeft: (node.depth * 16 + 4) + 'px' }"
          :draggable="true"
          @click="node.entry.isDir ? toggleDir(node.path) : openFile(node.path)"
          @contextmenu="onContextMenu($event, node.path, node.entry.isDir)"
          @dragstart="onDragStart($event, node.path)"
          @dragover="onDragOver($event, node.path, node.entry.isDir)"
          @dragleave="onDragLeave"
          @dragend="onDragEnd"
          @drop="onDrop($event, node.path, node.entry.isDir)"
        >
          <span v-if="node.entry.isDir" class="tree-chevron">
            {{ loading.has(node.path) ? '..' : expanded.has(node.path) ? 'v' : '>' }}
          </span>
          <span v-else class="tree-chevron-space"></span>
          <span class="tree-icon">{{ node.entry.isDir ? '📁' : fileIcon(node.entry.name) }}</span>
          <span class="tree-name" :style="gitStatusMap.has(node.path) ? { color: gitStatusColor(gitStatusMap.get(node.path)!) } : undefined">{{ node.entry.name }}</span>
        </div>
      </template>
      <div v-if="!flatNodes.length" class="empty">Empty</div>

      <!-- Context menu -->
      <Teleport to="body">
        <div v-if="ctxMenu" class="tree-ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" @mousedown.stop>
          <button @click="startRename(ctxMenu.path)">Rename</button>
          <button @click="deleteItem()">Delete</button>
          <button v-if="!ctxMenu.isDir" @click="showGitHistory()">Git History</button>
        </div>
      </Teleport>

    </template>
  </div>
</template>

<style scoped>
.filetree-panel {
  display: flex;
  flex-direction: column;
}

.tree-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  cursor: pointer;
  font-size: 12px;
  border-radius: 3px;
  white-space: nowrap;
}

.tree-item:hover {
  background: var(--tab-hover-bg);
}

.tree-chevron {
  font-family: monospace;
  font-size: 10px;
  width: 12px;
  flex-shrink: 0;
  color: var(--text-secondary);
  text-align: center;
}

.tree-chevron-space {
  width: 12px;
  flex-shrink: 0;
}

.tree-icon {
  flex-shrink: 0;
  width: 16px;
  font-size: 12px;
  text-align: center;
}

.tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
}

.tree-item.drop-target {
  background: rgba(0, 122, 204, 0.15);
  outline: 1px dashed var(--accent);
  outline-offset: -1px;
}

.rename-input {
  flex: 1;
  min-width: 0;
  padding: 1px 4px;
  border: 1px solid var(--accent);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 2px;
  outline: none;
}

.empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
}
</style>

<style>
.tree-ctx-menu {
  position: fixed;
  z-index: 2000;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 0;
  min-width: 120px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.tree-ctx-menu button {
  display: block;
  width: 100%;
  padding: 6px 16px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.tree-ctx-menu button:hover {
  background: var(--accent);
  color: var(--text-active);
}


</style>
