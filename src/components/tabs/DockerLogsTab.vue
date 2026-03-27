<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { dockerLogsStart, dockerLogsStop } from "../../lib/tauri";
import { useTabStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { dockerLogRouter } from "../../composables/useDockerLogRouter";
import type { DockerLogsTab } from "../../types/tab";
import { useI18n } from "../../i18n";
import "@xterm/xterm/css/xterm.css";

const { t } = useI18n();

const props = defineProps<{ tabId: string }>();
const tabStore = useTabStore();
const settingsStore = useSettingsStore();

const tab = computed(() =>
  tabStore.tabs.find((t): t is DockerLogsTab => t.id === props.tabId && t.kind === "docker-logs")
);

const termRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let streamId: string | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

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

watch(
  () => settingsStore.xtermTheme,
  (theme) => {
    if (!terminal) return;
    terminal.options.theme = theme;
    terminal.refresh(0, terminal.rows - 1);
  }
);
watch(
  () => settingsStore.fontFamily,
  (v) => { if (terminal) { terminal.options.fontFamily = v; doFit(); } }
);
watch(
  () => settingsStore.fontSize,
  (v) => { if (terminal) { terminal.options.fontSize = v; doFit(); } }
);

onMounted(async () => {
  if (!termRef.value || !tab.value) return;

  terminal = new Terminal({
    fontFamily: settingsStore.fontFamily,
    fontSize: settingsStore.fontSize,
    theme: settingsStore.xtermTheme,
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
      () => termRef_.write(`\r\n${t('dockerLogs.ended')}\r\n`)
    );
  } catch (e) {
    terminal.write(`\r\n${t('dockerLogs.failedStart', { error: String(e) })}\r\n`);
  }

  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => doFit(), 100);
  });
  resizeObserver.observe(termRef.value);
});

onUnmounted(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
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
  background: v-bind('settingsStore.colorScheme.background');
}

.logs-container {
  width: 100%;
  height: 100%;
}
</style>
