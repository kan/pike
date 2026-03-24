<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useProjectStore } from "../../stores/project";
import { useTabStore } from "../../stores/tabs";
import { useSidebarStore } from "../../stores/sidebar";
import { useGitStore } from "../../stores/git";
import { fsListDir, type FsEntry } from "../../lib/tauri";
import { fileIcon } from "../../lib/fileIcons";
import { gitStatusColor } from "../../lib/paths";

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

function openFile(path: string) {
  tabStore.addEditorTab({ path });
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
      <div
        v-for="node in flatNodes"
        :key="node.path"
        class="tree-item"
        :style="{ paddingLeft: (node.depth * 16 + 4) + 'px' }"
        @click="node.entry.isDir ? toggleDir(node.path) : openFile(node.path)"
      >
        <span v-if="node.entry.isDir" class="tree-chevron">
          {{ loading.has(node.path) ? '..' : expanded.has(node.path) ? 'v' : '>' }}
        </span>
        <span v-else class="tree-chevron-space"></span>
        <span class="tree-icon">{{ node.entry.isDir ? '📁' : fileIcon(node.entry.name) }}</span>
        <span class="tree-name" :style="gitStatusMap.has(node.path) ? { color: gitStatusColor(gitStatusMap.get(node.path)!) } : undefined">{{ node.entry.name }}</span>
      </div>
      <div v-if="!flatNodes.length" class="empty">Empty</div>
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

.empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
}
</style>
