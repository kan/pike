<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { Bot, ChevronDown, ChevronLeft, MessageSquareText } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { confirmDialog } from '../../composables/useConfirmDialog'
import {
  MAX_UPLOAD_SIZE,
  readClipboardImages,
  saveUploadFile,
  toMb,
  UploadTooLargeError,
} from '../../composables/useImagePaste'
import { ptyRouter } from '../../composables/usePtyRouter'
import { useI18n } from '../../i18n'
import { agentById, commandMentionsAgent, launcherLines } from '../../lib/agents'
import { isMacHost, isWindowsHost } from '../../lib/host'
// 一時的な調査用ログ（TODO「謎のバックスペース」）。原因が判明したら削除する。
import { imeLog, imeLogSessionStart } from '../../lib/imeDebugLog'
import { parkFocusForIme } from '../../lib/imeFocusPark'
import { normalizedKey } from '../../lib/keys'
import { openPathInTab } from '../../lib/openFile'
import { openUrlWithConfirm } from '../../lib/openUrl'
import { isAbsolutePath, joinPath, pathSep, relativeTime } from '../../lib/paths'
import { pikeTakesTerminalKey } from '../../lib/shortcuts'
import { claudeSessionsList, ptyGetCwd, ptyKill, ptyPasteText, ptyResize, ptySpawn, ptyWrite } from '../../lib/tauri'
import {
  asPathHeader,
  findPathLinks,
  isRgBodyLine,
  type PathLinkTarget,
  parseRgMatchLine,
} from '../../lib/terminalLinks'
import { elevated } from '../../lib/window'
import { useAgentStore } from '../../stores/agents'
import { useProjectStore } from '../../stores/project'
import { useSettingsStore } from '../../stores/settings'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import type { ClaudeSession } from '../../types/claudeUsage'
import { isPowershellFamily } from '../../types/tab'
import HelpButton from '../HelpButton.vue'
import '@xterm/xterm/css/xterm.css'

const { t } = useI18n()

const props = defineProps<{
  tabId: string
}>()

const SPAWN_GRACE_PERIOD_MS = 2000

/** xterm が Backspace として送るバイト。IME 確定直後の誤送出の判定にも使う。 */
const DEL = '\x7f'
/** 確定文字を控えておく時間。xterm 側の誤送出は確定の 10ms 前後で来る。 */
const COMMIT_DEL_WINDOW_MS = 100

/** `split('')` で 1 文字ずつ配列に起こさずに済ませる（ペーストもここを通る）。 */
function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return true
  }
  return false
}

// Shown once per (elevated) process: elevation is a Windows-host attribute and
// does not make WSL terminals root, so an admin window opening a WSL shell is
// almost pointless (#138). Module-scoped so it fires only the first time.
let wslElevationNoticed = false

/**
 * Build the command line that runs `autoStart` in the spawned shell.
 * When `closeOnExit` is true, wraps the command so the shell exits with the
 * command's status (→ PTY closes → non-pinned tabs auto-close).
 */
function buildAutoStartLine(autoStart: string, shellKind: string | undefined, closeOnExit?: boolean): string {
  if (closeOnExit) {
    if (shellKind === 'cmd') return `cls & ${autoStart} & exit /B %ERRORLEVEL%`
    if (isPowershellFamily(shellKind)) return `cls; ${autoStart}; exit $LASTEXITCODE`
    return `clear; ${autoStart}; exit`
  }
  const clearCmd = shellKind === 'cmd' || isPowershellFamily(shellKind) ? 'cls' : 'clear'
  const chain = isPowershellFamily(shellKind) ? '; ' : ' && '
  return clearCmd + chain + autoStart
}

const tabStore = useTabStore()
const settingsStore = useSettingsStore()
const projectStore = useProjectStore()
const statusMessage = useStatusMessageStore()

/**
 * ワンクリックでエージェントを起動する行（#275 / #267）。**一覧は設定の
 * `agentLaunchers` 1 本**で、表のエージェント（PATH にあるものだけ）と利用者が書いた行が
 * 同じ順序に並ぶ。押しても `command not found` になる項目を並べないため、表のほうは
 * 検出を通してから出す。
 */
const agentStore = useAgentStore()
/** 既定の起動行。ボタン本体とメニューの第 1 階層はこれ。 */
const defaultLauncher = computed(() => agentStore.launchers[0] ?? null)
/** 既定以外。「他のエージェント」のサブメニューに入る。 */
const otherLaunchers = computed(() => agentStore.launchers.slice(1))
/** 既定の行が出すコマンド（エージェントなら素の起動と「続きから」、カスタムなら 1 行）。 */
const defaultLines = computed(() => (defaultLauncher.value ? launcherLines(defaultLauncher.value) : []))
/** ボタン本体で走る行。 */
const primaryCommand = computed(() => defaultLines.value[0] ?? null)
const agentMenuOpen = ref(false)
/** 「他のエージェント」のサブメニュー（ホバーで開く）。 */
const agentSubOpen = ref(false)
// Reusable instruction snippets injected (as text, not submitted) into the
// running agent in the current terminal. Configurable in Settings.
const agentPrompts = computed(() => settingsStore.agentPrompts)
const promptMenuOpen = ref(false)
// Hidden while a full-screen TUI owns the alternate screen buffer (vim, less,
// lazygit, …) so the launcher can't inject text into a running program.
const inAltScreen = ref(false)
// True while the foreground app has mouse reporting enabled. Claude Code's
// fullscreen render mode (and other interactive agents) enable it; plain
// vim/less don't. We use this to keep the prompt-inject button available even
// in the alternate screen — that's exactly when you want to feed a running
// agent a snippet — while still hiding it for pure editors/pagers.
const mouseActive = ref(false)

// The launcher only makes sense when nothing is running fullscreen.
const showAgentLaunch = computed(() => !inAltScreen.value && primaryCommand.value !== null)
// The prompt-inject button also shows in the alt-screen when an interactive,
// mouse-reporting app (an agent) owns it.
const showPromptInject = computed(() => (!inAltScreen.value || mouseActive.value) && agentPrompts.value.length > 0)

/** Run a launcher entry in the shell as-is. No `clear` in front: today's agents
 *  render in place and keep the scrollback readable above themselves. */
function runAgentCommand(command: string) {
  agentMenuOpen.value = false
  if (!ptyId) return
  ptyWrite(ptyId, `${command}\r`).catch(() => {})
  terminal?.focus()
}

/** This tab's terminal record — the store owns its shell and cwd. */
function terminalTab() {
  const tab = tabStore.tabs.find((t) => t.id === props.tabId)
  return tab?.kind === 'terminal' ? tab : undefined
}

// Past Claude Code sessions of this terminal's directory, i.e. what `claude -r`
// would offer. Loaded when the launcher menu opens (the transcripts live on
// disk — over the WSL share for WSL projects — so it isn't worth polling).
const claudeSessions = ref<ClaudeSession[]>([])
const sessionsLoading = ref(false)
/**
 * セッションの一覧を出すか。**Claude Code 専用**（`claudeSessionsList` も
 * `claude --resume` も見出しも Claude 固定なので、表のフラグで一般化した振りをしない。
 * 広げるのは #267 の残りで、一覧の取得と再開コマンドを id で分ける作業）。
 *
 * **既定の行が claude を起動していれば出す。** カスタム行のときに字面を見る
 * （`commandMentionsAgent`）のは、wrapper 越しに起動している利用者（`npx claude`、
 * `docker compose exec -T dev claude`）から一覧が消えないため。**既定でないときに
 * 出さない**のは、一覧が第 1 階層にあるから（サブメニューの中の行の履歴をここに混ぜると、
 * どれの履歴か読めなくなる）。Codex だけの環境に disk scan を払わせない意味もある。
 */
const showClaudeSessions = computed(() => {
  const claude = agentById('claude')
  const l = defaultLauncher.value
  if (!claude || !l) return false
  return l.kind === 'agent' ? l.id === 'claude' : commandMentionsAgent(l.command, claude)
})

function resumeCommand(session: ClaudeSession): string {
  return `claude --resume ${session.id}`
}

/**
 * このシェルで使えるエージェントを調べる（#275）。**PTY を起こしたあとに撃ち、待たない**:
 * 答えが返るまでボタンが出ないだけで、起動は止めない。
 *
 * 「検出のためだけに起動時へ `wsl.exe` を足さない」（`project.md`）の例外で、issue
 * パネルの `gh` と同じ理由。**ボタンを出すかどうかが答えに依存する**ので、メニューを
 * 開くまで遅らせられない。実際に聞くかはストアが決める（同じシェルなら何もしない）ので、
 * 2 枚目以降のタブは IPC も飛ばない。
 */
function detectAgents() {
  const tabData = terminalTab()
  void agentStore.detect(tabData?.shell ?? projectStore.currentProject?.shell, tabData?.cwd ?? projectStore.activeRoot)
}

async function loadClaudeSessions() {
  const tabData = terminalTab()
  const project = projectStore.currentProject
  const shell = tabData?.shell ?? project?.shell
  // Where `claude` would actually run: the shell's live directory (tracked from
  // OSC 7, so a `cd` is reflected), falling back to what the tab was opened at.
  const root = (ptyId ? await ptyGetCwd(ptyId) : null) ?? tabData?.cwd ?? projectStore.activeRoot
  if (!shell || !root) {
    claudeSessions.value = []
    return
  }
  sessionsLoading.value = true
  // Keep the previous list on screen while refreshing — reopening the menu
  // should not blank it out.
  claudeSessions.value = await claudeSessionsList(shell, root).catch(() => [])
  sessionsLoading.value = false
}

// Resolve a `path:line` link from terminal output to a tab. Relative paths
// resolve against `activeRoot` (same base as search / diagnostics).
//
// Goes through `openPathInTab` rather than `addEditorTab` so the extension
// routing applies: a terminal link to a PNG or a PDF used to land in CodeMirror
// and trip its binary guard. A path that is a directory reaches the editor tab
// too, which offers to open it as a project instead of reporting a read error.
function openPathLink(target: PathLinkTarget) {
  const project = projectStore.currentProject
  if (!project) return
  const sep = pathSep(project.shell)
  const full = isAbsolutePath(target.path) ? target.path : joinPath(projectStore.activeRoot, target.path, sep)
  openPathInTab({ path: full, line: target.line, shell: project.shell }).catch(() => {})
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

      // rg/grep grouped match line: link the leading line number to its header.
      //
      // **`matches.length === 0` を条件にしないこと。** `findPathLinks` は行番号の無い
      // パスも拾うようになった（#252）ので、`12:const x = require('./foo.js')` のような
      // マッチ行では他のリンクが立ち、先頭の行番号がリンクにならなくなる。重なりだけを
      // 見て、先頭の数字を誰も使っていなければ張る。
      const rg = parseRgMatchLine(text)
      if (rg && !matches.some((mt) => mt.index < rg.numLen)) {
        const header = findHeaderPathAbove(term, y)
        if (header) links.push(makeLink(0, rg.numLen - 1, { path: header, line: rg.line }))
      }
      // 拡張子を持たない裸のパス行（rg のヘッダ、`ls` の 1 件）。`findPathLinks` は
      // 拡張子を必須にしているので、ここだけが拾える。
      if (matches.length === 0) {
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
  closePromptMenu()
  agentMenuOpen.value = !agentMenuOpen.value
  if (agentMenuOpen.value) {
    if (showClaudeSessions.value) void loadClaudeSessions()
    nextTick(() => window.addEventListener('mousedown', closeAgentMenu, { once: true }))
  }
}

function closeAgentMenu() {
  window.removeEventListener('mousedown', closeAgentMenu)
  agentMenuOpen.value = false
  agentSubOpen.value = false
}

// Inject a prompt's text into the current PTY. Bracketed paste keeps a multi-line
// prompt as one input (no early submit); no trailing CR — the user reviews and
// presses Enter themselves.
function injectPrompt(text: string) {
  promptMenuOpen.value = false
  if (!ptyId) return
  ptyPasteText(ptyId, text).catch(() => {})
  terminal?.focus()
}

function togglePromptMenu() {
  closeAgentMenu()
  promptMenuOpen.value = !promptMenuOpen.value
  if (promptMenuOpen.value) {
    nextTick(() => window.addEventListener('mousedown', closePromptMenu, { once: true }))
  }
}

function closePromptMenu() {
  window.removeEventListener('mousedown', closePromptMenu)
  promptMenuOpen.value = false
}

const termRef = ref<HTMLDivElement>()

let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let ptyId: string | null = null
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let windowFocusHandler: (() => void) | null = null
let windowBlurHandler: (() => void) | null = null
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

// 描かれているタブだけ測る（隠れているタブは `v-show` で 0×0）。**分割すると見えている
// タブは 2 枚になる**ので、フォーカスの有無ではなく `isTabVisible` を見る（#308）。
function doFit() {
  if (!fitAddon || !terminal || !ptyId) return
  if (!tabStore.isTabVisible(props.tabId)) return
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

// Run `cb` after two animation frames. Used both to let a v-show transition
// fully resolve before measuring, and for the IME readOnly bounce where each
// state must land on its own frame so the renderer sends it as a separate
// update instead of deduping the round trip.
function afterTwoFrames(cb: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(cb))
}

/**
 * 描かれるようになったら測り直す。**「見えたか」と「打鍵の行き先になったか」を分ける**
 * （#308）: 分割すると 2 枚が同時に見えているので、測り直しを片方だけに絞ると、
 * 反対のペインの xterm が 0×0 のまま残る。
 */
watch(
  () => tabStore.isTabVisible(props.tabId),
  (visible) => {
    if (!visible) return
    lastActivatedAt = Date.now()
    // **使えるエージェントも聞き直す（#275）。** プロジェクトを切り替えるとストアが
    // 捨てられる（シェルが変わりうるので）が、#264 でタブは生き続けるため PTY は
    // 起こし直されない。spawn の 1 回だけに任せると、切り替えて戻ったときに
    // 起動ボタンが消えたままになる。ストア側がべき等なので、毎回呼んでよい。
    detectAgents()
    // Double rAF ensures v-show transition is fully resolved before measuring
    nextTick(() => {
      afterTwoFrames(() => {
        doFit()
        if (terminal) {
          terminal.refresh(0, terminal.rows - 1)
          nudgePtyResize(50)
        }
      })
    })
  },
)

/** DOM のフォーカスは打鍵の行き先にだけ渡す（見えているだけのタブは奪わない）。 */
watch(
  () => tabStore.isTabFocused(props.tabId),
  (focused) => {
    if (!focused) return
    nextTick(() => {
      afterTwoFrames(() => terminal?.focus())
    })
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
    if (tabStore.isTabVisible(props.tabId)) nudgePtyResize(200)
  },
)
// Window transparency (issue #162): toggle xterm's transparent render path when
// the backdrop mode changes. The theme (translucent background) is updated by
// the xtermTheme watcher above; this only flips allowTransparency + repaints.
watch(
  () => settingsStore.windowBackdrop,
  (kind) => {
    if (!terminal) return
    terminal.options.allowTransparency = kind !== 'none'
    terminal.refresh(0, terminal.rows - 1)
    if (tabStore.isTabVisible(props.tabId)) nudgePtyResize(200)
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
    // Window transparency (issue #162): let the translucent theme background
    // composite over the desktop. Only enabled when a backdrop is active — the
    // opaque default keeps xterm's cheaper non-transparent render path.
    allowTransparency: settingsStore.windowBackdrop !== 'none',
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon((_e, uri) => openUrlWithConfirm(uri)))
  registerPathLinks(terminal)

  terminal.open(termRef.value)
  fitAddon.fit()

  // IME robustness (xterm.js #6012 / the recurring "IME breaks until you switch
  // tabs" bug). xterm only clears the hidden textarea's committed IME text on
  // blur, so composing repeatedly in the same tab lets that text accumulate and
  // eventually corrupts xterm's start-offset bookkeeping (duplicated /
  // mispositioned input). Switching tabs "fixed" it only because leaving blurs
  // the textarea, which clears it.
  //
  // We must NOT simply empty the textarea on every compositionstart: IMEs such as
  // SKK confirm the current conversion by *starting the next input* (no Enter),
  // firing compositionend immediately followed by compositionstart. xterm reads
  // the just-committed text from the textarea in a deferred (setTimeout 0)
  // callback (CompositionHelper._finalizeComposition), so clearing on that
  // compositionstart wipes the committed text before xterm reads it → the whole
  // conversion disappears.
  //
  // Instead, clear the textarea only once a composition has fully finished and no
  // new one has taken over — i.e. after xterm's deferred read has run. Guard with
  // an in-flight flag so compositionstart never clears mid-send. The
  // compositionend listener is on the container in BUBBLE phase, so its
  // setTimeout is queued after xterm's own read (registered on the textarea
  // target) and therefore runs later; the compositionstart listener stays in
  // CAPTURE phase so, when it does clear, it precedes xterm recording the offset.
  imeLogSessionStart(props.tabId)
  let imeSending = false
  let imeComposing = false
  // 「謎のバックスペース」対策（xterm 6.0.0）。IME 有効時の打鍵を監視する
  // CompositionHelper が、数 ms で終わる変換（SKK の wo→を 等）のあとに走ると、
  // 上の textarea クリアを「文字が消えた」と誤認して確定文字の代わりに DEL を
  // 送る（実測で 144 変換に 2 回）。確定直後に単独で来た DEL は確定文字に
  // 差し替える。本来は xterm 側で直すべきもの。
  let pendingCommit: { data: string; at: number } | null = null
  termRef.value.addEventListener(
    'compositionstart',
    () => {
      imeComposing = true
      imeLog('compositionstart', terminal?.textarea?.value ?? '', `sending=${imeSending}`)
      // Regular repeated conversions arrive here with no send pending, so it is
      // safe to reset the offset to 0. During an SKK confirm-by-continue streak a
      // send is still in flight, so leave the textarea intact for xterm to read.
      if (!imeSending && terminal?.textarea) terminal.textarea.value = ''
    },
    true,
  )
  // 調査用: 変換候補の遷移を追う（削除対象）。
  termRef.value.addEventListener('compositionupdate', (e) => {
    imeLog('compositionupdate', (e as CompositionEvent).data ?? '')
  })
  termRef.value.addEventListener('compositionend', (e) => {
    imeComposing = false
    imeSending = true
    const committed = (e as CompositionEvent).data ?? ''
    if (committed) pendingCommit = { data: committed, at: Date.now() }
    imeLog('compositionend', committed, `ta="${terminal?.textarea?.value ?? ''}"`)
    setTimeout(() => {
      imeSending = false
      // If a new composition has already taken over (SKK streak), leave the
      // textarea so xterm's offset bookkeeping for it stays valid; it gets
      // cleared once the streak finally ends with no follow-up composition.
      if (!imeComposing && terminal?.textarea) terminal.textarea.value = ''
    }, 0)
  })
  // 調査用: IME が「確定済みの文字を消す」要求を出しているかを見る。
  // deleteContentBackward が出ていれば BS の出所はこちら側。
  termRef.value.addEventListener('beforeinput', (e) => {
    const ie = e as InputEvent
    imeLog('beforeinput', ie.data ?? '', `type=${ie.inputType} composing=${ie.isComposing}`)
  })
  // 調査用: beforeinput が preventDefault されず実際に適用されたかの裏取り（削除対象）。
  termRef.value.addEventListener('input', (e) => {
    const ie = e as InputEvent
    imeLog('input', ie.data ?? '', `type=${ie.inputType} composing=${ie.isComposing}`)
  })
  // 本人が押した BS / Delete は差し替えの対象外（確定直後でもそのまま通す）。
  // ここは調査用ではないので、imeLog 群を掃除するときも残すこと。
  termRef.value.addEventListener(
    'keydown',
    (e) => {
      const ke = e as KeyboardEvent
      if (ke.key !== 'Backspace' && ke.key !== 'Delete') return
      pendingCommit = null
      // 調査用: BS の出所と、変換中フラグの食い違いを見る（この行だけ削除対象）。
      imeLog('keydown', ke.key, `composing=${ke.isComposing} code=${ke.code}`)
    },
    true,
  )

  // Newly created tabs mount after activeTabId has already changed, so the
  // tab-activation watcher never fires for the initial activation. Without
  // this the "+" button keeps DOM focus and typing goes nowhere (#126).
  if (tabStore.isTabFocused(props.tabId)) terminal.focus()

  terminal.buffer.onBufferChange((buf) => {
    inAltScreen.value = buf.type === 'alternate'
    if (inAltScreen.value) {
      closeAgentMenu()
      closePromptMenu()
    }
  })

  // OSC 52 clipboard write: fullscreen TUIs that enable mouse reporting
  // (Claude Code's fullscreen render mode, vim, etc.) capture mouse drags
  // themselves, so xterm never forms a local selection and our copy-on-select
  // never fires. Such apps instead emit `OSC 52 ; c ; <base64>` to put the
  // selected text on the clipboard. xterm has no built-in handler for this, so
  // we register one. Write-only — clipboard *read* requests ('?') are ignored
  // to avoid leaking clipboard contents to the running program.
  terminal.parser.registerOscHandler(52, (data) => {
    const sep = data.indexOf(';')
    if (sep === -1) return false
    const payload = data.slice(sep + 1)
    if (payload === '?' || payload === '') return true // read request — ignore but consume
    let text: string
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
      text = new TextDecoder('utf-8').decode(bytes)
    } catch {
      return false
    }
    if (text) navigator.clipboard.writeText(text).catch(() => {})
    return true
  })

  // Track mouse-reporting state to decide whether the alt-screen app is an
  // interactive agent (keep prompt-inject available) or a plain editor (hide).
  // DECSET/DECRST private modes use `CSI ? Pm h|l`; re-read the canonical
  // `terminal.modes` after xterm applies the sequence (we return false so the
  // default handler still runs, then sync on a microtask).
  const syncMouseMode = () => {
    queueMicrotask(() => {
      if (terminal) mouseActive.value = terminal.modes.mouseTrackingMode !== 'none'
    })
  }
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, () => {
    syncMouseMode()
    return false
  })
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, () => {
    syncMouseMode()
    return false
  })

  const cols = terminal.cols
  const rows = terminal.rows

  const tabData = terminalTab()
  const spawnOpts = tabData ? { cwd: tabData.cwd, shell: tabData.shell } : undefined

  let spawnedAt = 0
  try {
    const result = await ptySpawn(cols, rows, spawnOpts)
    ptyId = result.id
    spawnedAt = Date.now()
    tabStore.setPtyId(props.tabId, ptyId)
    // 起動ボタンに何を出すか（#275）。待たない。
    detectAgents()
    // Admin window opening a WSL shell: elevation does not carry into WSL.
    if (elevated.value && spawnOpts?.shell?.kind === 'wsl' && !wslElevationNoticed) {
      wslElevationNoticed = true
      statusMessage.show({ text: t('terminal.wslElevationNotice'), variant: 'warn', durationMs: 7000 })
    }
  } catch (e) {
    terminal.write(`\r\n${t('terminal.failedSpawn', { error: String(e) })}\r\n`)
    // -1 indicates spawn failure so the badge distinguishes it from a real exit code
    tabStore.reportExit(props.tabId, -1)
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
      tabStore.reportExit(props.tabId, code)
      const tab = terminalTab()
      if (tab) {
        // A PTY that dies within the grace period is almost always a failed
        // autoStart or bad shell config — keep the tab so the user can read
        // the error instead of having it vanish. `keepOnError` extends that to
        // a command that ran but failed (a clone that could not authenticate).
        const aliveFor = Date.now() - spawnedAt
        const keep = tab.keepOnError && code !== 0
        if (!tab.pinned && !keep && aliveFor >= SPAWN_GRACE_PERIOD_MS) {
          setTimeout(() => tabStore.closeTab(props.tabId), 1000)
        }
      }
    },
  )

  if (tabData?.kind === 'terminal') {
    // 以下で流す OSC 7 のフックは bash 固有（`PROMPT_COMMAND` と `$BASH_COMMAND`）。
    // **シェル未指定を無条件に bash 扱いしないこと**: 未指定の既定はホストで変わり、
    // macOS では zsh になる。zsh は DEBUG トラップを実行するが `$BASH_COMMAND` を
    // 持たないので、コマンドのたびにタイトルが空文字で上書きされる。
    // （macOS で OSC 7 が動かないこと自体は `.claude/rules/platform.md` の既知の制約）
    const isBash = tabData.shell ? tabData.shell.kind === 'wsl' || tabData.shell.kind === 'git-bash' : isWindowsHost
    const currentPtyId = ptyId
    const initLines: string[] = []

    if (isBash) {
      // Set up bash title reporting: show running command, revert to dir on prompt.
      // Also overrides stale ConPTY titles (Tauri plugin names leak into Git Bash).
      // The hook must not clobber `$?`/PIPESTATUS for prompt tools (starship's
      // error color reads them at the start of its own precmd, #128): append
      // after the existing PROMPT_COMMAND so those run first on pristine state,
      // and save/restore `$?` as insurance for hooks appended after ours.
      const titleSetup =
        '__pike_prompt() { local __pike_st=$?; printf \'\\e]0;%s\\a\\e]7;file://localhost%s\\a\' "${PWD##*/}" "$PWD"; return $__pike_st; }; ' +
        'PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}__pike_prompt"; ' +
        'trap \'[[ "$BASH_COMMAND" == _* ]] || printf "\\e]0;%s\\a" "${BASH_COMMAND%% *}"\' DEBUG'
      initLines.push(titleSetup)
    }

    const shellKind = tabData.shell?.kind
    const clearCmd = shellKind === 'cmd' || isPowershellFamily(shellKind) ? 'cls' : 'clear'

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
  terminal.onData((raw) => {
    if (!ptyId) return
    // 確定直後の 1 回だけ有効。差し替えた分の二重送出は下の dedup が吸収する。
    const commit = pendingCommit
    pendingCommit = null
    const data = commit && raw === DEL && Date.now() - commit.at < COMMIT_DEL_WINDOW_MS ? commit.data : raw
    if (data !== raw) imeLog('onData:DEL_FIXUP', data)
    if (hasNonAscii(data)) {
      const now = Date.now()
      if (data === lastIMEData && now - lastIMETime < 30) {
        // 調査用: ここで捨てた分が「消えた 1 文字」の正体かを確かめる。
        imeLog('onData:DROPPED', data, `sinceLast=${now - lastIMETime}ms`)
        return
      }
      lastIMEData = data
      lastIMETime = now
    }
    imeLog('onData', data)
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
    // 末尾の改行を落とす。terminal.paste() は改行を CR(Enter) に正規化するため、末尾改行が
    // あるとブラケットペースト対応アプリ（Claude Code 等）で即送信され、シェルでも貼り付けた
    // コマンドが即実行されてしまう。確定/実行はユーザーが自分で Enter を押す。内部の改行は残す。
    text = text.replace(/[\r\n]+$/, '')
    if (text.includes('\n') || text.includes('\r')) {
      if (!(await confirmDialog(t('confirm.pasteNewlines')))) {
        terminal.focus()
        return
      }
    }
    terminal.paste(text)
    terminal.focus()
  }

  // A pasted/dropped file: upload it and write the relative path (a bare path,
  // not a mention).
  async function writeFileToPty(file: File) {
    if (!ptyId) return
    const name = file.name || 'file'
    try {
      // 置き場はこのタブを開いた cwd。シェルの現在地（OSC 7）ではない: `cd` するたびに
      // その先へ `.pike/` を作ることになり、置き場がリポジトリ内に散らばる。
      const rel = await saveUploadFile(file, terminalTab()?.cwd ?? projectStore.activeRoot)
      // Trailing space delimits consecutive paths when several files are dropped.
      ptyWrite(ptyId, `${rel} `).catch((err) => console.error('[terminal] ptyWrite failed:', err))
    } catch (err) {
      if (err instanceof UploadTooLargeError) {
        statusMessage.show({
          text: t('upload.tooLarge', { name, size: String(toMb(err.fileSize)), max: String(toMb(MAX_UPLOAD_SIZE)) }),
          variant: 'error',
          durationMs: 8000,
        })
      } else {
        console.error('[terminal] file paste failed:', err)
        statusMessage.show({
          text: t('upload.failed', { name, error: String(err) }),
          variant: 'error',
          durationMs: 8000,
        })
      }
    }
  }

  // 画像優先 → なければテキストの順で paste。右クリックと Ctrl+V の両方から呼ぶ。
  // (xterm 経由の Ctrl+V は async Clipboard API の制約で画像とテキストのみ取得可能)
  async function pasteFromClipboard() {
    if (!ptyId) return
    const images = await readClipboardImages()
    if (images.length > 0) {
      for (const file of images) await writeFileToPty(file)
      terminal?.focus()
      return
    }
    const text = await navigator.clipboard.readText().catch(() => '')
    if (text) await pasteText(text)
  }

  // 右クリック貼り付けが有効なときは、右ボタンの mousedown を xterm に渡さない。
  // マウスレポート中（Claude Code のフルスクリーン等）は xterm が右ボタンをアプリへ転送するが、
  // 近年の Claude Code は右クリック貼り付けをやめた（#147）ため転送先で何も起きず、逆に過去は
  // アプリ側の貼り付けと二重になった（#106）。転送を止めて Pike が必ず単一で貼り付ける。
  // capture フェーズで stopPropagation して xterm のリスナ到達前に止める（preventDefault は
  // しない。contextmenu イベントは発火させ、そちらで貼り付ける）。
  termRef.value?.addEventListener(
    'mousedown',
    (e) => {
      if (e.button === 2 && settingsStore.terminalRightClickPaste) e.stopPropagation()
    },
    true,
  )

  termRef.value?.addEventListener('contextmenu', async (e) => {
    e.preventDefault()
    if (!settingsStore.terminalRightClickPaste || !ptyId) return
    await pasteFromClipboard()
  })

  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    if (e.metaKey) return true
    // **Alt も見る**（#261）。IDEA 互換のプリセットはタブ移動を `Alt+←→`、新規ターミナルを
    // `Alt+F12` に割り当てるので、Alt を無条件にシェルへ渡すとそれらが一度も発火しない。
    if (!e.ctrlKey && !e.altKey) return true

    // macOS の Ctrl と Option はほぼ丸ごとシェルのもの（#254。残るのはタブ切替の 3 つだけ）。
    // **この判定は Ctrl+V の横取りより前に置くこと**: 後ろに置くと mac で `Ctrl+V` が
    // 貼り付けになり、vim の矩形選択と readline の quoted-insert が打てなくなる。mac の
    // 貼り付けは `⌘V` で、あちらは OS の編集メニューが処理する（この関数には届かない）。
    if (isMacHost) return !pikeTakesTerminalKey(e, inAltScreen.value)

    // xterm.js は Windows で Ctrl+V を SYN(\x16) として PTY に流すので、
    // 通常の `paste` イベントが発火しない → keydown レベルで横取りする。
    // Ctrl+Shift+V も同じ扱いに（Windows Terminal 互換）。
    if (e.ctrlKey && !e.altKey && normalizedKey(e) === 'v') {
      e.preventDefault()
      pasteFromClipboard()
      return false
    }

    // Pike 優先のキー（#224）。`false` を返すと xterm はこのキーに一切触れないので、
    // PTY へも流れず、window の keydown まで伝わって Pike のショートカットが動く。
    // ここで拾わないキーがシェルへ行くのは、xterm が PTY へ送る際に preventDefault
    // だけでなく stopPropagation も呼ぶため（`cancel(ev, true)`）。既定でシェル優先。
    // 全画面 TUI が動いているあいだは Ctrl+W だけ譲る（vim のウィンドウ操作の prefix）。
    return !pikeTakesTerminalKey(e, inAltScreen.value)
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
      // Sequential so multiple dropped paths are written in order, not interleaved.
      const files = Array.from(e.dataTransfer.files)
      void (async () => {
        for (const file of files) await writeFileToPty(file)
        terminal?.focus()
      })()
    }
  })

  // IME reset across app switches (xterm.js #6012 + WebView2/TSF staleness).
  //
  // Chromium keeps DOM focus on the textarea while the app is deactivated, so
  // xterm's blur cleanup never runs on an app switch, and the OS-side IME
  // context (TSF caret tracking) can come back stale — detached candidate
  // window, reordered/duplicated input. An earlier fix ran a blur→refresh→focus
  // cycle on window 'focus', but blur()+focus() inside one task gets coalesced
  // by the renderer's TextInputState dedup: the JS-side handlers fire, yet the
  // browser process / TSF never sees a real NONE→TEXT transition, so the OS
  // context is never rebuilt. A tab switch *did* fix it because v-show's
  // display:none moves focus to <body> for real, frames apart from the refocus.
  //
  // So split the cycle across the deactivation boundary instead: blur when the
  // window loses focus (a genuine blur — xterm's handler clears the committed
  // IME text), and on window focus just refocus, which re-establishes a fresh
  // TSF context. This also removes the old race where the deferred cycle could
  // clobber a composition the user started right after returning.
  windowBlurHandler = () => {
    if (!terminal || !tabStore.isTabFocused(props.tabId)) return
    // Don't let DOM focus fall to <body> across the deactivation: <body> is
    // TEXT_INPUT_TYPE_NONE, and a NONE state parked there gets applied to TSF
    // on reactivation, associating a keyboard-disabled input context with the
    // window. Recovering then depends on the refocus below winning its race
    // against the WebView2 native-focus handoff (see windowFocusHandler) —
    // the residual "IME OFF and toggle key dead" failure that survived the
    // two-frame delay. Park focus on a hidden text input instead: the parked
    // state stays TEXT, so reactivation never disables the IME regardless of
    // how that race resolves, and moving focus there still genuinely blurs
    // the textarea, so xterm's #6012 cleanup runs. Also park from <body>
    // (focus left there by a prior tab switch etc.); leave any other focused
    // element alone rather than steal its focus.
    const active = document.activeElement
    if (active === terminal.textarea || active === document.body || active === null) {
      parkFocusForIme()
    }
    // The park above already blurred a focused textarea; clear the retained
    // text (#6012) directly for the remaining cases.
    if (terminal.textarea) terminal.textarea.value = ''
  }
  window.addEventListener('blur', windowBlurHandler)

  windowFocusHandler = () => {
    if (!terminal || !tabStore.isTabFocused(props.tabId)) return
    // Defer to the next frame: when the window is activated by clicking into
    // it, the click's own element focus (e.g. xterm's mousedown handler) lands
    // first and this focus() becomes a harmless no-op instead of fighting it.
    //
    // Two frames, not one: the input-state transition this focus() produces is
    // silently dropped by Chromium (InputMethodWinTSF's IsWindowFocused guard)
    // unless the widget already holds *native* focus, and in WebView2 the
    // host→controller→widget focus handoff can still be in flight one frame
    // after the JS 'focus' event. A dropped transition is never resent. With
    // focus parked on a hidden TEXT input during deactivation (see
    // windowBlurHandler) losing this race no longer disables the IME — the
    // parked state applied on reactivation is already TEXT — but it would
    // leave TSF caret tracking on the park input (candidate window at the
    // wrong position), so the extra frame still earns its keep.
    afterTwoFrames(() => {
      // Re-check liveness AND active tab: the terminal may have been disposed
      // (tab closed) or the user may have switched tabs since the focus event.
      if (!terminal || !tabStore.isTabFocused(props.tabId)) return
      // Focus already bounced away again (rapid app switch): refocusing now
      // would park TEXT state on an inactive window; the next 'focus' event
      // handles it instead.
      if (!document.hasFocus()) return
      terminal.focus()
      // Parking on a TEXT input keeps the IME enabled across reactivation,
      // but it also removes the NONE→TEXT_AREA transition the blur-split fix
      // relied on to make TSF rebuild its stale context — with the parked
      // type already TEXT, reactivation reuses the old caret tracking and
      // edit buffer (candidate window detached, committed text duplicated /
      // reordered). Recreate that transition deliberately, now that the
      // window verifiably holds focus and the update won't be dropped:
      // bounce the textarea's input type through NONE via readOnly (a
      // readonly text control reports TEXT_INPUT_TYPE_NONE), one state per
      // frame pair so the renderer sends each as its own update instead of
      // deduping the round trip.
      const ta = terminal.textarea
      if (!ta) return
      afterTwoFrames(() => {
        // Skip if focus moved elsewhere meanwhile, the window deactivated
        // again, or a composition already started (xterm keeps composition
        // text in textarea.value; flipping readOnly would abort it).
        if (document.activeElement !== ta || !document.hasFocus() || ta.value !== '') return
        ta.readOnly = true
        // Unconditional: readOnly must never stay latched, even if the tab
        // switched or the window blurred mid-cycle.
        afterTwoFrames(() => {
          ta.readOnly = false
        })
      })
    })
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
  if (windowBlurHandler) window.removeEventListener('blur', windowBlurHandler)
  window.removeEventListener('mousedown', closeAgentMenu)
  window.removeEventListener('mousedown', closePromptMenu)
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  if (ptyId) {
    ptyRouter.unregister(ptyId)
    ptyKill(ptyId).catch(() => {})
  }
  terminal?.dispose()
  // Null out so the deferred window-focus rAF (and any other late callback)
  // sees a disposed terminal and bails instead of calling into freed xterm state.
  terminal = null
})
</script>

<template>
  <div
    class="terminal-wrapper xterm-surface"
    :class="{ opaque: settingsStore.windowBackdrop === 'none' }"
    data-testid="terminal"
  >
    <div v-if="showAgentLaunch || showPromptInject" class="hover-toolbar term-toolbar">
      <div v-if="showPromptInject" class="agent-launch" :class="{ open: promptMenuOpen }">
        <button class="agent-btn solo" :title="t('terminal.promptInject')" @click="togglePromptMenu">
          <MessageSquareText :size="14" :stroke-width="2" />
          <ChevronDown :size="12" :stroke-width="2" />
        </button>
        <div v-if="promptMenuOpen" class="agent-menu popup-surface" @mousedown.stop>
          <button
            v-for="(p, i) in agentPrompts"
            :key="i"
            class="agent-menu-item"
            :title="p.text"
            @click="injectPrompt(p.text)"
          >
            <span class="agent-menu-label">{{ p.label }}</span>
            <span class="agent-menu-cmd">{{ p.text.split('\n')[0] }}</span>
          </button>
        </div>
      </div>
      <div v-if="showAgentLaunch" class="agent-launch" :class="{ open: agentMenuOpen }">
        <button
          v-if="primaryCommand"
          class="agent-btn primary"
          :title="primaryCommand.command"
          @click="runAgentCommand(primaryCommand.command)"
        >
          <Bot :size="14" :stroke-width="2" />
        </button>
        <button class="agent-btn caret" :title="t('terminal.agentLaunch')" @click="toggleAgentMenu">
          <ChevronDown :size="12" :stroke-width="2" />
        </button>
        <div v-if="agentMenuOpen" class="agent-menu popup-surface" @mousedown.stop>
          <!--
            高さの上限はここ（#275）。**メニュー本体には持たせられない**（サブメニューが
            クリップされる）ので、長くなりうる節をまとめてスクロールさせ、「他のエージェント」
            だけをその外に出す。
          -->
          <div class="agent-menu-scroll">
          <!-- 第 1 階層は既定の起動行だけ（#275）。 -->
          <button
            v-for="l in defaultLines"
            :key="l.command"
            class="agent-menu-item"
            @click="runAgentCommand(l.command)"
          >
            <span class="agent-menu-label">{{ l.label }}</span>
            <span class="agent-menu-cmd">{{ l.command }}</span>
          </button>
          <template v-if="showClaudeSessions">
            <div class="agent-menu-heading">{{ t('terminal.claudeSessions') }}</div>
            <div v-if="claudeSessions.length === 0" class="agent-menu-note">
              {{ sessionsLoading ? t('common.loading') : t('terminal.noClaudeSessions') }}
            </div>
            <button
              v-for="s in claudeSessions"
              v-else
              :key="s.id"
              class="agent-menu-item"
              :title="resumeCommand(s)"
              @click="runAgentCommand(resumeCommand(s))"
            >
              <span class="agent-menu-label">{{ s.title }}</span>
              <span class="agent-menu-cmd">
                {{ relativeTime(s.modifiedAt) }}<template v-if="s.gitBranch"> · {{ s.gitBranch }}</template>
              </span>
            </button>
          </template>
          </div>
          <!--
            既定以外の起動行（#275。見出しは「他のエージェント」）。**スクロール領域の
            外に置く**（中に入れると
            サブメニューがクリップされる）。**サブメニューは親の行の内側**なので、
            そちらへマウスを移しても `mouseleave` が発火しない（閉じるのを遅らせる
            タイマーが要らない）。左に出すのは、この親メニュー自体が画面の右上に出るため。
          -->
          <div
            v-if="otherLaunchers.length > 0"
            class="agent-menu-item agent-menu-sub"
            @mouseenter="agentSubOpen = true"
            @mouseleave="agentSubOpen = false"
          >
            <ChevronLeft :size="12" :stroke-width="2" class="agent-menu-caret" />
            <span class="agent-menu-label">{{ t('terminal.otherAgents') }}</span>
            <div v-if="agentSubOpen" class="agent-menu agent-submenu popup-surface">
              <template v-for="(o, i) in otherLaunchers" :key="i">
                <button
                  v-for="l in launcherLines(o)"
                  :key="l.command"
                  class="agent-menu-item"
                  @click="runAgentCommand(l.command)"
                >
                  <span class="agent-menu-label">{{ l.label }}</span>
                  <span class="agent-menu-cmd">{{ l.command }}</span>
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>
      <HelpButton page="terminal-and-agents.md#エージェント起動ボタン--プロンプト挿入" :size="14" class="term-help" />
    </div>
    <div ref="termRef" class="terminal-inner"></div>
  </div>
</template>

<style scoped>
/* Window transparency (issue #162): the wrapper sits *behind* xterm. In backdrop
   mode the xterm layers are forced transparent (the store's xtermTheme plus the
   shared `.xterm-surface` rule in theme.css), so this is the single translucent
   tint layer — and the color it paints pairs with xtermTheme, so the store owns
   both halves. */
.terminal-wrapper {
  position: absolute;
  inset: 0;
  padding: 10px;
  box-sizing: border-box;
  background: v-bind('settingsStore.terminalSurfaceBg');
}

/* xterm の高さは `rows × セル高` で決まり、FitAddon は行数を floor するので、
   コンテナ高の端数（最大でセル 1 行ぶん）が必ず余る。何もしないとそれが全部下に
   溜まり、上下左右 10px のはずの余白が下だけ 1 行ぶん広く見える（#268）。上下へ
   振り分けて 4 辺の見た目を揃える。 */
.terminal-inner {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* 位置と reveal は theme.css の `.hover-toolbar`。ここはメニューを開いているあいだ
   濃いままにする分だけを足す（ポインタが外へ出てもメニューは開いたままなので）。 */
.term-toolbar:has(.agent-launch.open) {
  opacity: 1;
}

.agent-launch {
  position: relative;
  display: flex;
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

.agent-btn.solo {
  border-radius: 4px;
  gap: 1px;
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
  /* Session titles are a sentence long: cap the width. */
  max-width: 340px;
  /* **`overflow` を持たせないこと（#275）。** `visible` 以外だと、中の「他のエージェント」の
     サブメニュー（`position: absolute`）がこの箱にクリップされ、開いてもスクロールバーが
     出るだけになる。長くなりうる節（セッション・設定の行）が自分でスクロールを持ち、
     全体の上限は `.agent-menu-scroll` が受ける。 */
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
  /* padding を含めて親幅に収める。**このプロジェクトは `box-sizing` をグローバルに
     設定していない**ので、`width: 100%` と padding を併せると左右 24px ぶん親から
     はみ出す（メニューに `overflow` があったころは隠れていた）。 */
  box-sizing: border-box;
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

.agent-menu-label,
.agent-menu-cmd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-menu-label {
  font-size: 12px;
}

.agent-menu-cmd {
  font-size: 10px;
  color: var(--text-secondary);
  font-family: 'Cascadia Code', 'Fira Code', monospace;
}

.agent-menu-heading {
  margin-top: 4px;
  padding: 4px 12px 2px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* 高さの上限を受ける層（#275）。「他のエージェント」の行はこの外にあるので、
   サブメニューはクリップされない。 */
.agent-menu-scroll {
  max-height: 60vh;
  overflow-y: auto;
}

/* 「他のエージェント」の行（#275）。中身は `.agent-menu-item` と同じ見た目で、
   右端に開く向きの印を置く。 */
/* `.agent-menu-item` は縦積み（ラベル＋コマンド）だが、この行は開く向きの印とラベルを
   横に並べるので方向を上書きする。サブメニューは `position: absolute` なので流れの外。
   **印はラベルの左**（開く向きと同じ側）。メニューはターミナルの右上から出るので、
   サブメニューは左へ開く。 */
.agent-menu-sub {
  position: relative;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  border-top: 1px solid var(--border);
  margin-top: 4px;
  padding-top: 8px;
}

.agent-menu-caret {
  flex-shrink: 0;
  color: var(--text-secondary);
}

/* **親の行の左に出す。** このメニュー自体がターミナルの右上から出るので、右に開くと
   画面の外へ出る。`overflow-y: auto` の親から抜けるため、位置は親の行を基準にする。 */
/* **隙間を空けない。** 2px でも空けると、ポインタがそこを通った瞬間に行の
   `mouseleave` が発火してサブメニューが閉じる（「親の内側だから閉じない」が成り立つのは
   隙間が無いときだけ）。 */
.agent-submenu {
  top: -4px;
  right: 100%;
  margin-top: 0;
}

.agent-menu-note {
  padding: 3px 12px 5px;
  font-size: 11px;
  color: var(--text-secondary);
}

.agent-menu-item:hover .agent-menu-cmd {
  color: rgba(255, 255, 255, 0.7);
}
</style>
