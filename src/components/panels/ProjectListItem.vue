<script setup lang="ts">
import { ExternalLink, Pencil, Trash2 } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../i18n'
import { openProjectWindow, pickFolder } from '../../lib/tauri'
import type { ProjectConfig } from '../../types/project'
import {
  buildShell,
  rootPlaceholder as rootPlaceholderFn,
  shellLabel,
  shellToDistro,
  shellToPlatform,
  shellToWinKind,
} from '../../types/tab'
import ColorDot from '../ColorDot.vue'
import ColorSelect from './ColorSelect.vue'
import GroupComboBox from './GroupComboBox.vue'

const props = defineProps<{
  project: ProjectConfig
  editing: boolean
  grouped: boolean
  active: boolean
  dragging: boolean
  groups: readonly string[]
  distros: readonly string[]
}>()

const emit = defineEmits<{
  select: []
  'request-edit': []
  'cancel-edit': []
  save: [config: ProjectConfig]
  delete: []
  'drag-start': [e: DragEvent]
  'drag-end': []
}>()

const { t } = useI18n()

const editName = ref('')
const editRoot = ref('')
const editGroup = ref<string | undefined>(undefined)
const editColor = ref<string | undefined>(undefined)
const editPlatform = ref<'wsl' | 'windows'>('wsl')
const editDistro = ref('Ubuntu')
const editWindowsShell = ref<'cmd' | 'powershell' | 'git-bash'>('powershell')

const editRootPlaceholder = computed(() => rootPlaceholderFn(editPlatform.value))

watch(
  () => props.editing,
  (editing) => {
    if (!editing) return
    editName.value = props.project.name
    editRoot.value = props.project.root
    editGroup.value = props.project.group?.trim() || undefined
    editColor.value = props.project.color
    editPlatform.value = shellToPlatform(props.project.shell)
    editDistro.value = shellToDistro(props.project.shell)
    editWindowsShell.value = shellToWinKind(props.project.shell)
  },
  { immediate: true },
)

async function onBrowse() {
  const folder = await pickFolder()
  if (folder) editRoot.value = folder
}

function onSave() {
  emit('save', {
    ...props.project,
    name: editName.value,
    root: editRoot.value,
    shell: buildShell(editPlatform.value, editDistro.value, editWindowsShell.value),
    group: editGroup.value,
    color: editColor.value,
  })
}
</script>

<template>
  <div v-if="editing" class="edit-form">
    <input v-model="editName" :placeholder="t('project.projectName')" />
    <div class="input-row">
      <input v-model="editRoot" :placeholder="editRootPlaceholder" />
      <button v-if="editPlatform === 'windows'" type="button" class="detect-btn" @click="onBrowse">
        {{ t('project.browse') }}
      </button>
    </div>
    <GroupComboBox v-model="editGroup" :groups="groups" />
    <ColorSelect v-model="editColor" />
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
      <button type="button" class="save-btn" @click="onSave">{{ t('common.save') }}</button>
      <button type="button" class="cancel-btn" @click="emit('cancel-edit')">{{ t('common.cancel') }}</button>
    </div>
  </div>

  <div
    v-else
    class="project-item"
    :class="{ active, dragging, grouped }"
    draggable="true"
    @dragstart="emit('drag-start', $event)"
    @dragend="emit('drag-end')"
    @click="emit('select')"
  >
    <div class="project-name">
      <ColorDot :color="project.color" />{{ project.name }}
    </div>
    <div class="project-meta">
      <span class="project-root">{{ project.root }}</span>
      <span class="project-shell">{{ shellLabel(project.shell) }}</span>
    </div>
    <div class="item-actions">
      <button class="action-btn" :title="t('project.openInNewWindow')" @click.stop="openProjectWindow(project.id)"><ExternalLink :size="12" :stroke-width="2" /></button>
      <button class="action-btn" :title="t('project.edit')" @click.stop="emit('request-edit')"><Pencil :size="12" :stroke-width="2" /></button>
      <button class="action-btn danger" :title="t('common.delete')" @click.stop="emit('delete')"><Trash2 :size="12" :stroke-width="2" /></button>
    </div>
  </div>
</template>

<style scoped>
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--bg-tertiary);
  border-radius: 3px;
}

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

.edit-form input:focus,
.edit-form select:focus {
  border-color: var(--accent);
}

.input-row {
  display: flex;
  gap: 4px;
}

.input-row input {
  flex: 1;
  min-width: 0;
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

.detect-btn:hover {
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
  display: flex;
  align-items: center;
  gap: 6px;
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
</style>
