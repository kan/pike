<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ptySpawn, ptyWrite, ptyResize, ptyKill } from "../../lib/tauri";
import { useTabStore } from "../../stores/tabs";
import { useSettingsStore } from "../../stores/settings";
import { ptyRouter } from "../../composables/usePtyRouter";
import { confirmDialog } from "../../composables/useConfirmDialog";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{
  tabId: string;
}>();

const tabStore = useTabStore();
const settingsStore = useSettingsStore();

const termRef = ref<HTMLDivElement>();
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ptyId: string | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let lastCols = 0;
let lastRows = 0;

const SHELL_EXECUTABLES = new Set([
  'wsl.exe', 'wsl', 'cmd.exe', 'cmd', 'powershell.exe', 'powershell',
  'pwsh.exe', 'pwsh', 'bash.exe', 'bash', 'sh', 'zsh', 'fish',
]);

const SHELL_WINDOW_TITLES = new Set([
  'windows powershell', 'command prompt', 'administrator: windows powershell',
]);

function parseTerminalTitle(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  // Full Windows paths like "C:\Windows\System32\wsl.exe"
  if (/^[a-zA-Z]:\\/.test(t)) {
    const base = t.split('\\').pop()!;
    if (SHELL_EXECUTABLES.has(base.toLowerCase())) return null;
    return base.replace(/\.exe$/i, '');
  }
  // Known shell window titles
  if (SHELL_WINDOW_TITLES.has(t.toLowerCase())) return null;
  // Bare shell executable names
  if (SHELL_EXECUTABLES.has(t.toLowerCase())) return null;
  // "user@host: ~/path" → path part
  let cleaned = t;
  const colonSpace = cleaned.lastIndexOf(': ');
  if (colonSpace !== -1) cleaned = cleaned.slice(colonSpace + 2);
  // "MINGW64:/c/Users/..." → path part
  const prefixColon = cleaned.indexOf(':');
  if (prefixColon !== -1 && prefixColon < cleaned.length - 1 && cleaned[prefixColon + 1] === '/') {
    cleaned = cleaned.slice(prefixColon + 1);
  }
  cleaned = cleaned.trim();
  // Path → last component
  if (cleaned.includes('/') || cleaned.includes('\\')) {
    const last = cleaned.split(/[/\\]/).filter(Boolean).pop();
    if (last) cleaned = last;
  }
  return cleaned || null;
}

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

// Apply settings changes to live terminal
watch(
  () => settingsStore.xtermTheme,
  (theme) => {
    if (!terminal) return;
    terminal.options.theme = theme;
    terminal.refresh(0, terminal.rows - 1);
    // Nudge PTY resize to make TUI apps (like Claude Code) redraw
    if (ptyId && terminal.cols > 1) {
      ptyResize(ptyId, terminal.cols - 1, terminal.rows);
      setTimeout(() => {
        if (terminal && ptyId) {
          ptyResize(ptyId, terminal.cols, terminal.rows);
        }
      }, 200);
    }
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
  if (!termRef.value) return;

  terminal = new Terminal({
    fontFamily: settingsStore.fontFamily,
    fontSize: settingsStore.fontSize,
    theme: settingsStore.xtermTheme,
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

  const tabData = tabStore.tabs.find((t) => t.id === props.tabId);
  const spawnOpts = tabData?.kind === 'terminal'
    ? { cwd: tabData.cwd, shell: tabData.shell }
    : undefined;

  try {
    const result = await ptySpawn(cols, rows, spawnOpts);
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

  if (tabData?.kind === 'terminal') {
    const isWsl = !tabData.shell || tabData.shell.kind === 'wsl';
    const currentPtyId = ptyId;
    const initLines: string[] = [];

    if (isWsl) {
      // Set up bash title reporting: show running command, revert to dir on prompt
      const titleSetup =
        '__hearth_prompt() { printf \'\\e]0;%s\\a\' "${PWD##*/}"; }; ' +
        'PROMPT_COMMAND="__hearth_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; ' +
        'trap \'[[ "$BASH_COMMAND" == _* ]] || printf "\\e]0;%s\\a" "${BASH_COMMAND%% *}"\' DEBUG';
      initLines.push(titleSetup);
    }

    // Shell-appropriate clear + command chaining
    const shellKind = tabData.shell?.kind;
    const clearCmd = (shellKind === 'cmd' || shellKind === 'powershell') ? 'cls' : 'clear';
    const chain = shellKind === 'powershell' ? '; ' : ' && ';

    if (tabData.autoStart) {
      initLines.push(clearCmd + chain + tabData.autoStart);
    } else if (initLines.length > 0) {
      initLines.push(clearCmd);
    }

    if (initLines.length > 0) {
      setTimeout(() => {
        termRef_.clear();
        ptyWrite(currentPtyId, initLines.join('\r') + '\r').catch(() => {});
      }, 500);
    }
  }

  lastCols = terminal.cols;
  lastRows = terminal.rows;

  terminal.onData((data) => {
    if (ptyId) {
      ptyWrite(ptyId, data).catch(() => {});
    }
  });

  terminal.onTitleChange((raw) => {
    if (!raw) return;
    const title = parseTerminalTitle(raw);
    if (title) {
      tabStore.setTabTitle(props.tabId, title);
    }
  });

  // Auto-copy on selection
  terminal.onSelectionChange(() => {
    if (!settingsStore.terminalCopyOnSelect || !terminal) return;
    const text = terminal.getSelection();
    if (text) navigator.clipboard.writeText(text);
  });

  // Right-click paste
  termRef.value.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    if (!settingsStore.terminalRightClickPaste || !ptyId) return;
    const text = await navigator.clipboard.readText().catch(() => "");
    if (!text) return;
    if (text.includes("\n") || text.includes("\r")) {
      if (!await confirmDialog("Paste content contains newlines. Continue?")) return;
    }
    ptyWrite(ptyId, text).catch(() => {});
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
  <div class="terminal-wrapper">
    <div ref="termRef" class="terminal-inner"></div>
  </div>
</template>

<style scoped>
.terminal-wrapper {
  position: absolute;
  inset: 0;
  padding: 10px;
  box-sizing: border-box;
}

.terminal-inner {
  width: 100%;
  height: 100%;
}
</style>
