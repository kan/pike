<script setup lang="ts">
import { FolderOpen, Globe } from 'lucide-vue-next'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import { defaultProjectPlatform } from '../lib/host'
import { hasMod } from '../lib/keys'
import { fuzzyMatch } from '../lib/paths'
import type { ProjectPlatform } from '../lib/projectPaths'
import { detectWslDistros, openGlobalWindow, pickFolder } from '../lib/tauri'
import { globalMode } from '../lib/window'
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import type { ProjectConfig } from '../types/project'
import { buildShell, rootPlaceholder as rootPlaceholderFn, slugify, type WindowsShellKind } from '../types/tab'
import ColorDot from './ColorDot.vue'
import ProjectIcon from './ProjectIcon.vue'
import ColorSelect from './panels/ColorSelect.vue'
import IconSelect from './panels/IconSelect.vue'
import ProjectPlatformFields from './panels/ProjectPlatformFields.vue'

const { t } = useI18n()
const projectStore = useProjectStore()
const settings = useSettingsStore()

/** Open a directory without registering it as a project (#230). The pick itself
 *  answers "register this?", so the store records the root and nothing asks. */
async function onOpenDirectory() {
  const path = await pickFolder()
  if (!path) return
  projectStore.showSwitcher = false
  await projectStore.openDirectory(path, globalMode.value ? 'window' : 'switch')
}

function enterGlobalMode() {
  projectStore.showSwitcher = false
  if (!globalMode.value && !projectStore.currentProject) {
    // Cold-start quick feed (project-less, non-global window): turn THIS window
    // into global mode. Start with one terminal on the configured global shell,
    // mirroring how a dedicated global terminal window opens.
    globalMode.value = true
    useTabStore().addTerminalTab({ shell: settings.globalShell })
  } else {
    // Opened over an active project, or already a global window: flipping in
    // place would drop the project context, so open a separate global window
    // and leave this one untouched.
    openGlobalWindow()
  }
}

// --- Search mode ---
const query = ref('')
const selectedIdx = ref(0)
const inputRef = ref<HTMLInputElement>()

const filtered = computed(() => {
  const q = query.value.trim()
  if (!q) return projectStore.visibleProjects
  return projectStore.visibleProjects.filter((p) => fuzzyMatch(p.name, q))
})

// --- New project form ---
const showNewForm = ref(false)
const formName = ref('')
const formRoot = ref('')
const formPlatform = ref<ProjectPlatform>(defaultProjectPlatform())
const formDistro = ref('Ubuntu')
const formWindowsShell = ref<WindowsShellKind>('powershell')
const formColor = ref<string | undefined>(undefined)
const formIcon = ref<string | undefined>(undefined)
const distros = ref<string[]>([])
const distrosLoaded = ref(false)

async function loadDistros() {
  if (distrosLoaded.value) return
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
  distrosLoaded.value = true
}

// Dropdown options honor the shell profile visibility/order (#129); the
// current selection stays listed so the select never loses its value.

function openNewForm() {
  formWindowsShell.value = settings.defaultWindowsShellKind()
  showNewForm.value = true
  loadDistros()
}

async function onCreateProject() {
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
    color: formColor.value,
    icon: formIcon.value,
  }

  await projectStore.addProject(config)
  // `placeProject`, not `openProject`: the root the user just typed may not
  // exist yet and a brand-new project has no origin, so the missing-root check
  // could only refuse to open what was asked for.
  await projectStore.placeProject(id, globalMode.value ? 'window' : 'switch')
  projectStore.showSwitcher = false
  resetForm()
}

/** Open the picked project: global-mode windows stay project-less, so the
 *  project always goes to its own window there. */
function selectProject(id: string, newWindow: boolean) {
  projectStore.showSwitcher = false
  projectStore.openProject(id, newWindow || globalMode.value ? 'window' : 'switch')
}

function resetForm() {
  showNewForm.value = false
  formName.value = ''
  formRoot.value = ''
  formPlatform.value = defaultProjectPlatform()
  formWindowsShell.value = settings.defaultWindowsShellKind()
  formColor.value = undefined
  formIcon.value = undefined
}

// --- Lifecycle ---
watch(query, () => {
  selectedIdx.value = 0
})

watch(
  () => projectStore.showSwitcher,
  (show) => {
    if (show) {
      // Global-mode windows skip project restore at startup, so the list may
      // not be loaded yet when the switcher is first opened there.
      if (projectStore.projects.length === 0) projectStore.loadProjects()
      // Mark the ones this machine has no copy of, like the project panel does.
      projectStore.checkRoots().catch(() => {})
      query.value = ''
      selectedIdx.value = 0
      resetForm()
      nextTick(() => inputRef.value?.focus())
    }
  },
)

function onKeyDown(e: KeyboardEvent) {
  if (showNewForm.value) return // Let form handle its own keys

  if (e.key === 'Escape') {
    e.preventDefault()
    projectStore.showSwitcher = false
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (selectedIdx.value < filtered.value.length - 1) {
      selectedIdx.value++
    }
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (selectedIdx.value > 0) {
      selectedIdx.value--
    }
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const selected = filtered.value[selectedIdx.value]
    if (selected) {
      // 新しいウィンドウで開く。修飾キーは mac だけ Cmd（`lib/keys.ts`）。
      selectProject(selected.id, hasMod(e))
    }
    return
  }
}

const formRootPlaceholder = computed(() => rootPlaceholderFn(formPlatform.value))
</script>

<template>
  <Teleport to="body">
    <div v-if="projectStore.showSwitcher" class="switcher-overlay ui-zoom" @mousedown.self="projectStore.showSwitcher = false">
      <div class="switcher popup-surface" data-testid="project-switcher">
        <!-- Search bar (hidden when creating) -->
        <input
          v-if="!showNewForm"
          ref="inputRef"
          v-model="query"
          class="switcher-input"
          :placeholder="t('projectSwitcher.placeholder')"
          @keydown="onKeyDown"
        />

        <!-- Project list -->
        <div v-if="!showNewForm" class="switcher-list">
          <div
            v-for="(project, i) in filtered"
            :key="project.id"
            class="switcher-item"
            :class="{ selected: i === selectedIdx, active: project.id === projectStore.currentProject?.id }"
            @click="selectProject(project.id, false)"
            @mouseenter="selectedIdx = i"
          >
            <span class="item-name">
              <ProjectIcon :icon="project.icon" /><ColorDot :color="project.color" />{{ project.name }}
            </span>
            <span v-if="projectStore.missingRoots.has(project.id)" class="missing-tag" :title="t('project.missingHint')">
              {{ t('project.missing') }}
            </span>
            <span class="item-root">{{ project.root }}</span>
          </div>
          <div v-if="filtered.length === 0 && query" class="switcher-empty">
            {{ t('projectSwitcher.noMatch') }}
          </div>
        </div>

        <!-- New project button -->
        <div v-if="!showNewForm" class="switcher-footer">
          <div class="footer-hints">
            <span v-if="globalMode" class="hint">{{ t('projectSwitcher.enterOpenWindow') }}</span>
            <template v-else>
              <span class="hint">{{ t('projectSwitcher.enterSwitch') }}</span>
              <span class="hint">{{ t('projectSwitcher.ctrlEnterWindow') }}</span>
            </template>
          </div>
          <div class="footer-buttons">
            <button class="footer-btn" @click="enterGlobalMode">
              <Globe :size="14" :stroke-width="2" />{{ t('projectSwitcher.openGlobal') }}
            </button>
            <button class="footer-btn" data-testid="switcher-open-directory" @click="onOpenDirectory">
              <FolderOpen :size="14" :stroke-width="2" />{{ t('projectSwitcher.openDirectory') }}
            </button>
            <button class="footer-btn" data-testid="switcher-new-project" @click="openNewForm">{{ t('projectSwitcher.newProject') }}</button>
          </div>
        </div>

        <!-- New project form -->
        <div v-if="showNewForm" class="new-form" data-testid="new-project-form">
          <div class="new-form-header">
            <span>{{ t('projectSwitcher.formTitle') }}</span>
            <button class="back-btn" @click="resetForm">{{ t('common.back') }}</button>
          </div>
          <form class="new-form-body" @submit.prevent="onCreateProject">
            <input v-model="formName" :placeholder="t('project.projectName')" required />
            <input v-model="formRoot" :placeholder="formRootPlaceholder" required />
            <ProjectPlatformFields
              v-model:platform="formPlatform"
              v-model:distro="formDistro"
              v-model:win-shell="formWindowsShell"
              :distros="distros"
            />
            <ColorSelect v-model="formColor" />
            <IconSelect v-model="formIcon" />
            <button type="submit" class="create-btn">{{ t('projectSwitcher.createAndOpen') }}</button>
          </form>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.switcher-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  padding-top: 80px;
}

.switcher {
  width: 480px;
  max-height: 420px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  align-self: flex-start;
}

.switcher-input {
  padding: 10px 14px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-active);
  font-size: 14px;
  outline: none;
}

.switcher-input::placeholder {
  color: var(--text-secondary);
}

.switcher-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.switcher-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  cursor: pointer;
}

.switcher-item.selected {
  background: var(--accent);
}

.switcher-item.active .item-name::after {
  content: " *";
  color: var(--accent);
}

.switcher-item.selected.active .item-name::after {
  color: var(--text-active);
}

.item-name {
  font-size: 13px;
  color: var(--text-primary);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.switcher-item.selected .item-name {
  color: var(--text-active);
}

.switcher-item.selected .missing-tag {
  color: var(--text-active);
}

.item-root {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.switcher-item.selected .item-root {
  color: rgba(255, 255, 255, 0.7);
}

.switcher-empty {
  padding: 16px 14px;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}

.switcher-footer {
  border-top: 1px solid var(--border);
  padding: 6px;
}

.footer-hints {
  display: flex;
  gap: 12px;
  padding: 2px 8px 4px;
}

.hint {
  font-size: 11px;
  color: var(--text-secondary);
}

.footer-buttons {
  display: flex;
  gap: 6px;
  /* Three buttons no longer fit one row at every UI zoom, and a label broken
     mid-word reads worse than a second row. */
  flex-wrap: wrap;
}

.footer-btn {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  white-space: nowrap;
  padding: 8px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}

.footer-btn:hover {
  color: var(--text-active);
  border-color: var(--accent);
  background: var(--bg-tertiary);
}

/* New project form */
.new-form {
  display: flex;
  flex-direction: column;
}

.new-form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 14px;
  color: var(--text-active);
}

.back-btn {
  padding: 2px 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
}

.back-btn:hover {
  color: var(--text-primary);
  background: var(--tab-hover-bg);
}

.new-form-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
}

.new-form-body input[type="text"],
.new-form-body input:not([type]),
.new-form-body select {
  padding: 6px 10px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  border-radius: 4px;
  outline: none;
}

.new-form-body input:focus,
.new-form-body select:focus {
  border-color: var(--accent);
}

.create-btn {
  padding: 8px;
  border: none;
  background: var(--accent);
  color: var(--text-active);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  margin-top: 4px;
}

.create-btn:hover {
  opacity: 0.9;
}
</style>
