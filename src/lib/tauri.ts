import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { confirmDialog } from '../composables/useConfirmDialog'
import { t } from '../i18n'
import type { ClaudeRateLimits, ClaudeSession, ClaudeUsageResult } from '../types/claudeUsage'
import type { CodexUsageResult } from '../types/codexUsage'
import type { DiagnosticsResult } from '../types/diagnostics'
import type { ComposeProject, ContainerListResult, TunnelInfo } from '../types/docker'
import type {
  GitBranches,
  GitFileChange,
  GitLogEntry,
  GitStatusResult,
  GitWorktree,
  PullOption,
  PushOption,
} from '../types/git'
import type { ProjectConfig } from '../types/project'
import type { SearchBackend, SearchResult } from '../types/search'
import type { MenuShell, ShellType } from '../types/tab'

// invoke の唯一のチョークポイント。E2E 撮影ビルド (#142) では、パネルへ決定的な
// ダミーデータを与えるため window.__wdio_mocks__（@wdio/tauri-service が
// browser.tauri.mock で設定）にモックがあればそれを返す。Tauri v2 は
// __TAURI_INTERNALS__.invoke を凍結していて monkey-patch できないため、ここで
// 明示的に分岐する。通常ビルドでは __PIKE_E2E__ が false 定数となり、この分岐ごと
// Rollup が除去する（本番は素の tauriInvoke のまま）。
const invoke: typeof tauriInvoke = __PIKE_E2E__
  ? (((cmd: string, args?: Record<string, unknown>) => {
      const fn = (window as unknown as { __wdio_mocks__?: Record<string, unknown> }).__wdio_mocks__?.[cmd]
      if (typeof fn === 'function') {
        return Promise.resolve((fn as (a?: unknown) => unknown)(args))
      }
      return tauriInvoke(cmd, args)
    }) as typeof tauriInvoke)
  : tauriInvoke

// PTY

export interface PtySpawnResult {
  id: string
}

export async function ptySpawn(
  cols: number,
  rows: number,
  opts?: { cwd?: string; shell?: ShellType },
): Promise<PtySpawnResult> {
  return invoke<PtySpawnResult>('pty_spawn', {
    cols,
    rows,
    cwd: opts?.cwd ?? null,
    shell: opts?.shell ?? null,
  })
}

export async function ptySpawnTmux(sessionName: string, cols: number, rows: number): Promise<PtySpawnResult> {
  return invoke<PtySpawnResult>('pty_spawn_tmux', { sessionName, cols, rows })
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke('pty_write', { id, data })
}

/**
 * Inject text into a PTY via bracketed paste (no trailing CR), so multi-line
 * content arrives as one input that the foreground program (a shell, or an agent
 * like `claude`) does not submit until the user presses Enter.
 */
export async function ptyPasteText(id: string, text: string): Promise<void> {
  return ptyWrite(id, `\x1b[200~${text}\x1b[201~`)
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke('pty_resize', { id, cols, rows })
}

export async function ptyKill(id: string): Promise<void> {
  return invoke('pty_kill', { id })
}

/**
 * Whether a process other than the shell itself is running in this terminal.
 * Backs the confirmation shown before closing a tab that would kill it (#178).
 */
export async function ptyIsBusy(id: string): Promise<boolean> {
  return invoke<boolean>('pty_is_busy', { id })
}

/**
 * How many terminals are busy across all windows. The exit path needs this
 * because quitting kills every window's PTYs, not just the caller's (#178).
 */
export async function ptyBusyCount(): Promise<number> {
  return invoke<number>('pty_busy_count')
}

/** Quit Pike. Called after the exit confirmation (#178). */
export async function appExit(): Promise<void> {
  return invoke('app_exit')
}

/**
 * Whether closing this window would quit Pike (nothing else is left to keep it
 * running). True makes the close confirmation count every window's terminals
 * instead of just this window's tabs (#202).
 */
export async function windowCloseQuitsApp(): Promise<boolean> {
  return invoke<boolean>('window_close_quits_app')
}

export async function ptyGetCwd(id: string): Promise<string | null> {
  return invoke<string | null>('pty_get_cwd', { id })
}

// Environment detection

export async function detectWslDistros(): Promise<string[]> {
  return invoke<string[]>('detect_wsl_distros')
}

// Project — last project persistence

export async function projectGetLast(): Promise<string[]> {
  return invoke<string[]>('project_get_last')
}

export async function projectSetLast(ids: string[]): Promise<void> {
  return invoke('project_set_last', { ids })
}

export async function projectAddOpen(id: string): Promise<void> {
  return invoke('project_add_open', { id })
}

/** The project this window currently shows, per the backend window_projects map
 *  (seeded at build). null for main/global windows. Replaces label parsing. */
export async function projectForWindow(): Promise<string | null> {
  return invoke('project_for_window')
}

/** Focus the window already showing this project, if any; returns whether one
 *  was found. When false, the caller switches its own window in place. */
export async function focusProjectWindow(projectId: string): Promise<boolean> {
  return invoke('focus_project_window', { projectId })
}

export async function projectRemoveOpen(id: string): Promise<void> {
  return invoke('project_remove_open', { id })
}

// Project — CRUD

export async function projectList(): Promise<ProjectConfig[]> {
  return invoke<ProjectConfig[]>('project_list')
}

export async function projectGet(id: string): Promise<ProjectConfig> {
  return invoke<ProjectConfig>('project_get', { id })
}

export async function projectCreate(config: ProjectConfig): Promise<ProjectConfig> {
  return invoke<ProjectConfig>('project_create', { config })
}

export async function projectUpdate(config: ProjectConfig): Promise<void> {
  return invoke('project_update', { config })
}

export async function projectDelete(id: string): Promise<void> {
  return invoke('project_delete', { id })
}

// Project — transient (#230): a directory opened without registering it. The
// config lives in backend memory only and dies with the window showing it.

/** Register a transient project for `path` and return it. Binding it to a
 *  window is a separate step (`projectTransientBind` here, `openProjectWindow`
 *  for a new one). */
export async function projectTransientCreate(path: string, distro?: string | null): Promise<ProjectConfig> {
  return invoke<ProjectConfig>('project_transient_create', { path, distro: distro ?? null })
}

/** The transient project for `id`, or null when the id names a registered one. */
export async function projectTransientGet(id: string): Promise<ProjectConfig | null> {
  return invoke<ProjectConfig | null>('project_transient_get', { id })
}

/** Point this window at a transient project — `projectAddOpen` minus the open
 *  list write, which a transient project must never enter. */
export async function projectTransientBind(id: string): Promise<void> {
  return invoke('project_transient_bind', { id })
}

/** Forget the transient entry, after its config has been written to disk. */
export async function projectTransientDrop(id: string): Promise<void> {
  return invoke('project_transient_drop', { id })
}

/**
 * Rebuild the shell-integration menus — the taskbar jump list (#160) and the
 * system-tray menu (#161). `lang` is the current UI locale so labels follow it.
 * Reads the project list once on the Rust side and feeds both. `shells` is the
 * visible shell list — both menus offer one terminal entry per shell (#240).
 * Best-effort — never blocks project operations if a menu can't be built.
 */
export async function menusRefresh(lang: string, shells: MenuShell[]): Promise<void> {
  return invoke('menus_refresh', { lang, shells })
}

/**
 * Update the tray tooltip (issue #161) with a formatted usage summary. Rust puts
 * the app name in front of it, so pass only the usage half (empty for none).
 */
export async function traySetTooltip(detail: string): Promise<void> {
  return invoke('tray_set_tooltip', { detail })
}

/**
 * Sync the close-to-tray setting (issue #161). When disabled, closing the main
 * window exits Pike instead of minimizing it to the tray.
 */
export async function traySetCloseToTray(enabled: boolean): Promise<void> {
  return invoke('tray_set_close_to_tray', { enabled })
}

/**
 * Apply the window backdrop for background transparency (issue #162), to the
 * calling window. `kind` is 'none' | 'transparent' | 'acrylic'. `baseRgb` is the
 * theme's opaque surface color as CSS components (`"30 30 30"`), used as the
 * webview's default background in the opaque mode so there is no flash of the
 * wrong color while loading or resizing.
 */
export async function windowSetBackdrop(kind: string, baseRgb: string): Promise<void> {
  return invoke('window_set_backdrop', { kind, baseRgb })
}

/**
 * 一時的な調査用ログ（TODO「謎のバックスペース」）が有効か。app data ディレクトリ
 * に `ime-debug.on` を置いた環境だけ true。既定は false で、何も記録しない。
 */
export async function imeDebugEnabled(): Promise<boolean> {
  return invoke<boolean>('ime_debug_enabled')
}

/**
 * 同上。溜めた行をファイルへ追記する。
 * 原因が判明したら `lib/imeDebugLog.ts` ごと削除する。
 */
export async function imeDebugLog(lines: string[]): Promise<void> {
  return invoke('ime_debug_log', { lines })
}

export async function projectGroupsList(): Promise<string[]> {
  return invoke<string[]>('project_groups_list')
}

export async function projectGroupsSave(groups: string[]): Promise<void> {
  return invoke('project_groups_save', { groups })
}

// Filesystem

export interface FsEntry {
  name: string
  isDir: boolean
  /** IGNORED_DIRS のディレクトリ: 淡色・展開不可（node_modules 等） */
  ignored: boolean
  /** .gitignore にマッチ（ファイル/ディレクトリ両方）。色分け用。dir は展開可能。 */
  gitignored: boolean
}

/** checkGitignore: git リポジトリのときのみ true を渡す（非 git での無駄な git 実行を避ける）。 */
export async function fsListDir(shell: ShellType, path: string, checkGitignore = false): Promise<FsEntry[]> {
  return invoke<FsEntry[]>('fs_list_dir', { shell, path, checkGitignore })
}

export interface FileReadResult {
  content: string
  encoding: string
  /** True when the file does not exist yet: opened as a blank new file
   *  (vim-like); the first save creates it. */
  isNew: boolean
}

export async function fsOpenInExplorer(shell: ShellType, path: string): Promise<void> {
  return invoke('fs_open_in_explorer', { shell, path })
}

export async function fsReadFile(
  shell: ShellType,
  path: string,
  encoding?: string,
  options?: { allowMissing?: boolean },
): Promise<FileReadResult> {
  return invoke<FileReadResult>('fs_read_file', {
    shell,
    path,
    encoding: encoding ?? null,
    allowMissing: options?.allowMissing ?? null,
  })
}

export async function fsWriteFile(shell: ShellType, path: string, content: string, encoding?: string): Promise<void> {
  return invoke('fs_write_file', { shell, path, content, encoding: encoding ?? null })
}

export async function fsReadFileBase64(shell: ShellType, path: string): Promise<string> {
  return invoke<string>('fs_read_file_base64', { shell, path })
}

export async function fsRename(shell: ShellType, oldPath: string, newPath: string): Promise<void> {
  return invoke('fs_rename', { shell, oldPath, newPath })
}

export async function fsDelete(shell: ShellType, path: string): Promise<void> {
  return invoke('fs_delete', { shell, path })
}

export async function fsCopy(shell: ShellType, source: string, dest: string): Promise<void> {
  return invoke('fs_copy', { shell, source, dest })
}

/**
 * Copy one file's contents into `dest`, without its NTFS alternate data
 * streams — see `fs_import_file`. Use this to bring an outside file in;
 * `fsCopy` is for moving files around inside one tree.
 */
export async function fsImportFile(shell: ShellType, source: string, dest: string): Promise<void> {
  return invoke('fs_import_file', { shell, source, dest })
}

export async function fsCreateFile(shell: ShellType, path: string): Promise<void> {
  return invoke('fs_create_file', { shell, path })
}

export async function fsCreateDir(shell: ShellType, path: string): Promise<void> {
  return invoke('fs_create_dir', { shell, path })
}

export async function fsWriteFileBase64(shell: ShellType, path: string, data: string): Promise<void> {
  return invoke('fs_write_file_base64', { shell, path, data })
}

export async function fsResolveFirstExisting(shell: ShellType, candidates: string[]): Promise<string | null> {
  return invoke<string | null>('fs_resolve_first_existing', { shell, candidates })
}

/** Per-path "is this a directory?" for one shell, in a single round-trip. */
export async function fsDirsExist(shell: ShellType, paths: string[]): Promise<boolean[]> {
  return invoke<boolean[]>('fs_dirs_exist', { shell, paths })
}

// Settings sync (external JSON file at a user-chosen host path)

/** Contents of the sync file, or null when there is no file yet. Rejects when a
 *  file exists but cannot be read — the caller must not treat that as empty. */
export async function settingsSyncRead(path: string): Promise<string | null> {
  return invoke<string | null>('settings_sync_read', { path })
}

export async function settingsSyncWrite(path: string, content: string): Promise<void> {
  return invoke('settings_sync_write', { path, content })
}

// Watcher

export async function fsWatchStart(shell: ShellType, root: string): Promise<string> {
  return invoke<string>('fs_watch_start', { shell, root })
}

export async function fsWatchStop(watcherId: string): Promise<void> {
  return invoke('fs_watch_stop', { watcherId })
}

// Git

export async function gitStatus(root: string, shell: ShellType): Promise<GitStatusResult> {
  return invoke<GitStatusResult>('git_status', { root, shell })
}

export async function gitIsRepo(root: string, shell: ShellType): Promise<boolean> {
  return invoke<boolean>('git_is_repo', { root, shell })
}

export async function gitInit(root: string, shell: ShellType): Promise<void> {
  return invoke('git_init', { root, shell })
}

export async function gitLog(root: string, shell: ShellType, count?: number, all?: boolean): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>('git_log', { root, shell, count: count ?? null, all: all ?? null })
}

export async function gitDiff(
  root: string,
  shell: ShellType,
  path: string,
  staged: boolean,
  untracked = false,
): Promise<string> {
  return invoke<string>('git_diff', { root, shell, path, staged, untracked })
}

export async function gitStage(root: string, shell: ShellType, paths: string[]): Promise<void> {
  return invoke('git_stage', { root, shell, paths })
}

export async function gitUnstage(root: string, shell: ShellType, paths: string[]): Promise<void> {
  return invoke('git_unstage', { root, shell, paths })
}

export async function gitDiscardChanges(root: string, shell: ShellType, paths: string[]): Promise<void> {
  return invoke('git_discard_changes', { root, shell, paths })
}

export async function gitCommit(root: string, shell: ShellType, message: string): Promise<void> {
  return invoke('git_commit', { root, shell, message })
}

export async function gitBranchList(root: string, shell: ShellType): Promise<GitBranches> {
  return invoke<GitBranches>('git_branch_list', { root, shell })
}

export async function gitWorktreeList(root: string, shell: ShellType): Promise<GitWorktree[]> {
  return invoke<GitWorktree[]>('git_worktree_list', { root, shell })
}

export async function gitCheckout(root: string, shell: ShellType, branch: string): Promise<void> {
  return invoke('git_checkout', { root, shell, branch })
}

/** Check out a remote-tracking branch (`origin/foo`) as a local tracking branch. */
export async function gitCheckoutTrack(root: string, shell: ShellType, remoteBranch: string): Promise<void> {
  return invoke('git_checkout_track', { root, shell, remoteBranch })
}

export async function gitCreateBranch(root: string, shell: ShellType, name: string, startPoint: string): Promise<void> {
  return invoke('git_create_branch', { root, shell, name, startPoint })
}

export async function gitRemoteUrl(root: string, shell: ShellType): Promise<string | null> {
  return invoke<string | null>('git_remote_url', { root, shell })
}

/** `gitRemoteUrl` for many roots of one shell, in order (null = no origin). */
export async function gitRemoteUrls(shell: ShellType, roots: string[]): Promise<(string | null)[]> {
  return invoke<(string | null)[]>('git_remote_urls', { shell, roots })
}

export async function gitFetch(root: string, shell: ShellType): Promise<void> {
  return invoke('git_fetch', { root, shell })
}

export async function gitPush(root: string, shell: ShellType, options?: PushOption[]): Promise<string> {
  return invoke<string>('git_push', { root, shell, options })
}

export async function gitPull(root: string, shell: ShellType, options?: PullOption[]): Promise<string> {
  return invoke<string>('git_pull', { root, shell, options })
}

/**
 * Raw bytes of a file at a commit, base64-encoded. Needed to open a binary
 * revision (an image) in its viewer — `gitShowFile` returns decoded text.
 */
export async function gitShowFileBase64(root: string, shell: ShellType, hash: string, path: string): Promise<string> {
  return invoke<string>('git_show_file_base64', { root, shell, hash, path })
}

export async function gitShowFiles(root: string, shell: ShellType, hash: string): Promise<GitFileChange[]> {
  return invoke<GitFileChange[]>('git_show_files', { root, shell, hash })
}

export async function gitDiffCommit(root: string, shell: ShellType, hash: string, path: string): Promise<string> {
  return invoke<string>('git_diff_commit', { root, shell, hash, path })
}

export async function gitShowFile(root: string, shell: ShellType, hash: string, path: string): Promise<string> {
  return invoke<string>('git_show_file', { root, shell, hash, path })
}

export async function gitLogFile(root: string, shell: ShellType, path: string, count?: number): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>('git_log_file', { root, shell, path, count: count ?? null })
}

export async function gitLogFileLines(
  root: string,
  shell: ShellType,
  path: string,
  startLine: number,
  endLine: number,
  count?: number,
): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>('git_log_file_lines', {
    root,
    shell,
    path,
    startLine,
    endLine,
    count: count ?? null,
  })
}

export interface GitDiffLines {
  added: [number, number][]
  modified: [number, number][]
  deleted: number[]
}

export async function gitDiffLines(root: string, shell: ShellType, path: string): Promise<GitDiffLines> {
  return invoke<GitDiffLines>('git_diff_lines', { root, shell, path })
}

export async function gitDiffWorking(root: string, shell: ShellType): Promise<string> {
  return invoke<string>('git_diff_working', { root, shell })
}

// Search

export async function searchDetectBackend(shell: ShellType): Promise<SearchBackend> {
  return invoke<SearchBackend>('search_detect_backend', { shell })
}

export async function searchExecute(
  shell: ShellType,
  root: string,
  query: string,
  isRegex: boolean,
  globInclude?: string,
  globExclude?: string,
  maxResults?: number,
): Promise<SearchResult> {
  return invoke<SearchResult>('search_execute', {
    shell,
    root,
    query,
    isRegex,
    globInclude: globInclude ?? null,
    globExclude: globExclude ?? null,
    maxResults: maxResults ?? null,
  })
}

export async function listProjectFiles(shell: ShellType, root: string): Promise<string[]> {
  return invoke<string[]>('list_project_files', { shell, root })
}

// Docker

export async function dockerPing(): Promise<boolean> {
  return invoke<boolean>('docker_ping')
}

/** Every compose file in the project (root + two levels), shallowest first. */
export async function dockerComposeDiscover(root: string, shell: ShellType): Promise<ComposeProject[]> {
  return invoke<ComposeProject[]>('docker_compose_discover', { root, shell })
}

export async function dockerListContainers(): Promise<ContainerListResult> {
  return invoke<ContainerListResult>('docker_list_containers')
}

export async function dockerStart(containerId: string): Promise<void> {
  return invoke('docker_start', { containerId })
}

export async function dockerStop(containerId: string): Promise<void> {
  return invoke('docker_stop', { containerId })
}

export async function dockerRestart(containerId: string): Promise<void> {
  return invoke('docker_restart', { containerId })
}

export async function dockerLogsStart(containerId: string): Promise<string> {
  return invoke<string>('docker_logs_start', { containerId })
}

export async function dockerLogsStop(streamId: string): Promise<void> {
  return invoke('docker_logs_stop', { streamId })
}

export async function dockerDetectShell(containerId: string): Promise<string> {
  return invoke<string>('docker_detect_shell', { containerId })
}

export async function dockerTunnelCreate(containerId: string, port: number): Promise<TunnelInfo> {
  return invoke<TunnelInfo>('docker_tunnel_create', { containerId, port })
}

export async function dockerTunnelStop(tunnelId: string): Promise<void> {
  return invoke('docker_tunnel_stop', { tunnelId })
}

export async function dockerContainerPorts(containerId: string): Promise<number[]> {
  return invoke<number[]>('docker_container_ports', { containerId })
}

// Window

export async function openProjectWindow(projectId: string): Promise<void> {
  return invoke('open_project_window', { projectId })
}

/** Open a new global-mode window with a terminal on the configured global shell. */
export async function openGlobalWindow(): Promise<void> {
  return invoke('open_global_window')
}

/** Whether the current Pike process runs elevated (Windows administrator). */
export async function isElevated(): Promise<boolean> {
  return invoke<boolean>('is_elevated')
}

/** Relaunch Pike elevated (UAC) to open a terminal on the given Windows shell
 *  kind ('cmd' | 'powershell' | 'pwsh' | 'git-bash'). With `projectId` the admin
 *  window reopens that project in normal mode; otherwise it opens as a global
 *  terminal window (#138). */
export async function openElevatedTerminal(shell: string, opts?: { projectId?: string }): Promise<void> {
  return invoke('open_elevated_terminal', {
    shell,
    projectId: opts?.projectId ?? null,
  })
}

export async function saveAllWindowState(): Promise<void> {
  return invoke('save_all_window_state')
}

// Tasks

interface TaskDiscoverResult {
  runner: string
  label: string
  sourceFile: string
  cwd: string
  tasks: { name: string; command: string; description: string | null; runner: string }[]
}

export async function taskDiscover(shell: ShellType, root: string): Promise<TaskDiscoverResult[]> {
  return invoke<TaskDiscoverResult[]>('task_discover', { shell, root })
}

// Diagnostics

export async function diagnosticsRun(
  shell: ShellType,
  root: string,
  golangci: boolean,
  golangciCommand?: string,
): Promise<DiagnosticsResult> {
  return invoke<DiagnosticsResult>('diagnostics_run', {
    shell,
    root,
    golangci,
    golangciCommand: golangciCommand ?? null,
  })
}

export async function openUrl(url: string): Promise<void> {
  return invoke('open_url', { url })
}

export interface RemoteImage {
  mime: string
  base64: string
}

/** Fetch an https image for the Markdown preview to inline as a data URL (#239). */
export async function remoteImageFetch(url: string): Promise<RemoteImage> {
  return invoke<RemoteImage>('remote_image_fetch', { url })
}

export async function openUrlWithConfirm(url: string): Promise<void> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return
  if (await confirmDialog(t('confirm.openUrl', { url }))) {
    await openUrl(url)
  }
}

/**
 * A web page's `<title>`, for turning a pasted URL into `[title](url)` (#241).
 *
 * Null covers every "no title to use" case（HTML でない、取れなかった、`<title>` が無い）。
 * 呼び出し側から見れば区別する意味が無い: URL は既に文書に入っているので、
 * 失敗はそのままにするだけで済む。
 */
export async function pageTitleFetch(url: string): Promise<string | null> {
  return invoke<string | null>('page_title_fetch', { url })
}

export async function pickFolder(): Promise<string | null> {
  return invoke<string | null>('pick_folder')
}

export async function pickSaveFile(defaultName?: string): Promise<string | null> {
  return invoke<string | null>('pick_save_file', { defaultName: defaultName ?? null })
}

/** Open-file dialog limited to `extensions` (bare, no dot). Windows path or null. */
export async function pickOpenFile(extensions: string[]): Promise<string | null> {
  return invoke<string | null>('pick_open_file', { extensions })
}

// CLI

export interface CliFileTarget {
  path: string
  line: number | null
  /** WSL distro hint when the path was originally a WSL UNC path
   *  (\\wsl.localhost\<distro>\...). Lets project-less (global) windows
   *  rebuild a Windows-readable UNC path for file I/O. */
  distro?: string | null
}

export interface CliOpenFiles {
  action: 'openFiles'
  files: CliFileTarget[]
}

export interface CliOpenDirectory {
  action: 'openDirectory'
  path: string
  /** WSL distro hint captured by the CLI parser when the path was originally
   *  a WSL UNC path (\\wsl.localhost\<distro>\...). Used by ad-hoc project
   *  creation in Rust; not used by the frontend. */
  distro?: string | null
}

export interface CliOpenTerminal {
  action: 'openTerminal'
  cwd?: string | null
  /** cwd 由来で確定する場合のみ設定（WSL UNC → その distro）。
   *  未設定なら globalShell 設定で開く (#125) */
  shell?: ShellType | null
}

/** Reopen a project in normal mode plus a terminal on the given shell.
 *  Produced by the elevated relaunch from a project window (#138). */
export interface CliOpenProject {
  action: 'openProject'
  id: string
  shell?: ShellType | null
}

export interface CliNone {
  action: 'none'
}

export type CliAction = CliOpenFiles | CliOpenDirectory | CliOpenTerminal | CliOpenProject | CliNone

export async function cliGetInitialAction(): Promise<CliAction> {
  return invoke<CliAction>('cli_get_initial_action')
}

export async function cliSetPendingAction(windowLabel: string, action: CliAction): Promise<void> {
  return invoke('cli_set_pending_action', { windowLabel, action })
}

// Wait (--wait / GIT_EDITOR support)

export async function waitSignalByPath(path: string): Promise<boolean> {
  return invoke<boolean>('wait_signal_by_path', { path })
}

// Font

export async function fontListMonospace(): Promise<string[]> {
  return invoke<string[]>('font_list_monospace')
}

export async function fontListAll(): Promise<string[]> {
  return invoke<string[]>('font_list_all')
}

// Agent (unified API — works with Codex, Claude Code, and other ACP agents)

import type {
  AgentApprovalDecision,
  AgentAuthState,
  AgentCapabilities,
  AgentEditorContext,
  AgentModelInfo,
  AgentType,
} from '../types/agent'

export async function agentCheckAvailable(agentType: AgentType, shell: ShellType): Promise<string> {
  return invoke<string>('agent_check_available', { agentType, shell })
}

export async function agentEnsureInstalled(agentType: AgentType, shell: ShellType): Promise<string> {
  return invoke<string>('agent_ensure_installed', { agentType, shell })
}

export async function agentStartSession(
  tabId: string,
  agentType: AgentType,
  shell: ShellType,
  cwd: string,
  sessionId?: string | null,
  sandboxMode?: string | null,
  approvalPolicy?: string | null,
): Promise<string> {
  return invoke<string>('agent_start_session', {
    tabId,
    agentType,
    shell,
    cwd,
    sessionId: sessionId ?? null,
    sandboxMode: sandboxMode ?? null,
    approvalPolicy: approvalPolicy ?? null,
  })
}

export async function agentCapabilities(tabId: string): Promise<AgentCapabilities> {
  return invoke<AgentCapabilities>('agent_capabilities', { tabId })
}

export async function agentSubmitTurn(
  tabId: string,
  prompt: string,
  editorContext?: AgentEditorContext | null,
  model?: string | null,
): Promise<void> {
  return invoke('agent_submit_turn', {
    tabId,
    prompt,
    editorContext: editorContext ?? null,
    model: model ?? null,
  })
}

export async function agentInterruptTurn(tabId: string): Promise<void> {
  return invoke('agent_interrupt_turn', { tabId })
}

export async function agentRollbackTurn(tabId: string): Promise<void> {
  return invoke('agent_rollback_turn', { tabId })
}

export async function agentCompact(tabId: string): Promise<void> {
  return invoke('agent_compact', { tabId })
}

/**
 * `optionId` is the ACP option the user actually pressed (#227). Only the generic
 * dialog has one — it renders the agent's own options, and an agent may offer
 * several with the same kind, so the decision alone cannot identify the button.
 */
export async function agentRespondApproval(
  tabId: string,
  requestId: unknown,
  decision: AgentApprovalDecision,
  optionId?: string,
): Promise<void> {
  return invoke('agent_respond_approval', { tabId, requestId, decision, optionId })
}

export async function agentAuthStatus(tabId: string): Promise<AgentAuthState> {
  return invoke<AgentAuthState>('agent_auth_status', { tabId })
}

export async function agentAuthLogin(tabId: string): Promise<void> {
  return invoke('agent_auth_login', { tabId })
}

export async function agentAuthLogout(tabId: string): Promise<void> {
  return invoke('agent_auth_logout', { tabId })
}

export async function agentListModels(tabId: string): Promise<AgentModelInfo[]> {
  return invoke<AgentModelInfo[]>('agent_list_models', { tabId })
}

export async function agentDisconnect(tabId: string): Promise<void> {
  return invoke('agent_disconnect', { tabId })
}

// Claude Usage

export async function claudeUsageGet(shell: ShellType, projectRoot: string): Promise<ClaudeUsageResult> {
  return invoke<ClaudeUsageResult>('claude_usage_get', { shell, projectRoot })
}

/**
 * Past interactive Claude Code sessions of `projectRoot`, newest first — the
 * terminal launcher's `claude --resume` list (#220).
 */
export async function claudeSessionsList(shell: ShellType, projectRoot: string): Promise<ClaudeSession[]> {
  return invoke<ClaudeSession[]>('claude_sessions_list', { shell, projectRoot })
}

/**
 * Rate-limit usage via `claude -p "/usage"`. Rust caches the (slow) CLI call;
 * `sessionActive` picks the short refresh TTL, `force` bypasses the cache.
 */
export async function claudeUsageRateGet(
  shell: ShellType,
  projectRoot: string,
  sessionActive: boolean,
  force = false,
): Promise<ClaudeRateLimits> {
  return invoke<ClaudeRateLimits>('claude_usage_rate_get', { shell, projectRoot, sessionActive, force })
}

// Codex Usage (indirect CLI sessions from ~/.codex rollouts)

export async function codexUsageGet(shell: ShellType, projectRoot: string): Promise<CodexUsageResult> {
  return invoke<CodexUsageResult>('codex_usage_get', { shell, projectRoot })
}
