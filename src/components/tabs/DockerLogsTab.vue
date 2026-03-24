<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { dockerLogsStart, dockerLogsStop } from "../../lib/tauri";
import { useTabStore } from "../../stores/tabs";
import { dockerLogRouter } from "../../composables/useDockerLogRouter";
import type { DockerLogsTab } from "../../types/tab";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ tabId: string }>();
const tabStore = useTabStore();

const tab = computed(() =>
  tabStore.tabs.find((t): t is DockerLogsTab => t.id === props.tabId && t.kind === "docker-logs")
);

import { computed } from "vue";

const termRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let streamId: string | null = null;
let resizeObserver: ResizeObserver | null = null;

function doFit() {
  if (!fitAddon || !terminal) return;
  fitAddon.fit();
}

watch(
  () => tabStore.activeTabId,
  (id) => {
    if (id === props.tabId) {
      nextTick(() => doFit());
    }
  }
);

onMounted(async () => {
  if (!termRef.value || !tab.value) return;

  terminal = new Terminal({
    fontFamily: "'PlemolJP Console NF', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 14,
    theme: {
      background: "#1e1e1e",
      foreground: "#cccccc",
      cursor: "#cccccc",
      selectionBackground: "#264f78",
    },
    scrollback: 10000,
    cursorBlink: false,
    disableStdin: true,
    convertEol: true,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  terminal.open(termRef.value);
  fitAddon.fit();

  try {
    streamId = await dockerLogsStart(tab.value.containerId);
    const termRef_ = terminal;
    dockerLogRouter.register(
      streamId,
      (data) => termRef_.write(data),
      () => termRef_.write("\r\n[Log stream ended]\r\n")
    );
  } catch (e) {
    terminal.write(`\r\n[Failed to start log stream: ${e}]\r\n`);
  }

  resizeObserver = new ResizeObserver(() => {
    setTimeout(() => doFit(), 100);
  });
  resizeObserver.observe(termRef.value);
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  if (streamId) {
    dockerLogRouter.unregister(streamId);
    dockerLogsStop(streamId).catch(() => {});
  }
  terminal?.dispose();
});
</script>

<template>
  <div class="docker-logs-tab">
    <div ref="termRef" class="logs-container"></div>
  </div>
</template>

<style scoped>
.docker-logs-tab {
  position: absolute;
  inset: 0;
  padding: 10px;
  box-sizing: border-box;
}

.logs-container {
  width: 100%;
  height: 100%;
}
</style>
