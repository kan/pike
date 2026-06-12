<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { Bot, ChevronDown } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { confirmDialog } from '../../composables/useConfirmDialog'
import { readClipboardImages, saveImageFile } from '../../composables/useImagePaste'
import { ptyRouter } from '../../composables/usePtyRouter'
import { useI18n } from '../../i18n'
import { isAbsolutePath, joinPath, pathSep } from '../../lib/paths'
import { openUrlWithConfirm, ptyKill, ptyResize, ptySpawn, ptyWrite } from '../../lib/tauri'
import {
  asPathHeader,
  findPathLinks,
  isRgBodyLine,
  type PathLinkTarget,
  parseRgMatchLine,
} from '../../lib/terminalLinks'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useTabStore } from '../../stores/tabs'
import '@xterm/xterm/css/xterm.css'

const { t } = useI18n()

const props = defineProps<{
  tabId: string
}>()

const SPAWN_GRACE_PERIOD_MS = 2000

/**
 * Build the command line that runs `autoStart` in the spawned shell.
 * When `closeOnExit` is true, wraps the command so the shell exits with the
 * command's status (→ PTY closes → non-pinned tabs auto-close).
 */
function buildAutoStartLine(autoStart: string, shellKind: string | undefined, closeOnExit?: boolean): string {
  if (closeOnExit) {
    if (shellKind === 'cmd') return `cls & ${autoStart} & exit /B %ERRORLEVEL%`
    if (shellKind === 'powershell') return `cls; ${autoStart}; exit $LASTEXITCODE`
    return `clear; ${autoStart}; exit`
  }
  const clearCmd = shellKind === 'cmd' || shellKind === 'powershell' ? 'cls' : 'clear'
  const chain = shellKind === 'powershell' ? '; ' : ' && '
  return clearCmd + chain + autoStart
}

const tabStore = useTabStore()
const settingsStore = useSettingsStore()
const projectStore = useProjectStore()

// One-click coding-agent launchers (`clear && claude` etc.), injected into the
// current shell. Configurable in Settings; the first entry is the primary button.
const agentCommands = computed(() => settingsStore.agentCommands)
const agentMenuOpen = ref(false)
// Hidden while a full-screen TUI owns the alternate screen buffer (vim, less,
// lazygit, …) so the launcher can't inject text into a running program.
const inAltScreen = ref(false)

function runAgentCommand(command: string) {
  agentMenuOpen.value = false
  if (!ptyId) return
  const tabData = tabStore.tabs.find((t) => t.id === props.tabId)
  const shellKind = tabData?.kind === 'terminal' ? tabData.shell?.kind : undefined
  const line = buildAutoStartLine(command, shellKind, false)
  ptyWrite(ptyId, `${line}\r`).catch(() => {})
  terminal?.focus()
}

// Resolve a `path:line` link from terminal output to an editor tab. Relative
// paths resolve against `activeRoot` (same base as search / diagnostics).
function openPathLink(target: PathLinkTarget) {
  const project = projectStore.currentProject
  if (!project) return
  const sep = pathSep(project.shell)
  const full = isAbsolutePath(target.path) ? target.path : joinPath(projectStore.activeRoot, target.path, sep)
  tabStore.addEditorTab({ path: full, initialLine: target.line })
}

// Walk up from a rg/grep match line to its filename header (matches are grouped
// under a bare path when rg writes to a TTY). Stops at the first non-body line.
function findHeaderPathAbove(term: Terminal, y: number): string | null {
  for (let yy = y - 1; yy >= 1 && yy >= y - 500; yy--) {
    const line = term.buffer.active.getLine(yy - 1)
    if (!line) return null
    const s = line.translateToString(true).trim()
    if (s === '') return null // blank line = group boundary, no header reached
    if (isRgBodyLine(s)) continue // another match / context line — keep climbing
    return asPathHeader(s) // header path, or null if it's an unrelated line
  }
  return null
}

// Register a link provider that makes `path:line(:col)` references clickable, plus
// rg/grep grouped output (line number → header path). Builds a char→cell-column
// map per row so ranges stay correct across wide chars.
function registerPathLinks(term: Terminal) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const bufLine = term.buffer.active.getLine(y - 1)
      if (!bufLine) {
        callback(undefined)
        return
      }
      let text = ''
      const colAt: number[] = []
      for (let x = 0; x < bufLine.length; x++) {
        const cell = bufLine.getCell(x)
        if (!cell) continue
        if (cell.getWidth() === 0) continue // trailing cell of a wide char
        const chars = cell.getChars() || ' '
        for (let k = 0; k < chars.length; k++) colAt.push(x + 1)
        text += chars
      }
      const links: ReturnType<typeof makeLink>[] = []
      const makeLink = (start: number, end: number, target: PathLinkTarget) => ({
        text: text.slice(start, end + 1),
        range: { start: { x: colAt[start] ?? 1, y }, end: { x: colAt[end] ?? term.cols, y } },
        activate: () => openPathLink(target),
      })

      const matches = findPathLinks(text)
      for (const mt of matches) {
        links.push(makeLink(mt.index, mt.index + mt.length - 1, mt))
      }

      if (matches.length === 0) {
        // rg/grep grouped match line: link the leading line number to its header.
        const rg = parseRgMatchLine(text)
        if (rg) {
          const header = findHeaderPathAbove(term, y)
          if (header) links.push(makeLink(0, rg.numLen - 1, { path: header, line: rg.line }))
        }
        // A bare path line (rg header, `ls` of one file): open it at line 1.
        const header = asPathHeader(text)
        if (header) {
          const start = text.indexOf(header)
          links.push(makeLink(start, start + header.length - 1, { path: header, line: 1 }))
        }
      }

      callback(links.length > 0 ? links : undefined)
    },
  })
}

function toggleAgentMenu() {
  agentMenuOpen.value = !agentMenuOpen.value
  if (agentMenuOpen.value) {
    nextTick(() => window.addEventListener('mousedown', closeAgentMenu, { once: true }))
  }
}

function closeAgentMenu() {
  window.removeEventListener('mousedown', closeAgentMenu)
  agentMenuOpen.value = false
}

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

// Grace period: suppress hasActivity for bells arriving shortly after tab activation
// (some TUIs ring the bell on focus/redraw).
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
  terminal.loadAddon(new WebLinksAddon((_e, uri) => openUrlWithConfirm(uri)))
  registerPathLinks(terminal)

  terminal.open(termRef.value)
  fitAddon.fit()

  terminal.buffer.onBufferChange((buf) => {
    inAltScreen.value = buf.type === 'alternate'
    if (inAltScreen.value) closeAgentMenu()
  })

  const cols = terminal.cols
  const rows = terminal.rows

  const tabData = tabStore.tabs.find((t) => t.id === props.tabId)
  const spawnOpts = tabData?.kind === 'terminal' ? { cwd: tabData.cwd, shell: tabData.shell } : undefined

  let spawnedAt = 0
  try {
    const result = await ptySpawn(cols, rows, spawnOpts)
    ptyId = result.id
    spawnedAt = Date.now()
    tabStore.setPtyId(props.tabId, ptyId)
  } catch (e) {
    terminal.write(`\r\n${t('terminal.failedSpawn', { error: String(e) })}\r\n`)
    const tab = tabStore.tabs.find((t) => t.id === props.tabId)
    // -1 indicates spawn failure so the badge distinguishes it from a real exit code
    if (tab?.kind === 'terminal') tab.exitCode = -1
    return
  }

  // Bell-driven activity: TUIs (Claude Code, shells with `\a` in PS1, etc.)
  // ring BEL when they want attention. Marking activity on every byte of
  // output was too noisy for agents that stream tokens continuously.
  terminal.onBell(() => {
    if (Date.now() - lastActivatedAt <= 500) return
    tabStore.markTabActivity(props.tabId)
  })

  const termRef_ = terminal
  ptyRouter.register(
    ptyId,
    (data) => {
      termRef_.write(data)
    },
    (code) => {
      termRef_.write(`\r\n${t('terminal.exited', { code: String(code) })}\r\n`)
      const tab = tabStore.tabs.find((t) => t.id === props.tabId)
      if (tab?.kind === 'terminal') {
        tab.exitCode = code
        // A PTY that dies within the grace period is almost always a failed
        // autoStart or bad shell config — keep the tab so the user can read
        // the error instead of having it vanish.
        const aliveFor = Date.now() - spawnedAt
        if (!tab.pinned && aliveFor >= SPAWN_GRACE_PERIOD_MS) {
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

    const shellKind = tabData.shell?.kind
    const clearCmd = shellKind === 'cmd' || shellKind === 'powershell' ? 'cls' : 'clear'

    if (tabData.autoStart) {
      initLines.push(buildAutoStartLine(tabData.autoStart, shellKind, tabData.closeOnExit))
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

  // Delegate to terminal.paste() for bracket paste mode support and to avoid
  // ConPTY truncation (Rust pty_write chunks at 4KB).
  async function pasteText(text: string) {
    if (!ptyId || !terminal) return
    if (text.includes('\n') || text.includes('\r')) {
      if (!(await confirmDialog(t('confirm.pasteNewlines')))) {
        terminal.focus()
        return
      }
    }
    terminal.paste(text)
    terminal.focus()
  }

  // 画像優先 → なければテキストの順で paste。右クリックと Ctrl+V の両方から呼ぶ。
  async function pasteFromClipboard() {
    if (!ptyId) return
    const images = await readClipboardImages()
    if (images.length > 0) {
      for (const file of images) {
        try {
          const relPath = await saveImageFile(file)
          ptyWrite(ptyId, relPath).catch((err) => console.error('[terminal] ptyWrite failed:', err))
        } catch (err) {
          console.error('[terminal] saveImageFile failed:', err)
        }
      }
      terminal?.focus()
      return
    }
    const text = await navigator.clipboard.readText().catch(() => '')
    if (text) await pasteText(text)
  }

  termRef.value?.addEventListener('contextmenu', async (e) => {
    e.preventDefault()
    if (!settingsStore.terminalRightClickPaste || !ptyId) return
    await pasteFromClipboard()
  })

  // xterm.js は Windows で Ctrl+V を SYN(\x16) として PTY に流すので、
  // 通常の `paste` イベントが発火しない → keydown レベルで横取りする。
  // Ctrl+Shift+V も同じ扱いに（Windows Terminal 互換）。
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    if (!e.ctrlKey || e.altKey || e.metaKey) return true
    if (e.key.toLowerCase() !== 'v') return true
    e.preventDefault()
    pasteFromClipboard()
    return false
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
  window.removeEventListener('mousedown', closeAgentMenu)
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
    <div v-if="agentCommands.length && !inAltScreen" class="agent-launch" :class="{ open: agentMenuOpen }">
      <button
        class="agent-btn primary"
        :title="agentCommands[0].command"
        @click="runAgentCommand(agentCommands[0].command)"
      >
        <Bot :size="14" :stroke-width="2" />
      </button>
      <button class="agent-btn caret" :title="t('terminal.agentLaunch')" @click="toggleAgentMenu">
        <ChevronDown :size="12" :stroke-width="2" />
      </button>
      <div v-if="agentMenuOpen" class="agent-menu" @mousedown.stop>
        <button
          v-for="(c, i) in agentCommands"
          :key="i"
          class="agent-menu-item"
          @click="runAgentCommand(c.command)"
        >
          <span class="agent-menu-label">{{ c.label }}</span>
          <span class="agent-menu-cmd">{{ c.command }}</span>
        </button>
      </div>
    </div>
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

.agent-launch {
  position: absolute;
  top: 6px;
  right: 16px;
  z-index: 5;
  display: flex;
  opacity: 0.3;
  transition: opacity 0.15s;
}

.terminal-wrapper:hover .agent-launch,
.agent-launch.open {
  opacity: 1;
}

.agent-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 5px;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
}

.agent-btn.primary {
  border-radius: 4px 0 0 4px;
  border-right: none;
}

.agent-btn.caret {
  border-radius: 0 4px 4px 0;
  padding: 0 2px;
}

.agent-btn:hover {
  color: var(--text-active);
  background: var(--tab-hover-bg);
}

.agent-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 180px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
  z-index: 10;
}

.agent-menu-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}

.agent-menu-item:hover {
  background: var(--accent);
  color: var(--text-active);
}

.agent-menu-label {
  font-size: 12px;
}

.agent-menu-cmd {
  font-size: 10px;
  color: var(--text-secondary);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.agent-menu-item:hover .agent-menu-cmd {
  color: rgba(255, 255, 255, 0.7);
}
</style>
