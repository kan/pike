<script setup lang="ts">
import { ChevronDown, ChevronRight, Pencil, Plus, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { confirmDialog } from '../../composables/useConfirmDialog'
import { useDragAndDrop } from '../../composables/useDragAndDrop'
import { useI18n } from '../../i18n'
import { loadJson, saveJson } from '../../lib/storage'
import { detectWslDistros, pickFolder, ptyGetCwd } from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import type { ProjectConfig } from '../../types/project'
import {
  buildShell,
  rootPlaceholder as rootPlaceholderFn,
  shellToDistro,
  shellToPlatform,
  shellToWinKind,
  slugify,
  type WindowsShellKind,
} from '../../types/tab'
import ColorSelect from './ColorSelect.vue'
import GroupComboBox from './GroupComboBox.vue'
import ProjectListItem from './ProjectListItem.vue'

const { t } = useI18n()

const projectStore = useProjectStore()
const tabStore = useTabStore()
const settings = useSettingsStore()

const COLLAPSE_STORAGE_KEY = 'pike:project-group-collapsed'

const sortMode = ref<'name' | 'recent'>('name')

function sortByMode(list: ProjectConfig[]): ProjectConfig[] {
  const arr = [...list]
  if (sortMode.value === 'name') {
    arr.sort((a, b) => a.name.localeCompare(b.name))
  }
  return arr
}

const ungroupedProjects = computed<ProjectConfig[]>(() => {
  return sortByMode(projectStore.visibleProjects.filter((p) => !p.group?.trim()))
})

const groupSections = computed<Array<{ name: string; projects: ProjectConfig[] }>>(() => {
  return projectStore.groups.map((name) => ({
    name,
    projects: sortByMode(projectStore.visibleProjects.filter((p) => p.group?.trim() === name)),
  }))
})

const collapsed = ref<Set<string>>(new Set(loadJson<string[]>(COLLAPSE_STORAGE_KEY, [])))

function persistCollapsed() {
  saveJson(COLLAPSE_STORAGE_KEY, Array.from(collapsed.value))
}

function isCollapsed(name: string): boolean {
  return collapsed.value.has(name)
}

function toggleGroup(name: string) {
  const next = new Set(collapsed.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  collapsed.value = next
  persistCollapsed()
}

function focusOnMount(el: Element | unknown) {
  ;(el as HTMLInputElement | null)?.focus()
}

const renamingGroup = ref<string | null>(null)
const renameValue = ref('')
const renameInputEl = ref<HTMLInputElement>()

function setRenameInputRef(el: Element | unknown) {
  renameInputEl.value = (el as HTMLInputElement | null) ?? undefined
}

async function startRenameGroup(name: string) {
  renamingGroup.value = name
  renameValue.value = name
  await nextTick()
  renameInputEl.value?.focus()
  renameInputEl.value?.select()
}

async function commitRenameGroup() {
  const oldName = renamingGroup.value
  if (!oldName) return
  const newName = renameValue.value.trim()
  renamingGroup.value = null
  if (!newName || newName === oldName) return
  await projectStore.renameGroup(oldName, newName)
}

function cancelRenameGroup() {
  renamingGroup.value = null
}

const showAddGroup = ref(false)
const newGroupName = ref('')

function openAddGroup() {
  showAddGroup.value = true
  newGroupName.value = ''
}

async function commitAddGroup() {
  const name = newGroupName.value.trim()
  showAddGroup.value = false
  newGroupName.value = ''
  if (!name) return
  await projectStore.addGroup(name)
}

function cancelAddGroup() {
  showAddGroup.value = false
  newGroupName.value = ''
}

async function onDeleteGroup(name: string) {
  if (!(await confirmDialog(t('project.confirmDeleteGroup', { name })))) return
  if (collapsed.value.has(name)) {
    const next = new Set(collapsed.value)
    next.delete(name)
    collapsed.value = next
    persistCollapsed()
  }
  await projectStore.removeGroup(name)
}

const {
  dragId: draggingProjectId,
  dragOverTarget: dragOverGroup,
  startDrag: onDragStartProject,
  resetDrag: onDragEndProject,
} = useDragAndDrop<string>()

function onDragOverGroup(e: DragEvent, groupName: string) {
  if (!draggingProjectId.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverGroup.value = groupName
}

function onDragLeaveGroup() {
  dragOverGroup.value = null
}

async function onDropGroup(e: DragEvent, groupName: string) {
  e.preventDefault()
  const id = draggingProjectId.value
  onDragEndProject()
  if (!id) return
  await projectStore.setProjectGroup(id, groupName || undefined)
}

const distros = ref<string[]>([])
const detecting = ref(false)

onMounted(async () => {
  await projectStore.loadProjects()
  // Re-stat the roots when the panel opens (#164), so a checkout cloned or
  // moved outside Pike is picked up without polling on a timer. Rate-limited in
  // the store, and not awaited — the list renders while WSL probes run.
  projectStore.checkRoots().catch(() => {})
  await projectStore.loadGroups()
  try {
    distros.value = await detectWslDistros()
    settings.syncShellProfiles(distros.value)
    const visible = settings.visibleWslDistros(distros.value)
    if (visible.length > 0) {
      formDistro.value = visible[0]
    }
  } catch {
    distros.value = ['Ubuntu']
  }
  // Preselect a sensible, visible default (PowerShell if shown) for the create form
  formWindowsShell.value = settings.defaultWindowsShellKind()
})

// Dropdown options honor the shell profile visibility/order (#129); the
// current selection stays listed so the select never loses its value.
const formDistroOptions = computed(() => settings.visibleWslDistros(distros.value, formDistro.value))
const formShellOptions = computed(() => settings.windowsShellOptions(formWindowsShell.value))

const showForm = ref(false)
const formName = ref('')
const formRoot = ref('')
const formGroup = ref<string | undefined>(undefined)
const formColor = ref<string | undefined>(undefined)
const formPlatform = ref<'wsl' | 'windows'>('wsl')
const formDistro = ref('Ubuntu')
const formWindowsShell = ref<WindowsShellKind>('powershell')

const createRootPlaceholder = computed(() => rootPlaceholderFn(formPlatform.value))

watch(showForm, async (show) => {
  if (show) await detectFromTerminal()
})

async function detectFromTerminal() {
  const activeTab = tabStore.activeTab
  if (activeTab?.kind !== 'terminal' || !activeTab.ptyId) return

  if (activeTab.shell) {
    formPlatform.value = shellToPlatform(activeTab.shell)
    formDistro.value = shellToDistro(activeTab.shell)
    formWindowsShell.value = shellToWinKind(activeTab.shell)
  }

  detecting.value = true
  try {
    const cwd = await ptyGetCwd(activeTab.ptyId)
    if (cwd) {
      formRoot.value = cwd
      if (!formName.value) {
        const sep = cwd.includes('\\') ? '\\' : '/'
        formName.value = cwd.split(sep).filter(Boolean).pop() ?? ''
      }
    }
  } finally {
    detecting.value = false
  }
}

async function browseCreateFolder() {
  const folder = await pickFolder()
  if (!folder) return
  formRoot.value = folder
  if (!formName.value) {
    formName.value = folder.split(/[/\\]/).filter(Boolean).pop() ?? ''
  }
}

async function onCreate() {
  const slug = slugify(formName.value)
  if (!slug) return
  const id = projectStore.uniqueProjectId(slug)
  const config: ProjectConfig = {
    id,
    name: formName.value,
    root: formRoot.value,
    shell: buildShell(formPlatform.value, formDistro.value, formWindowsShell.value),
    pinnedTabs: [],
    lastOpened: new Date().toISOString(),
    group: formGroup.value,
    color: formColor.value,
  }
  await projectStore.addProject(config)
  if (formGroup.value) await projectStore.addGroup(formGroup.value)
  showForm.value = false
  formName.value = ''
  formRoot.value = ''
  formGroup.value = undefined
  formColor.value = undefined
}

const editingId = ref<string | null>(null)

async function onSaveEdit(updated: ProjectConfig) {
  await projectStore.saveProject(updated)
  if (updated.group) await projectStore.addGroup(updated.group)
  editingId.value = null
}

async function onDelete(id: string) {
  const project = projectStore.projects.find((p) => p.id === id)
  if (!(await confirmDialog(t('project.confirmDelete', { name: project?.name ?? id })))) return
  await projectStore.removeProject(id)
  if (editingId.value === id) editingId.value = null
}
</script>

<template>
  <div class="project-panel">
    <button class="add-btn" @click="showForm = !showForm">
      {{ showForm ? t('common.cancel') : t('project.addProject') }}
    </button>

    <form v-if="showForm" class="form" @submit.prevent="onCreate">
      <input v-model="formName" :placeholder="t('project.projectName')" required />
      <div class="input-row">
        <input v-model="formRoot" :placeholder="createRootPlaceholder" required />
        <button v-if="formPlatform === 'windows'" type="button" class="detect-btn" @click="browseCreateFolder">
          {{ t('project.browse') }}
        </button>
        <button v-if="formPlatform === 'wsl'" type="button" class="detect-btn" :disabled="detecting" @click="detectFromTerminal">
          {{ detecting ? "..." : t('project.detect') }}
        </button>
      </div>

      <GroupComboBox v-model="formGroup" :groups="projectStore.groups" />
      <ColorSelect v-model="formColor" />

      <div class="platform-row">
        <label class="radio-label"><input type="radio" v-model="formPlatform" value="wsl" /> WSL</label>
        <label class="radio-label"><input type="radio" v-model="formPlatform" value="windows" /> Windows</label>
      </div>
      <select v-if="formPlatform === 'wsl'" v-model="formDistro">
        <option v-for="d in formDistroOptions" :key="d" :value="d">{{ d }}</option>
      </select>
      <select v-if="formPlatform === 'windows'" v-model="formWindowsShell">
        <option v-for="s in formShellOptions" :key="s.kind" :value="s.kind">{{ s.label }}</option>
      </select>
      <button type="submit">{{ t('common.create') }}</button>
    </form>

    <div class="sort-row">
      <button class="sort-btn" :class="{ active: sortMode === 'name' }" @click="sortMode = 'name'">{{ t('project.sortName') }}</button>
      <button class="sort-btn" :class="{ active: sortMode === 'recent' }" @click="sortMode = 'recent'">{{ t('project.sortRecent') }}</button>
    </div>

    <div class="project-list">
      <ProjectListItem
        v-for="project in ungroupedProjects"
        :key="project.id"
        :project="project"
        :editing="editingId === project.id"
        :grouped="false"
        :active="projectStore.currentProject?.id === project.id"
        :dragging="draggingProjectId === project.id"
        :missing="projectStore.missingRoots.has(project.id)"
        :groups="projectStore.groups"
        :distros="distros"
        @select="projectStore.switchProject(project.id)"
        @request-edit="editingId = project.id"
        @cancel-edit="editingId = null"
        @save="onSaveEdit"
        @clone="projectStore.cloneProject(project.id)"
        @delete="onDelete(project.id)"
        @drag-start="onDragStartProject($event, project.id)"
        @drag-end="onDragEndProject"
      />

      <template v-for="group in groupSections" :key="group.name">
        <div
          class="group-header"
          :class="{ 'drag-over': dragOverGroup === group.name }"
          @dragover="onDragOverGroup($event, group.name)"
          @dragleave="onDragLeaveGroup"
          @drop="onDropGroup($event, group.name)"
        >
          <button class="group-toggle" @click="toggleGroup(group.name)">
            <ChevronDown v-if="!isCollapsed(group.name)" :size="12" :stroke-width="2" />
            <ChevronRight v-else :size="12" :stroke-width="2" />
            <span v-if="renamingGroup !== group.name" class="group-name">{{ group.name }}</span>
            <input
              v-else
              :ref="setRenameInputRef"
              v-model="renameValue"
              class="group-rename-input"
              @click.stop
              @keydown.enter.prevent="commitRenameGroup"
              @keydown.escape.prevent="cancelRenameGroup"
              @blur="commitRenameGroup"
            />
            <span class="group-count">{{ group.projects.length }}</span>
          </button>
          <template v-if="renamingGroup !== group.name">
            <button class="group-action-btn" :title="t('project.renameGroup')" @click.stop="startRenameGroup(group.name)">
              <Pencil :size="11" :stroke-width="2" />
            </button>
            <button class="group-action-btn danger" :title="t('project.deleteGroup')" @click.stop="onDeleteGroup(group.name)">
              <X :size="12" :stroke-width="2" />
            </button>
          </template>
        </div>

        <template v-if="!isCollapsed(group.name)">
          <ProjectListItem
            v-for="project in group.projects"
            :key="project.id"
            :project="project"
            :editing="editingId === project.id"
            :grouped="true"
            :active="projectStore.currentProject?.id === project.id"
            :dragging="draggingProjectId === project.id"
            :missing="projectStore.missingRoots.has(project.id)"
            :groups="projectStore.groups"
            :distros="distros"
            @select="projectStore.switchProject(project.id)"
            @request-edit="editingId = project.id"
            @cancel-edit="editingId = null"
            @save="onSaveEdit"
            @clone="projectStore.cloneProject(project.id)"
            @delete="onDelete(project.id)"
            @drag-start="onDragStartProject($event, project.id)"
            @drag-end="onDragEndProject"
          />
        </template>
      </template>
      <div v-if="!showAddGroup" class="add-group-row">
        <button class="add-group-btn" @click="openAddGroup">
          <Plus :size="12" :stroke-width="2" /> {{ t('project.addGroup') }}
        </button>
      </div>
      <div v-else class="add-group-input-row">
        <input
          :ref="focusOnMount"
          v-model="newGroupName"
          :placeholder="t('project.groupNewPlaceholder')"
          @keydown.enter.prevent="commitAddGroup"
          @keydown.escape.prevent="cancelAddGroup"
          @blur="commitAddGroup"
        />
      </div>
    </div>

    <div v-if="projectStore.visibleProjects.length === 0 && !showForm" class="empty">
      {{ t('project.noProjects') }}
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

.form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form input,
.form select {
  padding: 4px 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
  outline: none;
}

.form input:focus,
.form select:focus {
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

.sort-row {
  display: flex;
  gap: 4px;
}

.sort-btn {
  padding: 2px 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
}

.sort-btn:hover {
  background: var(--tab-hover-bg);
}

.sort-btn.active {
  background: var(--accent);
  color: var(--text-active);
  border-color: var(--accent);
}

.project-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
  padding: 0 2px 0 6px;
  border-radius: 3px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  transition: background 0.1s, border-color 0.1s;
}

.group-header.drag-over {
  background: color-mix(in srgb, var(--accent) 30%, var(--bg-tertiary));
  border-color: var(--accent);
}

.group-toggle {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 4px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  border-radius: 3px;
  text-align: left;
  min-width: 0;
}

.group-toggle :deep(svg) {
  color: var(--accent);
  flex-shrink: 0;
}

.group-toggle:hover {
  color: var(--text-primary);
}

.group-toggle:hover .group-name {
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-underline-offset: 2px;
}

.group-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.group-count {
  color: var(--text-secondary);
  opacity: 0.7;
  font-weight: 400;
  font-size: 10px;
  flex-shrink: 0;
  padding: 1px 6px;
  background: var(--bg-primary);
  border-radius: 8px;
  min-width: 16px;
  text-align: center;
}

.group-rename-input {
  flex: 1;
  min-width: 0;
  padding: 2px 4px;
  border: 1px solid var(--accent);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: 3px;
  outline: none;
}

.group-action-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  flex-shrink: 0;
}

.group-header:hover .group-action-btn {
  opacity: 1;
}

.group-action-btn:hover {
  background: var(--accent);
  color: var(--text-active);
}

.group-action-btn.danger:hover {
  background: var(--danger);
}

.add-group-row {
  margin-top: 6px;
}

.add-group-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 6px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  border-radius: 3px;
}

.add-group-btn:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
  border-color: var(--accent);
}

.add-group-input-row {
  margin-top: 6px;
}

.add-group-input-row input {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--accent);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  border-radius: 3px;
  outline: none;
}

.empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
}
</style>
