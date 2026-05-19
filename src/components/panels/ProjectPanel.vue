<script setup lang="ts">
import { ChevronDown, ChevronRight, ExternalLink, Pencil, Plus, Trash2, X } from 'lucide-vue-next'
import { computed, onMounted, ref, watch } from 'vue'
import { confirmDialog } from '../../composables/useConfirmDialog'
import { useI18n } from '../../i18n'
import { loadJson, saveJson } from '../../lib/storage'
import { detectWslDistros, openProjectWindow, pickFolder, ptyGetCwd } from '../../lib/tauri'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import type { ProjectConfig } from '../../types/project'
import {
  buildShell,
  rootPlaceholder as rootPlaceholderFn,
  shellLabel,
  shellToDistro,
  shellToPlatform,
  shellToWinKind,
  slugify,
  WINDOWS_SHELLS,
} from '../../types/tab'

const { t } = useI18n()

const projectStore = useProjectStore()
const tabStore = useTabStore()

const COLLAPSE_STORAGE_KEY = 'pike:project-group-collapsed'
const NEW_GROUP_TOKEN = '__new__'

const sortMode = ref<'name' | 'recent'>('name')

function sortByMode(list: ProjectConfig[]): ProjectConfig[] {
  const arr = [...list]
  if (sortMode.value === 'name') {
    arr.sort((a, b) => a.name.localeCompare(b.name))
  }
  return arr
}

const ungroupedProjects = computed<ProjectConfig[]>(() => {
  return sortByMode(projectStore.projects.filter((p) => !p.group?.trim()))
})

const groupSections = computed<Array<{ name: string; projects: ProjectConfig[] }>>(() => {
  return projectStore.groups.map((name) => ({
    name,
    projects: sortByMode(projectStore.projects.filter((p) => p.group?.trim() === name)),
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

function setRenameInputRef(el: Element | unknown) {
  const input = el as HTMLInputElement | null
  if (input) {
    input.focus()
    input.select()
  }
}

function startRenameGroup(name: string) {
  renamingGroup.value = name
  renameValue.value = name
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

const draggingProjectId = ref<string | null>(null)
const dragOverGroup = ref<string | null>(null)

function onDragStartProject(e: DragEvent, projectId: string) {
  draggingProjectId.value = projectId
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', projectId)
  }
}

function onDragEndProject() {
  draggingProjectId.value = null
  dragOverGroup.value = null
}

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
  draggingProjectId.value = null
  dragOverGroup.value = null
  if (!id) return
  await projectStore.setProjectGroup(id, groupName || undefined)
}

const distros = ref<string[]>([])
const detecting = ref(false)

onMounted(async () => {
  await projectStore.loadProjects()
  await projectStore.loadGroups()
  try {
    distros.value = await detectWslDistros()
    if (distros.value.length > 0) {
      formDistro.value = distros.value[0]
    }
  } catch {
    distros.value = ['Ubuntu']
  }
})

// --- Create form ---
const showForm = ref(false)
const formName = ref('')
const formRoot = ref('')
const formGroupSelect = ref('') // '' = none, NEW_GROUP_TOKEN = new mode, otherwise group name
const formGroupNew = ref('')
const formPlatform = ref<'wsl' | 'windows'>('wsl')
const formDistro = ref('Ubuntu')
const formWindowsShell = ref<'cmd' | 'powershell' | 'git-bash'>('powershell')

const createRootPlaceholder = computed(() => rootPlaceholderFn(formPlatform.value))

watch(showForm, async (show) => {
  if (show) await detectFromTerminal()
})

function resolvedGroup(select: string, newName: string): string | undefined {
  if (select === NEW_GROUP_TOKEN) {
    const trimmed = newName.trim()
    return trimmed ? trimmed : undefined
  }
  const trimmed = select.trim()
  return trimmed ? trimmed : undefined
}

async function detectFromTerminal() {
  const activeTab = tabStore.activeTab
  if (!activeTab || activeTab.kind !== 'terminal' || !activeTab.ptyId) return

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

async function browseFolder(target: 'create' | 'edit') {
  const folder = await pickFolder()
  if (!folder) return
  if (target === 'create') {
    formRoot.value = folder
    if (!formName.value) {
      formName.value = folder.split(/[/\\]/).filter(Boolean).pop() ?? ''
    }
  } else {
    editRoot.value = folder
  }
}

async function onCreate() {
  const id = slugify(formName.value)
  if (!id) return
  const group = resolvedGroup(formGroupSelect.value, formGroupNew.value)
  const config: ProjectConfig = {
    id,
    name: formName.value,
    root: formRoot.value,
    shell: buildShell(formPlatform.value, formDistro.value, formWindowsShell.value),
    pinnedTabs: [],
    lastOpened: new Date().toISOString(),
    group,
  }
  await projectStore.addProject(config)
  if (group) await projectStore.addGroup(group)
  showForm.value = false
  formName.value = ''
  formRoot.value = ''
  formGroupSelect.value = ''
  formGroupNew.value = ''
}

const editingId = ref<string | null>(null)
const editName = ref('')
const editRoot = ref('')
const editGroupSelect = ref('')
const editGroupNew = ref('')
const editPlatform = ref<'wsl' | 'windows'>('wsl')
const editDistro = ref('Ubuntu')
const editWindowsShell = ref<'cmd' | 'powershell' | 'git-bash'>('powershell')

const editRootPlaceholder = computed(() => rootPlaceholderFn(editPlatform.value))

function startEdit(project: ProjectConfig) {
  editingId.value = project.id
  editName.value = project.name
  editRoot.value = project.root
  const g = project.group?.trim() ?? ''
  editGroupSelect.value = g
  editGroupNew.value = ''
  editPlatform.value = shellToPlatform(project.shell)
  editDistro.value = shellToDistro(project.shell)
  editWindowsShell.value = shellToWinKind(project.shell)
}

function cancelEdit() {
  editingId.value = null
}

async function onSaveEdit() {
  if (!editingId.value) return
  const existing = projectStore.projects.find((p) => p.id === editingId.value)
  if (!existing) return

  const group = resolvedGroup(editGroupSelect.value, editGroupNew.value)
  const updated: ProjectConfig = {
    ...existing,
    name: editName.value,
    root: editRoot.value,
    shell: buildShell(editPlatform.value, editDistro.value, editWindowsShell.value),
    group,
  }
  await projectStore.saveProject(updated)
  if (group) await projectStore.addGroup(group)
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
        <button v-if="formPlatform === 'windows'" type="button" class="detect-btn" @click="browseFolder('create')">
          {{ t('project.browse') }}
        </button>
        <button v-if="formPlatform === 'wsl'" type="button" class="detect-btn" :disabled="detecting" @click="detectFromTerminal">
          {{ detecting ? "..." : t('project.detect') }}
        </button>
      </div>

      <div class="group-combo">
        <select v-if="formGroupSelect !== NEW_GROUP_TOKEN" v-model="formGroupSelect">
          <option value="">{{ t('project.groupSelectNone') }}</option>
          <option v-for="g in projectStore.groups" :key="g" :value="g">{{ g }}</option>
          <option :value="NEW_GROUP_TOKEN">{{ t('project.groupSelectNew') }}</option>
        </select>
        <div v-else class="combo-new">
          <input
            :ref="focusOnMount"
            v-model="formGroupNew"
            :placeholder="t('project.groupNewPlaceholder')"
          />
          <button type="button" class="combo-cancel" @click="formGroupSelect = ''; formGroupNew = ''">
            <X :size="12" :stroke-width="2" />
          </button>
        </div>
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
      <button type="submit">{{ t('common.create') }}</button>
    </form>

    <div class="sort-row">
      <button class="sort-btn" :class="{ active: sortMode === 'name' }" @click="sortMode = 'name'">{{ t('project.sortName') }}</button>
      <button class="sort-btn" :class="{ active: sortMode === 'recent' }" @click="sortMode = 'recent'">{{ t('project.sortRecent') }}</button>
    </div>

    <div class="project-list">
      <template v-for="project in ungroupedProjects" :key="project.id">
        <div v-if="editingId === project.id" class="edit-form">
          <input v-model="editName" :placeholder="t('project.projectName')" />
          <div class="input-row">
            <input v-model="editRoot" :placeholder="editRootPlaceholder" />
            <button v-if="editPlatform === 'windows'" type="button" class="detect-btn" @click="browseFolder('edit')">
              {{ t('project.browse') }}
            </button>
          </div>
          <div class="group-combo">
            <select v-if="editGroupSelect !== NEW_GROUP_TOKEN" v-model="editGroupSelect">
              <option value="">{{ t('project.groupSelectNone') }}</option>
              <option v-for="g in projectStore.groups" :key="g" :value="g">{{ g }}</option>
              <option :value="NEW_GROUP_TOKEN">{{ t('project.groupSelectNew') }}</option>
            </select>
            <div v-else class="combo-new">
              <input :ref="focusOnMount" v-model="editGroupNew" :placeholder="t('project.groupNewPlaceholder')" />
              <button type="button" class="combo-cancel" @click="editGroupSelect = ''; editGroupNew = ''">
                <X :size="12" :stroke-width="2" />
              </button>
            </div>
          </div>
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
            <button type="button" class="save-btn" @click="onSaveEdit">{{ t('common.save') }}</button>
            <button type="button" class="cancel-btn" @click="cancelEdit">{{ t('common.cancel') }}</button>
          </div>
        </div>
        <div
          v-else
          class="project-item"
          :class="{
            active: projectStore.currentProject?.id === project.id,
            dragging: draggingProjectId === project.id,
          }"
          draggable="true"
          @dragstart="onDragStartProject($event, project.id)"
          @dragend="onDragEndProject"
          @click="projectStore.switchProject(project.id)"
        >
          <div class="project-name">{{ project.name }}</div>
          <div class="project-meta">
            <span class="project-root">{{ project.root }}</span>
            <span class="project-shell">{{ shellLabel(project.shell) }}</span>
          </div>
          <div class="item-actions">
            <button class="action-btn" :title="t('project.openInNewWindow')" @click.stop="openProjectWindow(project.id)"><ExternalLink :size="12" :stroke-width="2" /></button>
            <button class="action-btn" :title="t('project.edit')" @click.stop="startEdit(project)"><Pencil :size="12" :stroke-width="2" /></button>
            <button class="action-btn danger" :title="t('common.delete')" @click.stop="onDelete(project.id)"><Trash2 :size="12" :stroke-width="2" /></button>
          </div>
        </div>
      </template>

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
          <template v-for="project in group.projects" :key="project.id">
            <div v-if="editingId === project.id" class="edit-form">
              <input v-model="editName" :placeholder="t('project.projectName')" />
              <div class="input-row">
                <input v-model="editRoot" :placeholder="editRootPlaceholder" />
                <button v-if="editPlatform === 'windows'" type="button" class="detect-btn" @click="browseFolder('edit')">
                  {{ t('project.browse') }}
                </button>
              </div>
              <div class="group-combo">
                <select v-if="editGroupSelect !== NEW_GROUP_TOKEN" v-model="editGroupSelect">
                  <option value="">{{ t('project.groupSelectNone') }}</option>
                  <option v-for="g in projectStore.groups" :key="g" :value="g">{{ g }}</option>
                  <option :value="NEW_GROUP_TOKEN">{{ t('project.groupSelectNew') }}</option>
                </select>
                <div v-else class="combo-new">
                  <input :ref="focusOnMount" v-model="editGroupNew" :placeholder="t('project.groupNewPlaceholder')" />
                  <button type="button" class="combo-cancel" @click="editGroupSelect = ''; editGroupNew = ''">
                    <X :size="12" :stroke-width="2" />
                  </button>
                </div>
              </div>
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
                <button type="button" class="save-btn" @click="onSaveEdit">{{ t('common.save') }}</button>
                <button type="button" class="cancel-btn" @click="cancelEdit">{{ t('common.cancel') }}</button>
              </div>
            </div>

            <div
              v-else
              class="project-item grouped"
              :class="{
                active: projectStore.currentProject?.id === project.id,
                dragging: draggingProjectId === project.id,
              }"
              draggable="true"
              @dragstart="onDragStartProject($event, project.id)"
              @dragend="onDragEndProject"
              @click="projectStore.switchProject(project.id)"
            >
              <div class="project-name">{{ project.name }}</div>
              <div class="project-meta">
                <span class="project-root">{{ project.root }}</span>
                <span class="project-shell">{{ shellLabel(project.shell) }}</span>
              </div>
              <div class="item-actions">
                <button class="action-btn" :title="t('project.openInNewWindow')" @click.stop="openProjectWindow(project.id)"><ExternalLink :size="12" :stroke-width="2" /></button>
                <button class="action-btn" :title="t('project.edit')" @click.stop="startEdit(project)"><Pencil :size="12" :stroke-width="2" /></button>
                <button class="action-btn danger" :title="t('common.delete')" @click.stop="onDelete(project.id)"><Trash2 :size="12" :stroke-width="2" /></button>
              </div>
            </div>
          </template>
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

    <div v-if="projectStore.projects.length === 0 && !showForm" class="empty">
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

.group-combo {
  display: flex;
}

.group-combo select {
  flex: 1;
}

.combo-new {
  display: flex;
  gap: 4px;
  flex: 1;
}

.combo-new input {
  flex: 1;
  min-width: 0;
}

.combo-cancel {
  width: 24px;
  padding: 0;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.combo-cancel:hover {
  background: var(--tab-hover-bg);
  color: var(--text-primary);
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

.project-item {
  position: relative;
  padding: 8px;
  padding-right: 64px;
  border-radius: 3px;
  cursor: pointer;
}

.project-item.grouped {
  padding-left: 16px;
}

.project-item:hover {
  background: var(--tab-hover-bg);
}

.project-item.active {
  background: var(--bg-tertiary);
  border-left: 2px solid var(--accent);
}

.project-item.dragging {
  opacity: 0.4;
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
