<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useTabStore } from "../../stores/tabs";
import { useProjectStore } from "../../stores/project";
import { fsReadFileBase64 } from "../../lib/tauri";
import type { PdfTab } from "../../types/tab";
import { useI18n } from "../../i18n";

const { t } = useI18n();
const props = defineProps<{ tabId: string }>();
const tabStore = useTabStore();
const projectStore = useProjectStore();

const tab = computed(() =>
  tabStore.tabs.find((t): t is PdfTab => t.id === props.tabId && t.kind === "pdf")
);

const loading = ref(true);
const error = ref<string | null>(null);
const dataUrl = ref("");

onMounted(async () => {
  if (!tab.value) return;
  const project = projectStore.currentProject;
  if (!project) return;

  try {
    const base64 = await fsReadFileBase64(project.shell, tab.value.path);
    dataUrl.value = `data:application/pdf;base64,${base64}`;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="pdf-tab">
    <div v-if="loading" class="pdf-status">{{ t('common.loading') }}</div>
    <div v-else-if="error" class="pdf-status error">{{ error }}</div>
    <iframe v-else :src="dataUrl" class="pdf-frame" />
  </div>
</template>

<style scoped>
.pdf-tab {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pdf-status {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
  font-size: 14px;
}

.pdf-status.error {
  color: var(--danger);
}

.pdf-frame {
  flex: 1;
  border: none;
  width: 100%;
  height: 100%;
}
</style>
