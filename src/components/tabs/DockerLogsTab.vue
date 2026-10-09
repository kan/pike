<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { copyOnSelect } from '../../composables/useCopyOnSelect'
import { dockerLogRouter } from '../../composables/useDockerLogRouter'
import { attachUrlLinks } from '../../composables/useTerminalUrlLinks'
import { useI18n } from '../../i18n'
import { dockerLogsStart, dockerLogsStop } from '../../lib/tauri'
import { TERM_SCROLLBAR_WIDTH, useSettingsStore } from '../../stores/settings'
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
/** 閉じられたか。ログの開始を待っているあいだに閉じられたことを、戻った側が知るため。 */
let unmounted = false
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
    // スクロールバーと右の溝の幅（#396）。ターミナルと同じ値にそろえる。
    overviewRuler: { width: TERM_SCROLLBAR_WIDTH },
    // 背景透過（#162）: 透明な theme の背景をそのまま描かせる。TerminalTab と同じ。
    allowTransparency: settingsStore.windowBackdrop !== 'none',
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  attachUrlLinks(terminal)

  terminal.open(termRef.value)
  fitAddon.fit()

  terminal.onSelectionChange(() => copyOnSelect(() => terminal?.getSelection() ?? ''))

  // **id はここで決め、始めるのを頼む前に受け口を登録する**（#459 と同じ理由）。出力は
  // `docker_logs_start` が戻る前から届くので、戻り値で id を受けてから登録すると、ログの
  // 先頭が受け口の無いまま届いて捨てられる。
  const id = crypto.randomUUID()
  const termRef_ = terminal
  dockerLogRouter.register(
    id,
    (data) => termRef_.write(data),
    () => termRef_.write(`\r\n${t('dockerLogs.ended')}\r\n`),
  )
  // 先に入れておく（待っているあいだに閉じられたら、`onUnmounted` が受け口を外して止める）。
  streamId = id
  try {
    await dockerLogsStart(id, tab.value.containerId)
  } catch (e) {
    dockerLogRouter.unregister(id)
    streamId = null
    terminal?.write(`\r\n${t('dockerLogs.failedStart', { error: String(e) })}\r\n`)
  }
  // 待っているあいだにタブが閉じられた。`onUnmounted` の停止は、まだ Rust に id が無くて
  // 空振りしているかもしれないので、ここで止め直す。
  if (unmounted) {
    dockerLogsStop(id).catch(() => {})
    return
  }

  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => doFit(), 100)
  })
  resizeObserver.observe(termRef.value)
})

onUnmounted(() => {
  unmounted = true
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
/* 余白は共有の `.xterm-surface` が持つ（#383）。ここは下地の色だけ（`v-bind` が要る）。 */
.docker-logs-tab {
  position: absolute;
  inset: 0;
  background: v-bind('settingsStore.terminalSurfaceBg');
}

.logs-container {
  width: 100%;
  height: 100%;
}
</style>
