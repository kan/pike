<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { ptySpawn, ptyWrite, ptyResize, ptyKill } from "../../lib/tauri";
import "@xterm/xterm/css/xterm.css";

const termRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ptyId: string | null = null;
let unlistenOutput: (() => void) | null = null;
let unlistenExit: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;

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

  // Listen for PTY output before spawning
  unlistenOutput = await listen<{ id: string; data: string }>(
    "pty_output",
    (event) => {
      if (event.payload.id === ptyId && terminal) {
        terminal.write(event.payload.data);
      }
    }
  );

  unlistenExit = await listen<{ id: string; code: number }>(
    "pty_exit",
    (event) => {
      if (event.payload.id === ptyId && terminal) {
        terminal.write(`\r\n[Process exited with code ${event.payload.code}]\r\n`);
      }
    }
  );

  // Spawn PTY
  const result = await ptySpawn(cols, rows);
  ptyId = result.id;

  // Forward keyboard input to PTY
  terminal.onData((data) => {
    if (ptyId) {
      ptyWrite(ptyId, data);
    }
  });

  // Handle resize
  resizeObserver = new ResizeObserver(() => {
    if (fitAddon && terminal && ptyId) {
      fitAddon.fit();
      ptyResize(ptyId, terminal.cols, terminal.rows);
    }
  });
  resizeObserver.observe(termRef.value);
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  unlistenOutput?.();
  unlistenExit?.();
  if (ptyId) {
    ptyKill(ptyId);
  }
  terminal?.dispose();
});
</script>

<template>
  <div ref="termRef" class="terminal-container"></div>
</template>

<style scoped>
.terminal-container {
  width: 100%;
  height: 100%;
}
</style>
