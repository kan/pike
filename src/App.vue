<script setup lang="ts">
import { onMounted } from "vue";
import SideBar from "./components/layout/SideBar.vue";
import TabPane from "./components/layout/TabPane.vue";
import { useTabStore } from "./stores/tabs";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts";
import { ptyRouter } from "./composables/usePtyRouter";

const tabStore = useTabStore();

useKeyboardShortcuts();

onMounted(async () => {
  await ptyRouter.init();
  tabStore.addTerminalTab();
});
</script>

<template>
  <div class="app">
    <SideBar />
    <TabPane />
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
