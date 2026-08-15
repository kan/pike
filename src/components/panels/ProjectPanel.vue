<script setup lang="ts">
import { BookmarkPlus, ChevronDown, ChevronRight, Pencil, Plus, Search, X } from 'lucide-vue-next'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { confirmDialog } from '../../composables/useConfirmDialog'
import { useDragAndDrop } from '../../composables/useDragAndDrop'
import { useI18n } from '../../i18n'
import { fuzzyMatch } from '../../lib/paths'
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
import IconSelect from './IconSelect.vue'
import ProjectListItem from './ProjectListItem.vue'

const { t } = useI18n()

const projectStore = useProjectStore()
const tabStore = useTabStore()
const settings = useSettingsStore()

const COLLAPSE_STORAGE_KEY = 'pike:project-group-collapsed'
const SORT_STORAGE_KEY = 'pike:project-sort-mode'

/** `recent` is a flat list in the backend's recency order; `group` is the
 *  organized view, ordered by hand (#203). */
type SortMode = 'recent' | 'group'

const sortMode = ref<SortMode>(loadJson<SortMode>(SORT_STORAGE_KEY, 'group') === 'recent' ? 'recent' : 'group')
watch(sortMode, (mode) => saveJson(SORT_STORAGE_KEY, mode))

const filterQuery = ref('')
const filterText = computed(() => filterQuery.value.trim())

function matchesFilter(p: ProjectConfig): boolean {
  const q = filterText.value
  if (!q) return true
  return fuzzyMatch(p.name, q) || fuzzyMatch(p.root, q) || fuzzyMatch(p.group ?? '', q)
}

const filteredProjects = computed<ProjectConfig[]>(() => projectStore.visibleProjects.filter(matchesFilter))

/** Manual order first, then name for everything never dragged. */
function sortByOrder(list: ProjectConfig[]): ProjectConfig[] {
  return [...list].sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name),
  )
}

const ungroupedProjects = computed<ProjectConfig[]>(() => {
  return sortByOrder(filteredProjects.value.filter((p) => !p.group?.trim()))
})

/** One flat list of what the panel renders, so the row bindings live in a
 *  single place instead of once per section. `siblings` is the reorder scope a
 *  drop onto this row lands in. */
type PanelRow =
  | { kind: 'group'; name: string; count: number }
  | {
      kind: 'project'
      project: ProjectConfig
      grouped: boolean
      /** Absent in recent mode, which has no reorder scope. */
      siblings?: ProjectConfig[]
      groupLabel?: string
    }

const groupSections = computed<Array<{ name: string; projects: ProjectConfig[] }>>(() => {
  const sections = projectStore.groups.map((name) => ({
    name,
    projects: sortByOrder(filteredProjects.value.filter((p) => p.group?.trim() === name)),
  }))
  // While filtering, a group with no hit is noise.
  return filterText.value ? sections.filter((s) => s.projects.length > 0) : sections
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

const rows = computed<PanelRow[]>(() => {
  // Recent mode is deliberately flat (#203): the group is a badge on the row,
  // not a section, so the list stays in one recency order.
  if (sortMode.value === 'recent') {
    return filteredProjects.value.map((project) => ({
      kind: 'project',
      project,
      grouped: false,
      groupLabel: project.group?.trim() || undefined,
    }))
  }
  const out: PanelRow[] = ungroupedProjects.value.map((project) => ({
    kind: 'project',
    project,
    grouped: false,
    siblings: ungroupedProjects.value,
  }))
  for (const section of groupSections.value) {
    out.push({ kind: 'group', name: section.name, count: section.projects.length })
    if (isCollapsed(section.name)) continue
    for (const project of section.projects) {
      out.push({ kind: 'project', project, grouped: true, siblings: section.projects })
    }
  }
  return out
})

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

// Drag & drop (#203). One drag id carries both kinds so the shared composable
// stays as-is; the template-literal type keeps the two spellings honest, and
// `projectKey`/`groupKey` are the only place they are built. Read back with a
// prefix strip rather than a split: a group name may itself contain ':'.
type DragKey = `project:${string}` | `group:${string}`
const PROJECT_DRAG = 'project:'
const GROUP_DRAG = 'group:'

const projectKey = (id: string): DragKey => `${PROJECT_DRAG}${id}`
const groupKey = (name: string): DragKey => `${GROUP_DRAG}${name}`

const { dragId, startDrag, resetDrag } = useDragAndDrop<DragKey>()
// One hover state instead of the composable's target plus a side ref: they are
// always written and cleared together.
const dropTarget = ref<{ key: DragKey; side: 'top' | 'bottom' | null } | null>(null)

/** Rows and group bars are only draggable in the organized view. */
const dragEnabled = computed(() => sortMode.value === 'group')
/** Insertion (reordering) additionally needs the unfiltered list: indexes taken
 *  from a filtered view would place the row somewhere else entirely. */
const reorderable = computed(() => dragEnabled.value && !filterText.value)

const draggedProject = computed(() =>
  dragId.value?.startsWith(PROJECT_DRAG) ? dragId.value.slice(PROJECT_DRAG.length) : null,
)
const draggedGroup = computed(() =>
  dragId.value?.startsWith(GROUP_DRAG) ? dragId.value.slice(GROUP_DRAG.length) : null,
)

function endDrag() {
  resetDrag()
  dropTarget.value = null
}

/** Which half of the hovered element the pointer is in (TabPane's insertion
 *  point logic, vertical). */
function sideOf(e: DragEvent): 'top' | 'bottom' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom'
}

/** `ids` with `moved` taken out and put back at the drop point. Removing first
 *  means the target index needs no correction for the direction of the move. */
function insertAt(ids: string[], moved: string, target: string, side: 'top' | 'bottom'): string[] {
  const rest = ids.filter((id) => id !== moved)
  const at = rest.indexOf(target)
  if (at === -1) return [...rest, moved]
  rest.splice(side === 'bottom' ? at + 1 : at, 0, moved)
  return rest
}

function markDropTarget(e: DragEvent, key: DragKey, side: 'top' | 'bottom' | null) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  // Only assign on a real change: dragover fires continuously, and a fresh
  // object every tick would re-render the list at event rate.
  if (dropTarget.value?.key !== key || dropTarget.value.side !== side) {
    dropTarget.value = { key, side }
  }
}

function onRowDragOver(e: DragEvent, project: ProjectConfig) {
  if (!reorderable.value || !draggedProject.value) return
  markDropTarget(e, projectKey(project.id), sideOf(e))
}

function dropSideFor(key: DragKey): 'top' | 'bottom' | null {
  return dropTarget.value?.key === key ? dropTarget.value.side : null
}

/** Marker classes for a group bar: an insertion line for a dragged group, the
 *  plain highlight for a dragged project. */
function dropClasses(key: DragKey) {
  const side = dropSideFor(key)
  return {
    'drag-over': dropTarget.value?.key === key && !side,
    'drop-top': side === 'top',
    'drop-bottom': side === 'bottom',
  }
}

/** Drop onto a row: place the dragged project there, adopting the row's group. */
async function onRowDrop(e: DragEvent, project: ProjectConfig, siblings: ProjectConfig[]) {
  e.preventDefault()
  const moved = draggedProject.value
  const side = dropTarget.value?.side ?? 'bottom'
  endDrag()
  if (!moved || moved === project.id) return
  const ids = insertAt(
    siblings.map((p) => p.id),
    moved,
    project.id,
    side,
  )
  await projectStore.reorderProjects(ids, project.group?.trim() || undefined)
}

function onDragOverGroup(e: DragEvent, groupName: string) {
  if (!dragId.value) return
  // A dragged group inserts before/after this bar; a dragged project just lands
  // in the group, so it gets the plain highlight instead of an insertion line.
  markDropTarget(e, groupKey(groupName), draggedGroup.value ? sideOf(e) : null)
}

function onDragLeaveGroup() {
  dropTarget.value = null
}

async function onDropGroup(e: DragEvent, groupName: string) {
  e.preventDefault()
  const movedGroup = draggedGroup.value
  const movedProject = draggedProject.value
  const side = dropTarget.value?.side ?? 'bottom'
  endDrag()
  if (movedGroup) {
    if (!reorderable.value || movedGroup === groupName) return
    await projectStore.reorderGroups(insertAt([...projectStore.groups], movedGroup, groupName, side))
    return
  }
  if (!movedProject) return
  if (!reorderable.value) {
    await projectStore.setProjectGroup(movedProject, groupName || undefined)
    return
  }
  // The bar is the "put it in this group" target; the rows place it precisely.
  const ids = groupSections.value.find((s) => s.name === groupName)?.projects.map((p) => p.id) ?? []
  await projectStore.reorderProjects([...ids.filter((id) => id !== movedProject), movedProject], groupName)
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
const formIcon = ref<string | undefined>(undefined)
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
    icon: formIcon.value,
  }
  await projectStore.addProject(config)
  if (formGroup.value) await projectStore.addGroup(formGroup.value)
  showForm.value = false
  formName.value = ''
  formRoot.value = ''
  formGroup.value = undefined
  formColor.value = undefined
  formIcon.value = undefined
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
  <div class="project-panel" data-testid="project-panel">
    <!-- Directory opened without registering it (#230): the way back in. -->
    <div v-if="projectStore.isTransient" class="transient-bar">
      <div class="transient-root" :title="projectStore.currentProject?.root">
        {{ projectStore.currentProject?.root }}
      </div>
      <button class="add-btn transient-register" data-testid="register-directory" @click="projectStore.registerTransientProject()">
        <BookmarkPlus :size="14" :stroke-width="2" />{{ t('project.registerDirectory') }}
      </button>
    </div>

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
      <IconSelect v-model="formIcon" />

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

    <div class="filter-row">
      <Search :size="12" :stroke-width="2" class="filter-icon" />
      <input
        v-model="filterQuery"
        class="filter-input"
        :placeholder="t('project.filterPlaceholder')"
        @keydown.escape.prevent="filterQuery = ''"
      />
      <button v-if="filterQuery" class="filter-clear" :title="t('common.clear')" @click="filterQuery = ''">
        <X :size="12" :stroke-width="2" />
      </button>
    </div>

    <div class="sort-row">
      <button class="sort-btn" :class="{ active: sortMode === 'group' }" @click="sortMode = 'group'">{{ t('project.sortGroup') }}</button>
      <button class="sort-btn" :class="{ active: sortMode === 'recent' }" @click="sortMode = 'recent'">{{ t('project.sortRecent') }}</button>
    </div>

    <div class="project-list">
      <template v-for="row in rows" :key="row.kind === 'group' ? `group:${row.name}` : row.project.id">
        <div
          v-if="row.kind === 'group'"
          class="group-header"
          :class="dropClasses(groupKey(row.name))"
          :draggable="dragEnabled && renamingGroup !== row.name"
          @dragstart="startDrag($event, groupKey(row.name))"
          @dragend="endDrag"
          @dragover="onDragOverGroup($event, row.name)"
          @dragleave="onDragLeaveGroup"
          @drop="onDropGroup($event, row.name)"
        >
          <button class="group-toggle" @click="toggleGroup(row.name)">
            <ChevronDown v-if="!isCollapsed(row.name)" :size="12" :stroke-width="2" />
            <ChevronRight v-else :size="12" :stroke-width="2" />
            <span v-if="renamingGroup !== row.name" class="group-name">{{ row.name }}</span>
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
            <span class="group-count">{{ row.count }}</span>
          </button>
          <template v-if="renamingGroup !== row.name">
            <button class="group-action-btn" :title="t('project.renameGroup')" @click.stop="startRenameGroup(row.name)">
              <Pencil :size="11" :stroke-width="2" />
            </button>
            <button class="group-action-btn danger" :title="t('project.deleteGroup')" @click.stop="onDeleteGroup(row.name)">
              <X :size="12" :stroke-width="2" />
            </button>
          </template>
        </div>

        <ProjectListItem
          v-else
          :project="row.project"
          :editing="editingId === row.project.id"
          :grouped="row.grouped"
          :active="projectStore.currentProject?.id === row.project.id"
          :dragging="draggedProject === row.project.id"
          :missing="projectStore.missingRoots.has(row.project.id)"
          :groups="projectStore.groups"
          :distros="distros"
          :group-label="row.groupLabel"
          :draggable-row="dragEnabled"
          :drop-side="dropSideFor(projectKey(row.project.id))"
          @select="projectStore.openProject(row.project.id, 'focusOrSwitch')"
          @open-window="projectStore.openProject(row.project.id, 'window')"
          @request-edit="editingId = row.project.id"
          @cancel-edit="editingId = null"
          @save="onSaveEdit"
          @clone="projectStore.cloneProject(row.project.id)"
          @delete="onDelete(row.project.id)"
          @drag-start="startDrag($event, projectKey(row.project.id))"
          @drag-end="endDrag"
          @drag-over="onRowDragOver($event, row.project)"
          @drop="onRowDrop($event, row.project, row.siblings ?? [])"
        />
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
    <div v-else-if="filterText && filteredProjects.length === 0" class="empty">
      {{ t('project.noMatch') }}
    </div>
  </div>
</template>

<style scoped>
.project-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.transient-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  margin-bottom: 8px;
  border: 1px dashed var(--border);
  border-radius: 3px;
  background: var(--bg-tertiary);
}

.transient-root {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

/* Same geometry as .add-btn; the accent edge is the deliberate difference. */
.transient-register {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-color: var(--accent);
  color: var(--accent);
}

.transient-register:hover {
  background: var(--accent);
  color: var(--text-active);
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

.filter-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  border-radius: 3px;
}

.filter-row:focus-within {
  border-color: var(--accent);
}

.filter-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.filter-input {
  flex: 1;
  min-width: 0;
  padding: 4px 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.filter-clear {
  display: flex;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
}

.filter-clear:hover {
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

/* A heading, not an accent: the accent left line is reserved for "this project
   is open in this window" (#203), which the two used to share. */
.group-header {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
  padding: 0 2px 0 6px;
  border-radius: 3px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  transition: background 0.1s, border-color 0.1s;
}

.group-header.drag-over {
  background: color-mix(in srgb, var(--accent) 30%, var(--bg-tertiary));
  border-color: var(--accent);
}

.group-header.drop-top {
  box-shadow: inset 0 2px 0 var(--accent);
}

.group-header.drop-bottom {
  box-shadow: inset 0 -2px 0 var(--accent);
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
  /* グループ名はユーザーが決めた文字列なので、見出しでも入力欄でも打ったとおりに
     出す。大文字化していたころは faber と FABER の区別が画面上で付かなかった */
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
