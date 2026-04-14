<script setup lang="ts">
import { Play } from 'lucide-vue-next'
import { watch } from 'vue'
import { useI18n } from '../../i18n'
import { useSidebarStore } from '../../stores/sidebar'
import { useTaskStore } from '../../stores/tasks'

const { t } = useI18n()
const sidebar = useSidebarStore()
const taskStore = useTaskStore()

watch(
  () => sidebar.activePanel,
  (panel) => {
    if (panel === 'tasks' && taskStore.taskGroups.length === 0) {
      taskStore.refresh()
    }
  },
  { immediate: true },
)

function refresh() {
  taskStore.refresh()
}

defineExpose({ refresh })
</script>

<template>
  <div class="tasks-panel">
    <div v-if="taskStore.loading" class="empty">{{ t('common.loading') }}</div>
    <div v-else-if="taskStore.taskGroups.length === 0" class="empty">{{ t('tasks.noFiles') }}</div>
    <template v-else>
      <div v-for="group in taskStore.taskGroups" :key="group.runner" class="task-group">
        <div class="group-header">
          <span class="group-label">{{ group.label }}</span>
          <span class="group-source">{{ group.sourceFile }}</span>
        </div>
        <div
          v-for="task in group.tasks"
          :key="`${group.runner}:${task.name}`"
          class="task-item"
          :title="task.command"
          @click="taskStore.runTask(task)"
        >
          <span class="task-name">{{ task.name }}</span>
          <button class="task-run" @click.stop="taskStore.runTask(task)">
            <Play :size="12" :stroke-width="2" />
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tasks-panel {
  padding: 4px 0;
  overflow-y: auto;
  height: 100%;
}

.empty {
  padding: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}

.task-group {
  margin-bottom: 4px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.group-source {
  font-size: 10px;
  opacity: 0.6;
}

.task-item {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
}

.task-item:hover {
  background: var(--bg-tertiary);
}

.task-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-run {
  display: none;
  padding: 2px;
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
}

.task-item:hover .task-run {
  display: flex;
}

.task-run:hover {
  color: var(--accent);
  background: var(--bg-secondary);
}
</style>
