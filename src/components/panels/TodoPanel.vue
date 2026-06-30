<script setup lang="ts">
import { Check, FileText, Plus, Trash2 } from 'lucide-vue-next'
import { nextTick, ref } from 'vue'
import { useDragAndDrop } from '../../composables/useDragAndDrop'
import { useI18n } from '../../i18n'
import { useProjectStore } from '../../stores/project'
import { useTabStore } from '../../stores/tabs'
import { useTodoStore } from '../../stores/todo'

const { t } = useI18n()
const todo = useTodoStore()
const tabStore = useTabStore()
const projectStore = useProjectStore()

const newText = ref('')

function addTask() {
  todo.add(newText.value)
  newText.value = ''
}

// Inline editing
const editingId = ref<string | null>(null)
const editText = ref('')
// Function ref (not a string ref): inside v-for a string ref resolves to an
// array, so `.focus()` would throw. This keeps a single element instead.
const editInput = ref<HTMLInputElement | null>(null)
function setEditInput(el: unknown) {
  editInput.value = (el as HTMLInputElement | null) ?? null
}

function startEdit(id: string, text: string) {
  editingId.value = id
  editText.value = text
  nextTick(() => editInput.value?.focus())
}

function commitEdit() {
  if (editingId.value) todo.setText(editingId.value, editText.value.trim())
  editingId.value = null
}

// Drag-and-drop reorder
const { dragId, dragOverTarget, startDrag, resetDrag } = useDragAndDrop<string>()

function onDragOver(e: DragEvent, id: string) {
  if (!dragId.value || dragId.value === id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverTarget.value = id
}

function onDrop(id: string) {
  if (dragId.value) todo.move(dragId.value, id)
  resetDrag()
}

function openFile() {
  if (todo.filePath) tabStore.addEditorTab({ path: todo.filePath })
}
</script>

<template>
  <div class="todo-panel">
    <div v-if="!projectStore.currentProject" class="placeholder">{{ t('fileTree.noProject') }}</div>
    <template v-else>
      <div class="todo-top">
        <span class="progress">{{ todo.progress.done }} / {{ todo.progress.total }}</span>
        <button class="icon-btn" :title="t('todo.openFile')" @click="openFile">
          <FileText :size="14" :stroke-width="2" />
        </button>
      </div>

      <div class="todo-add">
        <input
          v-model="newText"
          class="todo-input"
          :placeholder="t('todo.addPlaceholder')"
          @keydown.enter="addTask"
        />
        <button class="icon-btn" :title="t('todo.add')" :disabled="!newText.trim()" @click="addTask">
          <Plus :size="14" :stroke-width="2" />
        </button>
      </div>

      <div v-if="todo.tasks.length === 0" class="placeholder">{{ t('todo.empty') }}</div>

      <ul v-else class="todo-list">
        <li
          v-for="task in todo.tasks"
          :key="task.id"
          class="todo-item"
          :class="{ done: task.done, dragging: task.id === dragId, 'drag-over': task.id === dragOverTarget }"
          draggable="true"
          @dragstart="startDrag($event, task.id)"
          @dragover="onDragOver($event, task.id)"
          @drop="onDrop(task.id)"
          @dragend="resetDrag"
        >
          <button
            class="checkbox"
            :class="{ checked: task.done }"
            :title="task.done ? t('todo.markUndone') : t('todo.markDone')"
            @click="todo.toggle(task.id)"
          >
            <Check v-if="task.done" :size="12" :stroke-width="3" />
          </button>

          <input
            v-if="editingId === task.id"
            :ref="setEditInput"
            v-model="editText"
            class="todo-input edit"
            @keydown.enter="commitEdit"
            @keydown.escape="editingId = null"
            @blur="commitEdit"
          />
          <span v-else class="todo-text" @click="startEdit(task.id, task.text)">{{ task.text }}</span>

          <button class="icon-btn danger del" :title="t('common.delete')" @click="todo.remove(task.id)">
            <Trash2 :size="13" :stroke-width="2" />
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.todo-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: 12px;
}

.placeholder {
  padding: 16px 12px;
  color: var(--text-secondary);
  font-size: 12px;
}

.todo-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.progress {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.todo-add {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
}

.todo-input {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.todo-input:focus {
  border-color: var(--accent);
}

.todo-list {
  list-style: none;
  margin: 0;
  padding: 2px 0;
  overflow-y: auto;
  flex: 1;
}

.todo-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  cursor: grab;
}

.todo-item:hover {
  background: var(--bg-tertiary);
}

.todo-item.dragging {
  opacity: 0.4;
}

.todo-item.drag-over {
  box-shadow: inset 0 2px 0 0 var(--accent);
}

.checkbox {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: 1px solid var(--text-secondary);
  border-radius: 3px;
  background: transparent;
  color: var(--text-active);
  cursor: pointer;
  padding: 0;
}

.checkbox.checked {
  background: var(--accent);
  border-color: var(--accent);
}

.todo-text {
  flex: 1;
  min-width: 0;
  cursor: text;
  word-break: break-word;
}

.todo-item.done .todo-text {
  color: var(--text-secondary);
  text-decoration: line-through;
}

.todo-input.edit {
  padding: 2px 4px;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.icon-btn:hover:not(:disabled) {
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}

.icon-btn.danger:hover:not(:disabled) {
  color: var(--danger);
}

.del {
  opacity: 0;
}

.todo-item:hover .del {
  opacity: 1;
}
</style>
