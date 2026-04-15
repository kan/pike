<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { confirmDialog } from '../../composables/useConfirmDialog'
import { getClipboardImages, saveImageFile } from '../../composables/useImagePaste'
import { ptyRouter } from '../../composables/usePtyRouter'
import { useI18n } from '../../i18n'
import { isAbsolutePath } from '../../lib/paths'
import { ptyKill, ptyResize, ptySpawn, ptyWrite } from '../../lib/tauri'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import '@xterm/xterm/css/xterm.css'

const { t } = useI18n()

const props = defineProps<{
  tabId: string
}>()

const tabStore = useTabStore()
const settingsStore = useSettingsStore()

const termRef = ref<HTMLDivElement>()
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let ptyId: string | null = null
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let windowFocusHandler: (() => void) | null = null
let lastCols = 0
let lastRows = 0

const SHELL_EXECUTABLES = new Set([
  'wsl.exe',
  'wsl',
  'cmd.exe',
  'cmd',
  'powershell.exe',
  'powershell',
  'pwsh.exe',
  'pwsh',
  'bash.exe',
  'bash',
  'sh',
  'zsh',
  'fish',
])

const SHELL_WINDOW_TITLES = new Set(['windows powershell', 'command prompt', 'administrator: windows powershell'])

function parseTerminalTitle(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  // Full Windows paths like "C:\Windows\System32\wsl.exe"
  if (/^[a-zA-Z]:\\/.test(t)) {
    const base = t.split('\\').pop()!
    if (SHELL_EXECUTABLES.has(base.toLowerCase())) return null
    return base.replace(/\.exe$/i, '')
  }
  // Known shell window titles
  if (SHELL_WINDOW_TITLES.has(t.toLowerCase())) return null
  // Bare shell executable names
  if (SHELL_EXECUTABLES.has(t.toLowerCase())) return null
  // "user@host: ~/path" → path part
  let cleaned = t
  const colonSpace = cleaned.lastIndexOf(': ')
  if (colonSpace !== -1) cleaned = cleaned.slice(colonSpace + 2)
  // "MINGW64:/c/Users/..." → path part
  const prefixColon = cleaned.indexOf(':')
  if (prefixColon !== -1 && prefixColon < cleaned.length - 1 && cleaned[prefixColon + 1] === '/') {
    cleaned = cleaned.slice(prefixColon + 1)
  }
  cleaned = cleaned.trim()
  // Path → last component
  if (cleaned.includes('/') || cleaned.includes('\\')) {
    const last = cleaned.split(/[/\\]/).filter(Boolean).pop()
    if (last) cleaned = last
  }
  return cleaned || null
}

// Only resize the active tab (hidden tabs have 0×0 dimensions via v-show)
function doFit() {
  if (!fitAddon || !terminal || !ptyId) return
  if (tabStore.activeTabId !== props.tabId) return
  fitAddon.fit()
  if (terminal.cols > 0 && terminal.rows > 0 && (terminal.cols !== lastCols || terminal.rows !== lastRows)) {
    lastCols = terminal.cols
    lastRows = terminal.rows
    ptyResize(ptyId, lastCols, lastRows)
  }
}

// Shrink by 1 col then restore to trigger SIGWINCH, making TUI apps redraw
function nudgePtyResize(delayMs: number) {
  if (!ptyId || !terminal || terminal.cols <= 1) return
  const { cols, rows } = terminal
  ptyResize(ptyId, cols - 1, rows)
  setTimeout(() => {
    if (ptyId) ptyResize(ptyId, cols, rows)
  }, delayMs)
}

// Grace period: suppress hasActivity for output arriving shortly after tab activation
// (resize nudge → SIGWINCH → prompt redraw produces spurious output)
let lastActivatedAt = 0

watch(
  () => tabStore.activeTabId,
  (newId) => {
    if (newId === props.tabId) {
      lastActivatedAt = Date.now()
      // Double rAF ensures v-show transition is fully resolved before measuring
      nextTick(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            doFit()
            if (terminal) {
              terminal.refresh(0, terminal.rows - 1)
              terminal.focus()
              nudgePtyResize(50)
            }
          })
        })
      })
    }
  },
)

// Apply settings changes to live terminal.
// Inactive tabs get a resize nudge when they become active (tab activation watcher above).
watch(
  () => settingsStore.xtermTheme,
  (theme) => {
    if (!terminal) return
    terminal.options.theme = theme
    terminal.refresh(0, terminal.rows - 1)
    if (tabStore.activeTabId === props.tabId) nudgePtyResize(200)
  },
)
watch(
  () => settingsStore.fontFamily,
  (v) => {
    if (!terminal) return
    terminal.options.fontFamily = v
    doFit()
  },
)
watch(
  () => settingsStore.fontSize,
  (v) => {
    if (!terminal) return
    terminal.options.fontSize = v
    doFit()
  },
)

onMounted(async () => {
  if (!termRef.value) return

  terminal = new Terminal({
    fontFamily: settingsStore.fontFamily,
    fontSize: settingsStore.fontSize,
    theme: settingsStore.xtermTheme,
    scrollback: 5000,
    cursorBlink: true,
    allowProposedApi: true,
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon())

  terminal.open(termRef.value)
  fitAddon.fit()

  const cols = terminal.cols
  const rows = terminal.rows

  const tabData = tabStore.tabs.find((t) => t.id === props.tabId)
  const spawnOpts = tabData?.kind === 'terminal' ? { cwd: tabData.cwd, shell: tabData.shell } : undefined

  try {
    const result = await ptySpawn(cols, rows, spawnOpts)
    ptyId = result.id
    tabStore.setPtyId(props.tabId, ptyId)
  } catch (e) {
    terminal.write(`\r\n${t('terminal.failedSpawn', { error: String(e) })}\r\n`)
    return
  }

  const termRef_ = terminal
  ptyRouter.register(
    ptyId,
    (data) => {
      termRef_.write(data)
      if (tabStore.activeTabId !== props.tabId && Date.now() - lastActivatedAt > 500) {
        const tab = tabStore.tabs.find((t) => t.id === props.tabId)
        if (tab?.kind === 'terminal') tab.hasActivity = true
      }
    },
    (code) => {
      termRef_.write(`\r\n${t('terminal.exited', { code: String(code) })}\r\n`)
      const tab = tabStore.tabs.find((t) => t.id === props.tabId)
      if (tab?.kind === 'terminal') {
        tab.exitCode = code
        // Auto-close non-pinned tabs after a brief delay
        if (!tab.pinned) {
          setTimeout(() => tabStore.closeTab(props.tabId), 1000)
        }
      }
    },
  )

  if (tabData?.kind === 'terminal') {
    const isBash = !tabData.shell || tabData.shell.kind === 'wsl' || tabData.shell.kind === 'git-bash'
    const currentPtyId = ptyId
    const initLines: string[] = []

    if (isBash) {
      // Set up bash title reporting: show running command, revert to dir on prompt.
      // Also overrides stale ConPTY titles (Tauri plugin names leak into Git Bash).
      const titleSetup =
        '__pike_prompt() { printf \'\\e]0;%s\\a\\e]7;file://localhost%s\\a\' "${PWD##*/}" "$PWD"; }; ' +
        'PROMPT_COMMAND="__pike_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; ' +
        'trap \'[[ "$BASH_COMMAND" == _* ]] || printf "\\e]0;%s\\a" "${BASH_COMMAND%% *}"\' DEBUG'
      initLines.push(titleSetup)
    }

    // Shell-appropriate clear + command chaining
    const shellKind = tabData.shell?.kind
    const clearCmd = shellKind === 'cmd' || shellKind === 'powershell' ? 'cls' : 'clear'
    const chain = shellKind === 'powershell' ? '; ' : ' && '

    if (tabData.autoStart) {
      initLines.push(clearCmd + chain + tabData.autoStart)
    } else if (initLines.length > 0) {
      initLines.push(clearCmd)
    }

    if (initLines.length > 0) {
      setTimeout(() => {
        termRef_.clear()
        ptyWrite(currentPtyId, `${initLines.join('\r')}\r`).catch(() => {})
      }, 100)
    }
  }

  lastCols = terminal.cols
  lastRows = terminal.rows

  // IME dedup: some IMEs (e.g. CorvusSKK) can fire both compositionend and
  // input(insertText) for the same committed text, causing onData to trigger
  // twice. Guard by rejecting identical non-ASCII data within 30ms.
  let lastIMEData = ''
  let lastIMETime = 0
  terminal.onData((data) => {
    if (!ptyId) return
    if (data.split('').some((c) => c.charCodeAt(0) > 127)) {
      const now = Date.now()
      if (data === lastIMEData && now - lastIMETime < 30) return
      lastIMEData = data
      lastIMETime = now
    }
    ptyWrite(ptyId, data.replace(/\r\n/g, '\r')).catch(() => {})
  })

  terminal.onTitleChange((raw) => {
    if (!raw) return
    const title = parseTerminalTitle(raw)
    if (title) {
      tabStore.setTabTitle(props.tabId, title)
    }
  })

  terminal.onSelectionChange(() => {
    if (!settingsStore.terminalCopyOnSelect || !terminal) return
    const text = terminal.getSelection()
    if (text) navigator.clipboard.writeText(text.replace(/\r\n/g, '\n')).catch(() => {})
  })

  // Shared paste helper: confirm newlines, normalize line endings, write to PTY.
  // Rust pty_write handles chunking internally to avoid ConPTY pipe buffer overflow.
  async function pasteText(text: string) {
    if (!ptyId) return
    if (text.includes('\n') || text.includes('\r')) {
      if (!(await confirmDialog(t('confirm.pasteNewlines')))) {
        terminal?.focus()
        return
      }
    }
    await ptyWrite(ptyId, text.replace(/\r\n/g, '\r').replace(/\n/g, '\r'))
    terminal?.focus()
  }

  // Right-click paste (guard: termRef may be null if component unmounted during pty_spawn await)
  termRef.value?.addEventListener('contextmenu', async (e) => {
    e.preventDefault()
    if (!settingsStore.terminalRightClickPaste || !ptyId) return
    const text = await navigator.clipboard.readText().catch(() => '')
    if (text) await pasteText(text)
  })

  // Explicit paste handler — xterm.js default paste can lose data with large text on ConPTY.
  termRef.value?.addEventListener('paste', async (e: Event) => {
    const ce = e as ClipboardEvent
    if (!ptyId) return

    const images = getClipboardImages(ce)
    if (images.length > 0) {
      ce.preventDefault()
      ce.stopPropagation()
      for (const file of images) {
        try {
          const relPath = await saveImageFile(file)
          ptyWrite(ptyId, relPath).catch(() => {})
        } catch {
          // silently ignore — non-critical feature
        }
      }
      terminal?.focus()
      return
    }

    const text = ce.clipboardData?.getData('text/plain')
    if (!text) return
    ce.preventDefault()
    ce.stopPropagation()
    await pasteText(text)
  })

  termRef.value?.addEventListener('dragover', (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('text/plain') || e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
  })
  termRef.value?.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    if (!ptyId) return
    const path = e.dataTransfer?.getData('text/plain')
    if (path && isAbsolutePath(path)) {
      const quoted = path.includes(' ') ? `"${path}"` : path
      ptyWrite(ptyId, quoted).catch(() => {})
      terminal?.focus()
      return
    }
    if (e.dataTransfer?.files.length) {
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith('image/')) {
          saveImageFile(file)
            .then((relPath) => ptyWrite(ptyId!, relPath))
            .catch(() => {})
        }
      }
      terminal?.focus()
    }
  })

  // Re-focus xterm textarea when window regains focus from outside,
  // so IME composition events are correctly captured by xterm.js.
  windowFocusHandler = () => {
    if (terminal && tabStore.activeTabId === props.tabId) {
      terminal.focus()
    }
  }
  window.addEventListener('focus', windowFocusHandler)

  resizeObserver = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => doFit(), 100)
  })
  if (termRef.value) resizeObserver.observe(termRef.value)
})

onUnmounted(() => {
  if (windowFocusHandler) window.removeEventListener('focus', windowFocusHandler)
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  if (ptyId) {
    ptyRouter.unregister(ptyId)
    ptyKill(ptyId).catch(() => {})
  }
  terminal?.dispose()
})
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
  background: v-bind('settingsStore.colorScheme.background');
}

.terminal-inner {
  width: 100%;
  height: 100%;
}
</style>
