<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ptySpawn, ptyWrite, ptyResize, ptyKill } from "../../lib/tauri";
import { useTabStore } from "../../stores/tabs";
import { ptyRouter } from "../../composables/usePtyRouter";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{
  tabId: string;
}>();

const tabStore = useTabStore();

const termRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ptyId: string | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let lastCols = 0;
let lastRows = 0;

function doFit() {
  if (!fitAddon || !terminal || !ptyId) return;
  fitAddon.fit();
  if (terminal.cols > 0 && terminal.rows > 0 &&
      (terminal.cols !== lastCols || terminal.rows !== lastRows)) {
    lastCols = terminal.cols;
    lastRows = terminal.rows;
    ptyResize(ptyId, lastCols, lastRows);
  }
}

// When this tab becomes active, refit to handle size changes while hidden
watch(
  () => tabStore.activeTabId,
  (newId) => {
    if (newId === props.tabId) {
      nextTick(() => doFit());
    }
  }
);

onMounted(async () => {
  if (!termRef.value) return;

  terminal = new Terminal({
    fontFamily: "'PlemolJP Console NF', 'Cascadia Code', 'Fira Code', monospace",
    fontSize: 14,
    theme: {
      background: "#1e1e1e",
      foreground: "#cccccc",
      cursor: "#cccccc",
      selectionBackground: "#264f78",
    },
    scrollback: 5000,
    cursorBlink: true,
    allowProposedApi: true,
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  terminal.open(termRef.value);
  fitAddon.fit();

  const cols = terminal.cols;
  const rows = terminal.rows;

  try {
    const result = await ptySpawn(cols, rows);
    ptyId = result.id;
    tabStore.setPtyId(props.tabId, ptyId);
  } catch (e) {
    terminal.write(`\r\n[Failed to spawn PTY: ${e}]\r\n`);
    return;
  }

  const termRef_ = terminal;
  ptyRouter.register(
    ptyId,
    (data) => termRef_.write(data),
    (code) => termRef_.write(`\r\n[Process exited with code ${code}]\r\n`)
  );

  lastCols = terminal.cols;
  lastRows = terminal.rows;

  terminal.onData((data) => {
    if (ptyId) {
      ptyWrite(ptyId, data).catch(() => {});
    }
  });

  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => doFit(), 100);
  });
  resizeObserver.observe(termRef.value);
});

onUnmounted(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeObserver?.disconnect();
  if (ptyId) {
    ptyRouter.unregister(ptyId);
    ptyKill(ptyId).catch(() => {});
  }
  terminal?.dispose();
});
</script>

<template>
  <div ref="termRef" class="terminal-container"></div>
</template>

<style scoped>
.terminal-container {
  position: absolute;
  inset: 0;
}
</style>
