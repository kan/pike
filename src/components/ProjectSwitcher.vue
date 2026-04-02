<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '../i18n'
import { detectWslDistros, openProjectWindow } from '../lib/tauri'
import { useProjectStore } from '../stores/project'
import type { ProjectConfig } from '../types/project'
import { buildShell, rootPlaceholder as rootPlaceholderFn, slugify, WINDOWS_SHELLS } from '../types/tab'

const { t } = useI18n()
const projectStore = useProjectStore()

// --- Search mode ---
const query = ref('')
const selectedIdx = ref(0)
const inputRef = ref<HTMLInputElement>()

const filtered = computed(() => {
  const q = query.value.toLowerCase()
  if (!q) return projectStore.projects
  return projectStore.projects.filter((p) => fuzzyMatch(p.name.toLowerCase(), q))
})

function fuzzyMatch(text: string, pattern: string): boolean {
  let pi = 0
  for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
    if (text[ti] === pattern[pi]) pi++
  }
  return pi === pattern.length
}

// --- New project form ---
const showNewForm = ref(false)
const formName = ref('')
const formRoot = ref('')
const formPlatform = ref<'wsl' | 'windows'>('wsl')
const formDistro = ref('Ubuntu')
const formWindowsShell = ref<'cmd' | 'powershell' | 'git-bash'>('powershell')
const distros = ref<string[]>([])
const distrosLoaded = ref(false)

async function loadDistros() {
  if (distrosLoaded.value) return
  try {
    distros.value = await detectWslDistros()
    if (distros.value.length > 0) {
      formDistro.value = distros.value[0]
    }
  } catch {
    distros.value = ['Ubuntu']
  }
  distrosLoaded.value = true
}

function openNewForm() {
  showNewForm.value = true
  loadDistros()
}

async function onCreateProject() {
  const id = slugify(formName.value)
  if (!id) return

  const config: ProjectConfig = {
    id,
    name: formName.value,
    root: formRoot.value,
    shell: buildShell(formPlatform.value, formDistro.value, formWindowsShell.value),
    pinnedTabs: [],
    lastOpened: new Date().toISOString(),
  }

  await projectStore.addProject(config)
  await projectStore.switchProject(id)
  projectStore.showSwitcher = false
  resetForm()
}

function resetForm() {
  showNewForm.value = false
  formName.value = ''
  formRoot.value = ''
  formPlatform.value = 'wsl'
  formWindowsShell.value = 'powershell'
}

// --- Lifecycle ---
watch(query, () => {
  selectedIdx.value = 0
})

watch(
  () => projectStore.showSwitcher,
  (show) => {
    if (show) {
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
      if (e.ctrlKey) {
        openProjectWindow(selected.id)
      } else {
        projectStore.switchProject(selected.id)
      }
      projectStore.showSwitcher = false
    }
    return
  }
}

const formRootPlaceholder = computed(() => rootPlaceholderFn(formPlatform.value))
</script>

<template>
  <Teleport to="body">
    <div v-if="projectStore.showSwitcher" class="switcher-overlay" @mousedown.self="projectStore.showSwitcher = false">
      <div class="switcher">
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
            @click="projectStore.switchProject(project.id); projectStore.showSwitcher = false"
            @mouseenter="selectedIdx = i"
          >
            <span class="item-name">{{ project.name }}</span>
            <span class="item-root">{{ project.root }}</span>
          </div>
          <div v-if="filtered.length === 0 && query" class="switcher-empty">
            {{ t('projectSwitcher.noMatch') }}
          </div>
        </div>

        <!-- New project button -->
        <div v-if="!showNewForm" class="switcher-footer">
          <div class="footer-hints">
            <span class="hint">{{ t('projectSwitcher.enterSwitch') }}</span>
            <span class="hint">{{ t('projectSwitcher.ctrlEnterWindow') }}</span>
          </div>
          <button class="new-project-btn" @click="openNewForm">{{ t('projectSwitcher.newProject') }}</button>
        </div>

        <!-- New project form -->
        <div v-if="showNewForm" class="new-form">
          <div class="new-form-header">
            <span>{{ t('projectSwitcher.formTitle') }}</span>
            <button class="back-btn" @click="resetForm">{{ t('common.back') }}</button>
          </div>
          <form class="new-form-body" @submit.prevent="onCreateProject">
            <input v-model="formName" :placeholder="t('project.projectName')" required />
            <input v-model="formRoot" :placeholder="formRootPlaceholder" required />
            <div class="platform-row">
              <label class="radio-label">
                <input type="radio" v-model="formPlatform" value="wsl" /> WSL
              </label>
              <label class="radio-label">
                <input type="radio" v-model="formPlatform" value="windows" /> Windows
              </label>
            </div>
            <select v-if="formPlatform === 'wsl'" v-model="formDistro">
              <option v-for="d in distros" :key="d" :value="d">{{ d }}</option>
            </select>
            <select v-if="formPlatform === 'windows'" v-model="formWindowsShell">
              <option v-for="s in WINDOWS_SHELLS" :key="s.kind" :value="s.kind">{{ s.label }}</option>
            </select>
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
}

.switcher-item.selected .item-name {
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

.new-project-btn {
  width: 100%;
  padding: 8px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}

.new-project-btn:hover {
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

.platform-row {
  display: flex;
  gap: 16px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
}

.radio-label input {
  accent-color: var(--accent);
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
