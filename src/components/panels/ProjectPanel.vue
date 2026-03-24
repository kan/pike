<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useProjectStore } from "../../stores/project";
import { useTabStore } from "../../stores/tabs";
import { detectWslDistros } from "../../lib/tauri";
import { ptyRouter } from "../../composables/usePtyRouter";
import type { ProjectConfig } from "../../types/project";
import {
  shellLabel,
  shellToPlatform,
  shellToWinKind,
  shellToDistro,
  buildShell,
  slugify,
  rootPlaceholder as rootPlaceholderFn,
  WINDOWS_SHELLS,
} from "../../types/tab";

const projectStore = useProjectStore();
const tabStore = useTabStore();

const distros = ref<string[]>([]);
const detecting = ref(false);

onMounted(async () => {
  projectStore.loadProjects();
  try {
    distros.value = await detectWslDistros();
    if (distros.value.length > 0) {
      formDistro.value = distros.value[0];
    }
  } catch {
    distros.value = ["Ubuntu"];
  }
});

// --- Create form ---
const showForm = ref(false);
const formName = ref("");
const formRoot = ref("");
const formPlatform = ref<"wsl" | "windows">("wsl");
const formDistro = ref("Ubuntu");
const formWindowsShell = ref<"cmd" | "powershell" | "git-bash">("powershell");

const createRootPlaceholder = computed(() => rootPlaceholderFn(formPlatform.value));

watch(showForm, async (show) => {
  if (show) await detectFromTerminal();
});

async function detectFromTerminal() {
  const activeTab = tabStore.activeTab;
  if (!activeTab || activeTab.kind !== "terminal" || !activeTab.ptyId) return;

  if (activeTab.shell) {
    formPlatform.value = shellToPlatform(activeTab.shell);
    formDistro.value = shellToDistro(activeTab.shell);
    formWindowsShell.value = shellToWinKind(activeTab.shell);
  }

  detecting.value = true;
  try {
    const cwd = await ptyRouter.detectCwd(activeTab.ptyId);
    if (cwd) {
      formRoot.value = cwd;
      if (!formName.value) {
        const sep = cwd.includes("\\") ? "\\" : "/";
        formName.value = cwd.split(sep).filter(Boolean).pop() ?? "";
      }
    }
  } finally {
    detecting.value = false;
  }
}

async function onCreate() {
  const id = slugify(formName.value);
  if (!id) return;
  const config: ProjectConfig = {
    id,
    name: formName.value,
    root: formRoot.value,
    shell: buildShell(formPlatform.value, formDistro.value, formWindowsShell.value),
    pinnedTabs: [],
    lastOpened: new Date().toISOString(),
  };
  await projectStore.addProject(config);
  showForm.value = false;
  formName.value = "";
  formRoot.value = "";
}

// --- Edit form ---
const editingId = ref<string | null>(null);
const editName = ref("");
const editRoot = ref("");
const editPlatform = ref<"wsl" | "windows">("wsl");
const editDistro = ref("Ubuntu");
const editWindowsShell = ref<"cmd" | "powershell" | "git-bash">("powershell");

const editRootPlaceholder = computed(() => rootPlaceholderFn(editPlatform.value));

function startEdit(project: ProjectConfig) {
  editingId.value = project.id;
  editName.value = project.name;
  editRoot.value = project.root;
  editPlatform.value = shellToPlatform(project.shell);
  editDistro.value = shellToDistro(project.shell);
  editWindowsShell.value = shellToWinKind(project.shell);
}

function cancelEdit() {
  editingId.value = null;
}

async function onSaveEdit() {
  if (!editingId.value) return;
  const existing = projectStore.projects.find((p) => p.id === editingId.value);
  if (!existing) return;

  const updated: ProjectConfig = {
    ...existing,
    name: editName.value,
    root: editRoot.value,
    shell: buildShell(editPlatform.value, editDistro.value, editWindowsShell.value),
  };
  await projectStore.saveProject(updated);
  editingId.value = null;
}

async function onDelete(id: string) {
  await projectStore.removeProject(id);
  if (editingId.value === id) editingId.value = null;
}
</script>

<template>
  <div class="project-panel">
    <button class="add-btn" @click="showForm = !showForm">
      {{ showForm ? "Cancel" : "+ Add Project" }}
    </button>

    <!-- Create form -->
    <form v-if="showForm" class="form" @submit.prevent="onCreate">
      <input v-model="formName" placeholder="Project name" required />
      <div class="input-row">
        <input v-model="formRoot" :placeholder="createRootPlaceholder" required />
        <button type="button" class="detect-btn" :disabled="detecting" @click="detectFromTerminal">
          {{ detecting ? "..." : "Detect" }}
        </button>
      </div>
      <div class="platform-row">
        <label class="radio-label"><input type="radio" v-model="formPlatform" value="wsl" /> WSL</label>
        <label class="radio-label"><input type="radio" v-model="formPlatform" value="windows" /> Windows</label>
      </div>
      <select v-if="formPlatform === 'wsl'" v-model="formDistro">
        <option v-for="d in distros" :key="d" :value="d">{{ d }}</option>
      </select>
      <select v-if="formPlatform === 'windows'" v-model="formWindowsShell">
        <option v-for="s in WINDOWS_SHELLS" :key="s.kind" :value="s.kind">{{ s.label }}</option>
      </select>
      <button type="submit">Create</button>
    </form>

    <!-- Project list -->
    <div class="project-list">
      <template v-for="project in projectStore.projects" :key="project.id">
        <!-- Edit mode -->
        <div v-if="editingId === project.id" class="edit-form">
          <input v-model="editName" placeholder="Project name" />
          <input v-model="editRoot" :placeholder="editRootPlaceholder" />
          <div class="platform-row">
            <label class="radio-label"><input type="radio" v-model="editPlatform" value="wsl" /> WSL</label>
            <label class="radio-label"><input type="radio" v-model="editPlatform" value="windows" /> Windows</label>
          </div>
          <select v-if="editPlatform === 'wsl'" v-model="editDistro">
            <option v-for="d in distros" :key="d" :value="d">{{ d }}</option>
          </select>
          <select v-if="editPlatform === 'windows'" v-model="editWindowsShell">
            <option value="cmd">Command Prompt</option>
            <option value="powershell">PowerShell</option>
            <option value="git-bash">Git Bash</option>
          </select>
          <div class="edit-actions">
            <button type="button" class="save-btn" @click="onSaveEdit">Save</button>
            <button type="button" class="cancel-btn" @click="cancelEdit">Cancel</button>
          </div>
        </div>

        <!-- Display mode -->
        <div
          v-else
          class="project-item"
          :class="{ active: projectStore.currentProject?.id === project.id }"
          @click="projectStore.switchProject(project.id)"
        >
          <div class="project-name">{{ project.name }}</div>
          <div class="project-meta">
            <span class="project-root">{{ project.root }}</span>
            <span class="project-shell">{{ shellLabel(project.shell) }}</span>
          </div>
          <div class="item-actions">
            <button class="action-btn" title="Edit" @click.stop="startEdit(project)">e</button>
            <button class="action-btn danger" title="Delete" @click.stop="onDelete(project.id)">x</button>
          </div>
        </div>
      </template>
    </div>

    <div v-if="projectStore.projects.length === 0 && !showForm" class="empty">
      No projects yet
    </div>
  </div>
</template>

<style scoped>
.project-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.add-btn {
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.add-btn:hover {
  background: var(--tab-hover-bg);
}

.form,
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.edit-form {
  padding: 8px;
  background: var(--bg-tertiary);
  border-radius: 3px;
}

.form input,
.form select,
.edit-form input,
.edit-form select {
  padding: 4px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
  outline: none;
}

.form input:focus,
.form select:focus,
.edit-form input:focus,
.edit-form select:focus {
  border-color: var(--accent);
}

.form > button[type="submit"] {
  padding: 4px 8px;
  border: none;
  background: var(--accent);
  color: var(--text-active);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.input-row {
  display: flex;
  gap: 4px;
}

.input-row input {
  flex: 1;
  min-width: 0;
}

.platform-row {
  display: flex;
  gap: 12px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
}

.radio-label input {
  accent-color: var(--accent);
}

.detect-btn {
  padding: 4px 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
  white-space: nowrap;
  flex-shrink: 0;
}

.detect-btn:hover:not(:disabled) {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
}

.detect-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.edit-actions {
  display: flex;
  gap: 4px;
}

.save-btn {
  flex: 1;
  padding: 4px 8px;
  border: none;
  background: var(--accent);
  color: var(--text-active);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.cancel-btn {
  padding: 4px 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.cancel-btn:hover {
  color: var(--text-primary);
  background: var(--tab-hover-bg);
}

.project-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.project-item {
  position: relative;
  padding: 8px;
  padding-right: 48px;
  border-radius: 3px;
  cursor: pointer;
}

.project-item:hover {
  background: var(--tab-hover-bg);
}

.project-item.active {
  background: var(--bg-tertiary);
  border-left: 2px solid var(--accent);
}

.project-name {
  font-size: 13px;
  color: var(--text-primary);
}

.project-meta {
  display: flex;
  gap: 8px;
  align-items: center;
}

.project-root {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.project-shell {
  font-size: 10px;
  color: var(--text-secondary);
  opacity: 0.7;
  flex-shrink: 0;
}

.item-actions {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  display: flex;
  gap: 2px;
  opacity: 0;
}

.project-item:hover .item-actions {
  opacity: 1;
}

.action-btn {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: monospace;
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.action-btn:hover {
  background: var(--accent);
  color: var(--text-active);
}

.action-btn.danger:hover {
  background: var(--danger);
}

.empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
}
</style>
