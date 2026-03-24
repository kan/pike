<script setup lang="ts">
import { onMounted, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import SideBar from "./components/layout/SideBar.vue";
import TabPane from "./components/layout/TabPane.vue";
import ProjectSwitcher from "./components/ProjectSwitcher.vue";
import { useProjectStore } from "./stores/project";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts";
import { ptyRouter } from "./composables/usePtyRouter";

const projectStore = useProjectStore();

useKeyboardShortcuts();

watch(
  () => projectStore.currentProject?.name,
  (name) => {
    const title = name ? `hearth - ${name}` : "hearth";
    getCurrentWindow().setTitle(title);
  },
  { immediate: true }
);

onMounted(async () => {
  await ptyRouter.init();
  await projectStore.restoreLastProject();
});
</script>

<template>
  <div class="app">
    <SideBar />
    <TabPane />
    <ProjectSwitcher />
  </div>
</template>

<style scoped>
.app {
  width: 100vw;
  height: 100vh;
  display: flex;
  overflow: hidden;
}
</style>
