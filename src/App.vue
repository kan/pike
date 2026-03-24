<script setup lang="ts">
import { onMounted, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import SideBar from "./components/layout/SideBar.vue";
import TabPane from "./components/layout/TabPane.vue";
import StatusBar from "./components/layout/StatusBar.vue";
import ProjectSwitcher from "./components/ProjectSwitcher.vue";
import { useProjectStore } from "./stores/project";
import { useGitStore } from "./stores/git";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts";
import { ptyRouter } from "./composables/usePtyRouter";

const projectStore = useProjectStore();
const gitStore = useGitStore();

useKeyboardShortcuts();

watch(
  () => projectStore.currentProject?.name,
  (name) => {
    const title = name ? `hearth - ${name}` : "hearth";
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

onMounted(async () => {
  await ptyRouter.init();
  await projectStore.restoreLastProject();
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
