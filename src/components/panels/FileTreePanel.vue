<script setup lang="ts">
import { useProjectStore } from "../../stores/project";

const projectStore = useProjectStore();
</script>

<template>
  <div class="filetree-panel">
    <template v-if="projectStore.currentProject">
      <div class="project-label">{{ projectStore.currentProject.name }}</div>
      <div class="root-path">{{ projectStore.currentProject.root }}</div>
    </template>
    <div v-else class="empty">
      No project selected
    </div>
  </div>
</template>

<style scoped>
.filetree-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.project-label {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 600;
}

.root-path {
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-all;
}

.empty {
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
  padding: 16px 0;
}
</style>
