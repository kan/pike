import type { ProjectPlatform } from '../lib/projectPaths'

export type ShellType =
  | { kind: 'wsl'; distro: string }
  | { kind: 'cmd' }
  | { kind: 'powershell' }
  | { kind: 'pwsh' }
  | { kind: 'git-bash' }
  /**
   * macOS / Linux ホストのローカルシェル。`program` はシェルの絶対パスで、
   * 省略すると Rust 側が `$SHELL`（無ければ `/bin/zsh`）で解決する。**既定では
   * 空にしておく**: 焼き込むと、ユーザーがログインシェルを変えたあとも保存済みの
   * タブが古いシェルを起動し続ける。
   */
  | { kind: 'unix'; program?: string }

export type WindowsShellKind = 'cmd' | 'powershell' | 'pwsh' | 'git-bash'

export const WINDOWS_SHELLS: { kind: WindowsShellKind; label: string }[] = [
  { kind: 'cmd', label: 'Command Prompt' },
  { kind: 'powershell', label: 'PowerShell' },
  { kind: 'pwsh', label: 'PowerShell 7' },
  { kind: 'git-bash', label: 'Git Bash' },
]

/**
 * POSIX 規約（`/` 区切り・大小を区別）のシェルか。Rust の `ShellConfig::is_posix()` と対。
 *
 * `git-bash` は**含めない**: 引用こそ bash だが扱うパスは Windows のもので、Rust 側も
 * 一貫して Windows として分岐している。
 *
 * **`ShellType` の述語なので型と同居させる。** `lib/paths.ts` に置いていたころは
 * `types/tab.ts` がここを値で import する形になり、「`types/tab.ts` は値 import を
 * 持たない」（`.claude/rules/frontend.md`）と食い違っていた。区切り文字そのものが要る
 * ときは `lib/paths.ts` の `pathSep` を使う。
 */
export function isPosixShell(shell?: ShellType): boolean {
  return shell?.kind === 'wsl' || shell?.kind === 'unix'
}

/**
 * Windows 側の作法（`\` 区切り・cmd の引用・管理者昇格・Codex の externalSandbox）が
 * 当てはまるシェルか。WSL と同じく、ローカルの Unix シェルは**含まない**。
 */
export function isWindowsShell(shell: ShellType): boolean {
  return !isPosixShell(shell)
}

/** Stable identity for a shell config: profile key and default-shell matching. */
export function shellId(shell: ShellType): string {
  if (shell.kind === 'wsl') return `wsl:${shell.distro}`
  // `unix:<絶対パス>` は明示指定したときだけ。既定は素の `unix`（Rust の
  // `shell_from_id` と同じ表記）。
  if (shell.kind === 'unix') return shell.program ? `unix:${shell.program}` : 'unix'
  return shell.kind
}

/**
 * Terminal-add dropdown entry managed in Settings (#129): visibility and order
 * are user-configurable. Machine-local (the WSL distro set differs per PC) —
 * persisted outside the synced settings, like the globalShell key.
 */
export interface ShellProfile {
  /** shellId(shell) — stable across sessions */
  id: string
  shell: ShellType
  hidden?: boolean
}

/**
 * One shell as the OS menus show it (#240). `menusRefresh` hands these to Rust,
 * which sends `id` back through `--shell=<id>` / `tray:new-terminal:<id>`.
 */
export interface MenuShell {
  id: string
  label: string
}

/** Dropdown label: matches WINDOWS_SHELLS naming (not the short shellLabel form). */
export function shellProfileLabel(shell: ShellType): string {
  if (shell.kind === 'wsl') return `WSL (${shell.distro})`
  if (shell.kind === 'unix') return unixShellLabel(shell.program)
  return WINDOWS_SHELLS.find((s) => s.kind === shell.kind)?.label ?? shell.kind
}

/**
 * ローカル Unix シェルの表示名。実体（`/bin/zsh` → `zsh`）が分かるほうが役に立つが、
 * 既定は実体を持たない（`$SHELL` を実行時に見る）ので一般名に落とす。UI 言語に依存
 * しない固有名なので i18n には出さない。
 */
function unixShellLabel(program?: string): string {
  // `program` は絶対 POSIX パスに限られる（`shellFromId`）ので、`lib/paths.ts` の
  // `basename` を値で import せずにここで切れる。
  return program ? program.slice(program.lastIndexOf('/') + 1) || program : 'Shell'
}

/** powershell.exe / pwsh.exe: same syntax for clear (`cls`) and chaining (`;`) */
export function isPowershellFamily(kind: string | undefined): boolean {
  return kind === 'powershell' || kind === 'pwsh'
}

/**
 * Run `next` only if `first` succeeded, in the given shell's syntax.
 *
 * `&&` covers cmd, the bash family and PowerShell 7, but **Windows PowerShell 5
 * has no pipeline chain operator at all** — it is a parse error there, so that
 * one shell gets an explicit exit-code test. `;` would not do: it runs `next`
 * regardless, which for a retry-then-continue pair is exactly wrong.
 */
export function chainOnSuccess(first: string, next: string, shell?: ShellType): string {
  if (shell?.kind === 'powershell') return `${first}; if ($LASTEXITCODE -eq 0) { ${next} }`
  return `${first} && ${next}`
}

/**
 * Quote one argument of a command line for the given shell, so paths and URLs
 * with spaces (or `$`, backticks, …) reach the program unmangled. Single quotes
 * are literal in both bash and PowerShell — cmd.exe only understands double
 * quotes, and has no escape for an embedded one.
 */
export function quoteArg(shell: ShellType, arg: string): string {
  if (shell.kind === 'cmd') return `"${arg.replace(/"/g, '')}"`
  const escaped = isPowershellFamily(shell.kind) ? arg.replace(/'/g, "''") : arg.replace(/'/g, `'\\''`)
  return `'${escaped}'`
}

/**
 * `shellId` の逆。Rust の `types::shell_from_id` と同じ語彙を読む。
 *
 * 解釈できない id では null を返す。**`shellToType(id as WindowsShellKind)` で代用しない**:
 * あちらは網羅 switch なので `unix` や `wsl:...` を渡すと黙って `undefined` を返し、
 * そのまま保存するとシェルを持たないプロジェクトができる。
 */
export function shellFromId(id: string): ShellType | null {
  if (id.startsWith('wsl:')) {
    const distro = id.slice('wsl:'.length)
    return distro ? { kind: 'wsl', distro } : null
  }
  if (id === 'unix') return { kind: 'unix' }
  if (id.startsWith('unix:')) {
    const program = id.slice('unix:'.length)
    return program.startsWith('/') ? { kind: 'unix', program } : null
  }
  return WINDOWS_SHELLS.some((s) => s.kind === id) ? shellToType(id as WindowsShellKind) : null
}

export function shellToType(kind: WindowsShellKind): ShellType {
  switch (kind) {
    case 'cmd':
      return { kind: 'cmd' }
    case 'powershell':
      return { kind: 'powershell' }
    case 'pwsh':
      return { kind: 'pwsh' }
    case 'git-bash':
      return { kind: 'git-bash' }
  }
}

export function shellLabel(shell: ShellType): string {
  switch (shell.kind) {
    case 'wsl':
      return `WSL (${shell.distro})`
    case 'cmd':
      return 'CMD'
    case 'powershell':
      return 'PowerShell'
    case 'pwsh':
      return 'PowerShell 7'
    case 'git-bash':
      return 'Git Bash'
    case 'unix':
      return unixShellLabel(shell.program)
  }
}

export function shellToPlatform(shell: ShellType): ProjectPlatform {
  if (shell.kind === 'wsl') return 'wsl'
  if (shell.kind === 'unix') return 'unix'
  return 'windows'
}

export function shellToWinKind(shell: ShellType): WindowsShellKind {
  return shell.kind === 'wsl' || shell.kind === 'unix' ? 'powershell' : shell.kind
}

export function shellToDistro(shell: ShellType, fallback = 'Ubuntu'): string {
  return shell.kind === 'wsl' ? shell.distro : fallback
}

export function buildShell(platform: ProjectPlatform, distro: string, winShell: WindowsShellKind): ShellType {
  if (platform === 'wsl') return { kind: 'wsl', distro }
  if (platform === 'unix') return { kind: 'unix' }
  return shellToType(winShell)
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
}

export function rootPlaceholder(platform: ProjectPlatform): string {
  if (platform === 'wsl') return 'WSL path (e.g. /home/user/project)'
  if (platform === 'unix') return 'Path (e.g. /Users/user/project)'
  return 'Path (e.g. C:\\Users\\user\\project)'
}

export type TerminalTab = {
  id: string
  kind: 'terminal'
  title: string
  pinned: boolean
  ptyId: string | null
  autoStart?: string
  /** When true (with autoStart), wrap the command so the shell exits on completion. */
  closeOnExit?: boolean
  /** Keep the tab after a non-zero exit instead of auto-closing it, so the
   *  error output stays readable. A successful run still closes. */
  keepOnError?: boolean
  cwd?: string
  shell?: ShellType
  hasActivity?: boolean
  exitCode?: number | null
}

export type EditorTab = {
  id: string
  kind: 'editor'
  title: string
  pinned: boolean
  path: string
  readOnly?: boolean
  initialContent?: string
  initialLine?: number
  /** View mode to open the tab in (e.g. 'preview' when opened from a Markdown link). */
  initialViewMode?: 'edit' | 'split' | 'preview'
  reloadRequested?: number
  externalChange?: 'modified' | 'deleted'
  /** File does not exist on disk yet (opened as a blank new file); cleared on first save. */
  isNewFile?: boolean
}

export type PreviewTab = {
  id: string
  kind: 'preview'
  title: string
  pinned: boolean
  path: string
  dataUrl: string
  /** Short commit hash when showing a file at a revision (Git panel → open
   *  file). Keeps the tab distinct from the working-tree preview of the same
   *  path, the way a read-only editor tab does. */
  revision?: string
}

export type DockerLogsTab = {
  id: string
  kind: 'docker-logs'
  title: string
  pinned: boolean
  containerId: string
  containerName: string
}

export type DiffTab = {
  id: string
  kind: 'diff'
  title: string
  pinned: boolean
  filePath: string
  diff: string
  commitHash?: string
  staged?: boolean
}

export type HistoryTab = {
  id: string
  kind: 'history'
  title: string
  pinned: boolean
  filePath: string
  /** When set, show commits that modified the given inclusive line range only (`git log -L`). */
  lineRange?: { start: number; end: number }
}

export type SettingsTab = {
  id: string
  kind: 'settings'
  title: string
  pinned: boolean
}

/** Singleton `/status` view for the agents (#226). */
export type AgentStatusTab = {
  id: string
  kind: 'agent-status'
  title: string
  pinned: boolean
}

export type PdfTab = {
  id: string
  kind: 'pdf'
  title: string
  pinned: boolean
  path: string
  /** Same role as `PreviewTab.revision`. */
  revision?: string
  /** Content for a revision, since the bytes are not on disk. Absent for a
   *  working-tree PDF, which the tab reads from `path` itself. */
  dataUrl?: string
}

export type AgentChatTab = {
  id: string
  kind: 'agent-chat'
  title: string
  pinned: boolean
  hasActivity?: boolean
  /** Which agent runtime to use */
  agentType: 'codex' | 'claude-code'
}

export type ManualTab = {
  id: string
  kind: 'manual'
  title: string
  pinned: boolean
  /** Repo-relative path of the current manual page, e.g. docs/manual/README.md */
  page: string
}

/**
 * `title` is the tab's own name where it has one. The singleton kinds
 * (`settings` / `agent-status` / `manual`) hold an English fallback there and
 * get their real name from `lib/tabTitle.ts` — render tab names through
 * `tabDisplayTitle`, never from this field directly.
 */
export type Tab =
  | TerminalTab
  | EditorTab
  | DockerLogsTab
  | DiffTab
  | PreviewTab
  | HistoryTab
  | SettingsTab
  | AgentStatusTab
  | PdfTab
  | AgentChatTab
  | ManualTab

export type SidebarPanel =
  | 'files'
  | 'git'
  | 'search'
  | 'docker'
  | 'projects'
  | 'tasks'
  | 'todo'
  | 'outline'
  | 'diagnostics'
