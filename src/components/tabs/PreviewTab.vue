<script setup lang="ts">
import { computed } from "vue";
import { useTabStore } from "../../stores/tabs";
import type { PreviewTab } from "../../types/tab";

const props = defineProps<{ tabId: string }>();
const tabStore = useTabStore();

const tab = computed(() =>
  tabStore.tabs.find((t): t is PreviewTab => t.id === props.tabId && t.kind === "preview")
);
</script>

<template>
  <div class="preview-tab">
    <div v-if="!tab" class="empty">Preview not found</div>
    <div v-else class="preview-container">
      <img :src="tab.dataUrl" :alt="tab.title" />
    </div>
  </div>
</template>

<style scoped>
.preview-tab {
  position: absolute;
  inset: 0;
  overflow: auto;
  background: var(--bg-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.preview-container {
  padding: 20px;
}

.preview-container img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.empty {
  color: var(--text-secondary);
  font-size: 14px;
}
</style>
