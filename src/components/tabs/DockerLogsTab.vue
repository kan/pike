<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { dockerLogRouter } from '../../composables/useDockerLogRouter'
import { useI18n } from '../../i18n'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { dockerLogsStart, dockerLogsStop } from '../../lib/tauri'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import type { DockerLogsTab } from '../../types/tab'
import '@xterm/xterm/css/xterm.css'

const { t } = useI18n()

const props = defineProps<{ tabId: string }>()
const tabStore = useTabStore()
const settingsStore = useSettingsStore()

const tab = computed(() =>
  tabStore.tabs.find((t): t is DockerLogsTab => t.id === props.tabId && t.kind === 'docker-logs'),
)

const termRef = ref<HTMLDivElement>()
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let streamId: string | null = null
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null

function doFit() {
  if (!fitAddon || !terminal) return
  fitAddon.fit()
}

// 描かれるようになったら測り直す（#308。分割していると 2 枚が同時に見えている）。
watch(
  () => tabStore.isTabVisible(props.tabId),
  (visible) => {
    if (visible) nextTick(() => doFit())
  },
)

watch(
  () => settingsStore.xtermTheme,
  (theme) => {
    if (!terminal) return
    terminal.options.theme = theme
    terminal.refresh(0, terminal.rows - 1)
  },
)
watch(
  () => settingsStore.fontFamily,
  (v) => {
    if (terminal) {
      terminal.options.fontFamily = v
      doFit()
    }
  },
)
watch(
  () => settingsStore.fontSize,
  (v) => {
    if (terminal) {
      terminal.options.fontSize = v
      doFit()
    }
  },
)
// 背景透過（#162）: backdrop を切り替えたら xterm の透明描画も切り替えて描き直す。
watch(
  () => settingsStore.windowBackdrop,
  (kind) => {
    if (!terminal) return
    terminal.options.allowTransparency = kind !== 'none'
    terminal.refresh(0, terminal.rows - 1)
  },
)

onMounted(async () => {
  if (!termRef.value || !tab.value) return

  terminal = new Terminal({
    fontFamily: settingsStore.fontFamily,
    fontSize: settingsStore.fontSize,
    theme: settingsStore.xtermTheme,
    scrollback: 10000,
    cursorBlink: false,
    disableStdin: true,
    convertEol: true,
    // 背景透過（#162）: 透明な theme の背景をそのまま描かせる。TerminalTab と同じ。
    allowTransparency: settingsStore.windowBackdrop !== 'none',
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon((_e, uri) => openUrlWithConfirm(uri)))

  terminal.open(termRef.value)
  fitAddon.fit()

  terminal.onSelectionChange(() => {
    if (!settingsStore.terminalCopyOnSelect || !terminal) return
    const text = terminal.getSelection()
    if (text) navigator.clipboard.writeText(text.replace(/\r\n/g, '\n')).catch(() => {})
  })

  try {
    streamId = await dockerLogsStart(tab.value.containerId)
    const termRef_ = terminal
    dockerLogRouter.register(
      streamId,
      (data) => termRef_.write(data),
      () => termRef_.write(`\r\n${t('dockerLogs.ended')}\r\n`),
    )
  } catch (e) {
    terminal.write(`\r\n${t('dockerLogs.failedStart', { error: String(e) })}\r\n`)
  }

  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => doFit(), 100)
  })
  resizeObserver.observe(termRef.value)
})

onUnmounted(() => {
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  if (streamId) {
    dockerLogRouter.unregister(streamId)
    dockerLogsStop(streamId).catch(() => {})
  }
  terminal?.dispose()
})
</script>

<template>
  <div class="docker-logs-tab xterm-surface" :class="{ opaque: settingsStore.windowBackdrop === 'none' }">
    <div ref="termRef" class="logs-container"></div>
  </div>
</template>

<style scoped>
.docker-logs-tab {
  position: absolute;
  inset: 0;
  padding: 10px;
  box-sizing: border-box;
  background: v-bind('settingsStore.terminalSurfaceBg');
}

.logs-container {
  width: 100%;
  height: 100%;
}
</style>
