<script setup lang="ts">
import { FitAddon } from '@xterm/addon-fit'
import { type ISearchOptions, SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { Bot, ChevronDown, ChevronLeft, MessageSquareText } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { useAgentMenu } from '../../composables/useAgentMenu'
import { confirmDialog, confirmWithOption } from '../../composables/useConfirmDialog'
import { copyOnSelect } from '../../composables/useCopyOnSelect'
import { devServerUrls } from '../../composables/useDevServerUrls'
import {
  MAX_UPLOAD_SIZE,
  readClipboard,
  saveUploadFile,
  toMb,
  UploadTooLargeError,
} from '../../composables/useImagePaste'
import { ptyRouter } from '../../composables/usePtyRouter'
import { markTerminalOutput, registerTerminalPeek, unregisterTerminalPeek } from '../../composables/useTerminalPeek'
import { attachUrlLinks } from '../../composables/useTerminalUrlLinks'
import { useI18n } from '../../i18n'
import { isMacHost, isWindowsHost } from '../../lib/host'
// 一時的な調査用ログ（TODO「謎のバックスペース」）。原因が判明したら削除する。
import { imeLog, imeLogSessionStart } from '../../lib/imeDebugLog'
import { parkFocusForIme } from '../../lib/imeFocusPark'
import { matchChord, normalizedKey } from '../../lib/keys'
import { openPathInTab, projectPath } from '../../lib/openFile'
import { useOverlay } from '../../lib/overlay'
import { isAbsolutePath } from '../../lib/paths'
import { readableTextOn } from '../../lib/projectColors'
import { pikeTakesTerminalKey } from '../../lib/shortcuts'
import { ptyGetCwd, ptyKill, ptyPasteText, ptyResize, ptySpawn, ptyWrite } from '../../lib/tauri'
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
import { TERM_SCROLLBAR_WIDTH, useSettingsStore } from '../../stores/settings'
import { useStatusMessageStore } from '../../stores/statusMessage'
import { useTabStore } from '../../stores/tabs'
import { isPowershellFamily, type ShellType } from '../../types/tab'
import AgentSessionsMenu from '../AgentSessionsMenu.vue'
import FindBar from '../editor/FindBar.vue'
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
/**
 * メニューの構成と再開一覧の取得は `useAgentMenu`（#375 でタブバーの ▾ と共有）。
 * ここが渡すのは「どのシェルの起動行か」「どこの履歴を引くか」「選んだら何をするか」の 3 つ。
 */
const agentMenu = useAgentMenu({
  launchers: () => agentStore.launchers,
  where: sessionsWhere,
  run: (command) => runAgentCommand(command),
})
const { defaultLines, defaultAgent, otherRows, sessionsMenuBind } = agentMenu
const agentSubOpen = agentMenu.subOpen
/** ボタン本体で走る行。 */
const primaryCommand = computed(() => defaultLines.value[0] ?? null)
const agentMenuOpen = ref(false)
// Reusable instruction snippets injected (as text, not submitted) into the
// running agent in the current terminal. Configurable in Settings.
const agentPrompts = computed(() => settingsStore.agentPrompts)
const promptMenuOpen = ref(false)
// 手前に浮くものは数える（#396。ブラウザのタブの子 webview を隠すため）。入れ子の
// サブメニュー（`agentSubOpen`）は、親を開いた時点で数えられているので登録しない。
useOverlay(() => agentMenuOpen.value || promptMenuOpen.value)
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
const showAgentLaunch = computed(
  () => settingsStore.terminalAgentButton && !inAltScreen.value && primaryCommand.value !== null,
)
// The prompt-inject button also shows in the alt-screen when an interactive,
// mouse-reporting app (an agent) owns it.
const showPromptInject = computed(
  () =>
    settingsStore.terminalPromptButton && (!inAltScreen.value || mouseActive.value) && agentPrompts.value.length > 0,
)
/**
 * 「?」を出すか（#341）。**上の 2 つが両方隠れているときは一緒に消える**: あのボタンが
 * 開くマニュアルはその 2 つの説明なので、ボタンの無いターミナルに残しても行き先が無い。
 *
 * **その連動をここで述語にする。** ツールバー自体の `v-if` が同じ条件なので今は二重だが、
 * それは「`HelpButton` がその `div` の中にある」という入れ子の副作用でしかない。設定画面は
 * この連動を UI で表している（2 つが両方オフの間はヘルプの切り替えを OFF に固定して押せなく
 * する）ので、入れ子に預けると、あとで「?」を外へ出した日にその表示が黙って嘘になる。
 */
const showHelp = computed(() => settingsStore.terminalHelpButton && (showAgentLaunch.value || showPromptInject.value))

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

/**
 * 一覧を引く先（シェルと基準ディレクトリ）。**メニューを開いているあいだは 1 回だけ聞く**
 * （`useAgentMenu` が世代を渡す）。4 つのサブメニューをホバーすれば `pty_get_cwd` の IPC が
 * そのぶん飛ぶが、開いているあいだにシェルも現在地も変わらない。
 *
 * **参照するディレクトリは `pty_get_cwd`**（OSC 7 の現在地）→ タブの cwd → プロジェクトの
 * root の順。タブ生成時の cwd で決め打ちしないのは、記録が起動した cwd ごとに分かれるので、
 * `cd` したあとは別のバケットになるため。
 */
let sessionsWhereCache: { epoch: number; shell: ShellType; root: string } | null = null

async function sessionsWhere(epoch: number): Promise<{ shell: ShellType; root: string } | null> {
  if (sessionsWhereCache?.epoch === epoch) return sessionsWhereCache
  const tabData = terminalTab()
  const shell = tabData?.shell ?? projectStore.currentProject?.shell
  const root = (ptyId ? await ptyGetCwd(ptyId) : null) ?? tabData?.cwd ?? projectStore.activeRoot
  if (!shell || !root) return null
  sessionsWhereCache = { epoch, shell, root }
  return sessionsWhereCache
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

// Resolve a `path:line` link from terminal output to a tab. Relative paths
// resolve against `activeRoot` (same base as search / diagnostics).
//
// Goes through `openPathInTab` rather than `addEditorTab` so the extension
// routing applies: a terminal link to a PNG or a PDF used to land in CodeMirror
// and trip its binary guard. A path that is a directory reaches the editor tab
// too, which offers to open it as a project instead of reporting a read error.
//
// **開く前に一拍置く（#343）。** 出力の中の語がリンクになる以上、押すつもりの無かった
// ものを踏むことがある。確認するかは `terminalPathConfirm` で、チェックボックスと設定画面の
// どちらからでも切り替えられる。**見せるのは解決済みの絶対パス**: リンクの字面は本人が
// 見て押しているので、確認の値打ちは「どこに解決されたか」のほうにある。
async function openPathLink(target: PathLinkTarget) {
  const project = projectStore.currentProject
  const full = projectPath(target.path)
  if (!project || !full) return
  if (settingsStore.terminalPathLinks === 'confirm') {
    const { ok, checked } = await confirmWithOption(
      t('confirm.openPath', { path: full }),
      t('confirm.openPathRemember'),
    )
    if (!ok) return
    if (checked) settingsStore.terminalPathLinks = 'open'
  }
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
      // **設定はここで見る（#343）。** URL 側（`attachUrlLinks`）はアドオンごと外すが、
      // こちらは自前のプロバイダなので、何も返さなければリンクにならない。付け外しより
      // 安く、切り替えた瞬間から効く。
      if (settingsStore.terminalPathLinks === 'off') {
        callback(undefined)
        return
      }
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
        activate: () => void openPathLink(target),
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
    // **一覧はここで取らない**（#267）。エージェントごとにサブメニューを開いたときだけ読む。
    nextTick(() => window.addEventListener('mousedown', closeAgentMenu, { once: true }))
  }
}

function closeAgentMenu() {
  window.removeEventListener('mousedown', closeAgentMenu)
  agentMenuOpen.value = false
  // サブメニューと取った一覧の後始末は `useAgentMenu` が持つ（理由はあちらの doc）。
  agentMenu.close()
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
let searchAddon: SearchAddon | null = null
let ptyId: string | null = null

// --- 検索 ---------------------------------------------------------------------
//
// 一致を探すのと装飾は `@xterm/addon-search` の担当（折り返した行をつないで探す、
// スクロールバックまで含める、を自前で持たない）。ここに残るのは検索バーとの受け渡しだけ。
const findOpen = ref(false)
const findQuery = ref('')
const findCaseSensitive = ref(false)
const findIndex = ref(0)
const findCount = ref(0)
/**
 * アドオンは `highlightLimit` 件で数えるのをやめ、件数はその値で止まる。現在位置がその外に
 * あると -1 で届く（`FindBar` は位置を出さない）。
 */
const FIND_LIMIT = 1000
const findTruncated = computed(() => findCount.value >= FIND_LIMIT)

/**
 * 装飾の色。**アドオンは `#RRGGBB` しか受けない**ので、`theme.css` の `--find-*` 変数
 * （半透明の rgba）を渡せない。明暗はアプリのテーマではなく**ターミナルの配色の下地**で選ぶ
 * （ダークモードで Solarized Light を選ぶ人がいる）。
 */
const FIND_DECORATIONS = {
  dark: { matchBackground: '#6b5500', activeMatchBackground: '#c77800' },
  light: { matchBackground: '#ffe58f', activeMatchBackground: '#ffa629' },
}

function findOptions(incremental = false): ISearchOptions {
  const onLight = readableTextOn(settingsStore.colorScheme.background) === '#000000'
  return {
    caseSensitive: findCaseSensitive.value,
    incremental,
    decorations: {
      ...FIND_DECORATIONS[onLight ? 'light' : 'dark'],
      matchOverviewRuler: '#ffc800',
      activeMatchColorOverviewRuler: '#ff9f00',
    },
  }
}

const findBar = useTemplateRef<{ focus: () => void }>('findBar')

/**
 * **アドオンは開いたときに読み込み、閉じたら捨てる。** 読み込んだままだと、検索を使わない
 * タブでも出力のたびに再検索の確認が走る（タブは v-show で生き続け、エージェントは出力を
 * 流し続ける）。捨てれば装飾も検索語も一緒に消える。
 */
function openFind() {
  // 開いた直後のフォーカスは `FindBar` 自身が取る。ここで呼ぶのは開いたまま押し直したときのため。
  if (findOpen.value) return findBar.value?.focus()
  if (!terminal) return
  findOpen.value = true
  searchAddon = new SearchAddon({ highlightLimit: FIND_LIMIT })
  terminal.loadAddon(searchAddon)
  searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
    findIndex.value = resultIndex
    findCount.value = resultCount
  })
  // 前回の検索語が残っていれば探し直す（件数だけ古いまま出さない）。
  searchFromQuery()
}

/** 検索語か大小の区別が変わったとき。打ち足したぶんは今の一致から伸ばす（打つたびに次へ飛ばない）。 */
function searchFromQuery() {
  if (!searchAddon) return
  if (findQuery.value) searchAddon.findNext(findQuery.value, findOptions(true))
  else searchAddon.clearDecorations()
}

function stepFind(delta: number) {
  if (!searchAddon || !findQuery.value) return
  if (delta > 0) searchAddon.findNext(findQuery.value, findOptions())
  else searchAddon.findPrevious(findQuery.value, findOptions())
}

function closeFind() {
  findOpen.value = false
  searchAddon?.dispose()
  searchAddon = null
  terminal?.focus()
}

watch([findQuery, findCaseSensitive], searchFromQuery)

/**
 * 検索を開く（`Mod+F`）。**xterm のキーハンドラではなく window で受ける**（diff タブ・プレビューと
 * 同じ）。Windows / Linux の `Ctrl+F` は表の行（`terminalFirst` / `altScreenShell`）がシェルへ
 * 渡すかを決め、渡さなければここまで伝わる。mac の `⌘F` は xterm が PTY へ送らないので素通しで届く。
 */
function onFindKeydown(e: KeyboardEvent) {
  if (!matchChord(e, 'Mod+F') || !tabStore.isTabFocused(props.tabId)) return
  e.preventDefault()
  openFind()
}
let resizeObserver: ResizeObserver | null = null
let resizeTimer: ReturnType<typeof setTimeout> | null = null
let windowFocusHandler: (() => void) | null = null
let windowBlurHandler: (() => void) | null = null
let lastCols = 0
let lastRows = 0

/**
 * いま画面に出ている最後の `n` 行（#319。`TerminalPeek.snapshot`）。
 *
 * **末尾はバッファの種類で変わる。**
 *
 * - 通常バッファはカーソル行が最後の出力なので、そこから遡る
 * - **代替画面は画面全体が「今」**なので、下端（`viewportY + rows - 1`）から遡る。
 *   カーソル基準にすると、カーソルが上のほうにある TUI（`vim` で 1 行目、`htop`）で
 *   1 行しか取れない。claude で正しく見えるのは、あれのプロンプトがたまたま下に
 *   あるからで、種類を見ないと他の TUI で崩れる
 *
 * **末尾の空行は落とす。** カーソルの下（や画面の下半分）が余白で埋まっているのが
 * 普通で、そのまま遡ると「何も出ていない」ように見える。
 *
 * 種類は `inAltScreen`（ref）ではなく `buf.type` を見る。**呼ばれるのは覗かれた瞬間**
 * なので、そのときのバッファに直接聞くほうが、イベント越しに更新される ref を信じるより
 * ずれようがない。
 */
function peekLines(n: number): string[] {
  const term = terminal
  if (!term) return []
  const buf = term.buffer.active
  const text = (y: number) => buf.getLine(y)?.translateToString(true) ?? ''
  let end = buf.type === 'alternate' ? buf.viewportY + term.rows - 1 : buf.baseY + buf.cursorY
  while (end > 0 && text(end).trim() === '') end--
  const out: string[] = []
  for (let y = Math.max(0, end - n + 1); y <= end; y++) out.push(text(y))
  return out
}

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

/**
 * xterm へフォーカスを渡す。`v-show` で出したばかりのタブでも当たるよう、上の
 * 測り直しと同じだけ待ってから撃つ（display が解けるまで focus は効かない）。
 */
function focusSoon() {
  nextTick(() => {
    afterTwoFrames(() => terminal?.focus())
  })
}

/** DOM のフォーカスは打鍵の行き先にだけ渡す（見えているだけのタブは奪わない）。 */
watch(
  () => tabStore.isTabFocused(props.tabId),
  (focused) => {
    if (focused) focusSoon()
  },
)

/**
 * 外から流し込まれたあとにフォーカスを引き取る（#355）。上の watcher は行き先が
 * **変わった**ときにしか発火しないので、既に選ばれているターミナルへ注入したときは
 * 何も起きない（issue パネルや Problems の 🤖 を押した普通の場合がそれ）。
 */
watch(
  () => terminalTab()?.focusRequested,
  (at) => {
    if (at) focusSoon()
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
  window.addEventListener('keydown', onFindKeydown)
  if (!termRef.value) return

  terminal = new Terminal({
    fontFamily: settingsStore.fontFamily,
    fontSize: settingsStore.fontSize,
    theme: settingsStore.xtermTheme,
    scrollback: 5000,
    cursorBlink: true,
    allowProposedApi: true,
    // スクロールバーと右の溝の幅（#396。既定の 14px はアプリの他の面より太い）。
    overviewRuler: { width: TERM_SCROLLBAR_WIDTH },
    // Window transparency (issue #162): let the translucent theme background
    // composite over the desktop. Only enabled when a backdrop is active — the
    // opaque default keeps xterm's cheaper non-transparent render path.
    allowTransparency: settingsStore.windowBackdrop !== 'none',
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  attachUrlLinks(terminal)
  registerPathLinks(terminal)

  terminal.open(termRef.value)
  fitAddon.fit()

  // 覗く口を出す（#319）。**spawn より前に登録する**: `pty_spawn` が失敗した枝は
  // エラーを書いてから早期 return するので、あとに置くと**そのタブだけ永久に
  // 「まだ出力がありません」**になる。他のプロジェクトから覗きたいのは、まさに
  // そういうタブ。
  registerTerminalPeek(props.tabId, peekLines)

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
  // 開発サーバーの URL を拾うときの手がかり（#397。どのプロジェクトのサーバーか）。
  const devServerCwd = tabData?.cwd ?? projectStore.activeRoot ?? undefined
  ptyRouter.register(
    ptyId,
    (data) => {
      termRef_.write(data)
      // 「今ちゃんと動いているか」の目安（#319）。**出力のたびに来る**ので、ここでは
      // 時刻を 1 つ置くだけ（`markTerminalOutput` の doc）。
      markTerminalOutput(props.tabId)
      devServerUrls.feed(props.tabId, data, devServerCwd)
    },
    (code) => {
      devServerUrls.forget(props.tabId)
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

  // **検索バーが開いているあいだはコピーしない。** 検索アドオンは一致を選択範囲で示すので、
  // 打鍵・前後移動・出力のたびの再検索がそのままクリップボードを書き換え、初回の確認ダイアログが
  // 1 文字目で検索欄のフォーカスを奪う。代償として、その間に手で選択してもコピーされない。
  terminal.onSelectionChange(() => {
    if (!findOpen.value) copyOnSelect(() => terminal?.getSelection() ?? '')
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
  // **読むのは 1 回だけ**（`readClipboard`）。2 回に分けると macOS で貼り付けが無反応になる
  // 理由は、あの関数の doc が正本。
  async function pasteFromClipboard() {
    if (!ptyId) return
    const { images, text } = await readClipboard()
    if (images.length > 0) {
      for (const file of images) await writeFileToPty(file)
      terminal?.focus()
      return
    }
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
  window.removeEventListener('keydown', onFindKeydown)
  if (windowFocusHandler) window.removeEventListener('focus', windowFocusHandler)
  if (windowBlurHandler) window.removeEventListener('blur', windowBlurHandler)
  window.removeEventListener('mousedown', closeAgentMenu)
  window.removeEventListener('mousedown', closePromptMenu)
  if (resizeTimer) clearTimeout(resizeTimer)
  resizeObserver?.disconnect()
  unregisterTerminalPeek(props.tabId)
  devServerUrls.forget(props.tabId)
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
    <!-- 検索バーと同じ角に出るので、開いているあいだは隠す（diff タブの折り返しボタンと同じ）。 -->
    <FindBar
      v-if="findOpen"
      ref="findBar"
      v-model:query="findQuery"
      v-model:case-sensitive="findCaseSensitive"
      :current="findIndex"
      :total="findCount"
      :truncated="findTruncated"
      @step="stepFind"
      @close="closeFind"
    />
    <div v-else-if="showAgentLaunch || showPromptInject" class="hover-toolbar term-toolbar">
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
        <div v-if="agentMenuOpen" class="agent-menu popup-surface" data-testid="agent-menu" @mousedown.stop>
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
          </div>
          <!--
            既定の行の再開一覧（#267）。**スクロール領域の外**に置く（中に入れると
            サブメニューがクリップされる）。
          -->
          <AgentSessionsMenu
            v-if="defaultAgent"
            v-bind="sessionsMenuBind(defaultAgent, 'default')"
          />
          <!--
            既定以外の起動行（#275 / #267）。**スクロール領域の外に置く**（中に入れると
            サブメニューがクリップされる）。**サブメニューは親の行の内側**なので、
            そちらへマウスを移しても `mouseleave` が発火しない（閉じるのを遅らせる
            タイマーが要らない）。左に出すのは、この親メニュー自体が画面の右上に出るため。
          -->
          <div
            v-if="otherRows.length > 0"
            class="agent-menu-item agent-menu-sub"
            @mouseenter="agentSubOpen = true"
            @mouseleave="agentSubOpen = false"
          >
            <ChevronLeft :size="12" :stroke-width="2" class="agent-menu-caret" />
            <span class="agent-menu-label">{{ t('terminal.otherAgents') }}</span>
            <div v-if="agentSubOpen" class="agent-menu agent-submenu popup-surface">
              <!-- 行のかたまりごとに区切る（#267）。どこまでが同じエージェントかを目で追える。 -->
              <div v-for="(o, i) in otherRows" :key="i" class="agent-menu-group">
                <button
                  v-for="l in o.lines"
                  :key="l.command"
                  class="agent-menu-item"
                  @click="runAgentCommand(l.command)"
                >
                  <span class="agent-menu-label">{{ l.label }}</span>
                  <span class="agent-menu-cmd">{{ l.command }}</span>
                </button>
                <!-- そのエージェントの再開一覧（サブのサブ）。 -->
                <AgentSessionsMenu v-if="o.agent" v-bind="sessionsMenuBind(o.agent, `other:${i}`)" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <HelpButton
        v-if="showHelp"
        page="terminal-and-agents.md#エージェント起動ボタン--プロンプト挿入"
        :size="14"
        class="term-help"
      />
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
  /* 余白は共有の `.xterm-surface` が持つ（#383。理由は `--term-gutter` の宣言の隣）。
     **`align-items: center` で端数を散らしてはいけない**: `.xterm` が本文ちょうどの幅に
     縮み、スクロールバーが最終列に重なる。 */
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

/* メニューの見た目（`.agent-menu*`）は `theme.css` にある。**切り出した
   `AgentSessionsMenu.vue` と共有するため**で、scoped のままだと子のルート要素より内側に
   届かない（`frontend.md`）。ここに残すのはボタン本体だけ。 */
</style>
