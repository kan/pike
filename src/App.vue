<script setup lang="ts">
import { onMounted, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import SideBar from "./components/layout/SideBar.vue";
import TabPane from "./components/layout/TabPane.vue";
import StatusBar from "./components/layout/StatusBar.vue";
import ProjectSwitcher from "./components/ProjectSwitcher.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import KeyboardShortcuts from "./components/KeyboardShortcuts.vue";
import { useProjectStore } from "./stores/project";
import { useTabStore } from "./stores/tabs";
import { useGitStore } from "./stores/git";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts";
import { ptyRouter } from "./composables/usePtyRouter";
import { dockerLogRouter } from "./composables/useDockerLogRouter";
import { initCliOpen } from "./composables/useCliOpen";
import { getWindowProjectId } from "./lib/window";
import { useI18n } from "./i18n";

const { t } = useI18n();

const projectStore = useProjectStore();
const tabStore = useTabStore();
const gitStore = useGitStore();

useKeyboardShortcuts();

const isDebug = import.meta.env.DEV;

watch(
  () => projectStore.currentProject?.name,
  (name) => {
    const base = name ? t('app.titleWithProject', { name }) : t('app.title');
    const title = isDebug ? `[DEBUG] ${base}` : base;
    getCurrentWindow().setTitle(title);
  },
  { immediate: true }
);

// Centralized git polling lifecycle
watch(
  () => projectStore.currentProject?.id,
  (id) => {
    if (id) {
      gitStore.startPolling();
    } else {
      gitStore.stopPolling();
    }
  }
);

const windowProjectId = getWindowProjectId();

onMounted(async () => {
  await Promise.all([ptyRouter.init(), dockerLogRouter.init()]);

  if (windowProjectId) {
    await projectStore.loadProjects();
    await projectStore.switchProject(windowProjectId, { updateLastProject: false });
  } else {
    await projectStore.restoreLastProject();
  }

  await initCliOpen();

  tabStore.$subscribe(() => projectStore.saveSessionDebounced());
  window.addEventListener("beforeunload", () => {
    projectStore.saveSessionNow();
  });
});
</script>

<template>
  <div class="app">
    <div class="app-main">
      <SideBar />
      <TabPane />
    </div>
    <StatusBar />
    <ProjectSwitcher />
    <ConfirmDialog />
    <KeyboardShortcuts />
  </div>
</template>

<style scoped>
.app {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.app-main {
  flex: 1;
  display: flex;
  min-height: 0;
}
</style>
