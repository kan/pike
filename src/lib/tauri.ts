import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type { AgentSession } from '../types/agentSession'
import type { AgentUsage } from '../types/agentUsage'
import type { DiagnosticsResult } from '../types/diagnostics'
import type { ComposeProject, ContainerListResult, TunnelInfo } from '../types/docker'
import type {
  GitBranches,
  GitFileChange,
  GitLogEntry,
  GitNetworkResult,
  GitStatusResult,
  GitWorktree,
  PullOption,
  PushOption,
} from '../types/git'
import type { IssueDetail, IssueListResult } from '../types/issues'
import type { ProjectConfig } from '../types/project'
import type { ReplaceFileEdit, ReplaceOutcome, SearchBackendInfo, SearchOptions, SearchResult } from '../types/search'
import type { MenuAction, MenuShell, ShellType } from '../types/tab'

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

/**
 * このウィンドウを前に出す（トレイのヒント通知）。
 *
 * **`getCurrentWindow().show()` を直に呼ばないこと。** 理由は Rust 側の `window_restore` の
 * doc が正本（要点は、論理的に閉じた main のフラグを落とすのがあちらだけなので、素の show
 * だと次のウィンドウ close でアプリごと終了しうる。加えて `show` は
 * `core:window:default` に無いので、permission エラーで無言に失敗する）。
 */
export async function windowRestore(): Promise<void> {
  return invoke<void>('window_restore')
}

/**
 * タスクバーのボタンを点滅させて、このウィンドウに用があることを知らせる（#265）。
 *
 * 止めるのは OS の仕事で、ウィンドウがアクティブになれば消える。**デスクトップ通知
 * （`toastNotify`）と並べて使う**: あちらを見逃してもタスクバーに残る。
 */
export async function windowFlash(): Promise<void> {
  return invoke<void>('window_flash')
}

/**
 * デスクトップ通知を 1 件出す（#318、Windows のみ）。**押すとその知らせの出どころへ
 * 連れて行く**（#334）。
 *
 * **宛先はウィンドウではなく `pty` と `project`。** 押されるのは通知センターから数時間後
 * でもよく、そのころ Pike が走っていないことすらある（Windows が `pike://` で起こし直す）。
 * 判断の正本は Rust 側の `toast/activation.rs` の doc。
 *
 * **`lib/notify.ts` の経路とは別物。** あちらは押せない知らせ（トレイのヒント）用。
 */
export async function toastNotify(pty: string, project: string | null, title: string, body: string): Promise<void> {
  return invoke<void>('toast_notify', { pty, project, title, body })
}

export async function ptyGetCwd(id: string): Promise<string | null> {
  return invoke<string | null>('pty_get_cwd', { id })
}

// Environment detection

export async function detectWslDistros(): Promise<string[]> {
  return invoke<string[]>('detect_wsl_distros')
}

// Project — last project persistence

/** 前回開いていたウィンドウ 1 つぶん（#264）。`held` は保持していたプロジェクト。 */
export interface WindowSession {
  shown: string
  held: string[]
}

export async function projectGetLast(): Promise<WindowSession[]> {
  return invoke<WindowSession[]>('project_get_last')
}

export async function projectAddOpen(id: string): Promise<void> {
  return invoke('project_add_open', { id })
}

/**
 * このウィンドウがタブを保持しているプロジェクトを backend に伝える（#264）。
 * ジャンプリストや `pike <dir>` からの解決が、保持しているウィンドウを見つけられるように。
 */
export async function projectSetParked(ids: string[]): Promise<void> {
  return invoke('project_set_parked', { ids })
}

/**
 * このウィンドウが見せているプロジェクトと、保持しているもの（#264）。main / グローバル
 * ウィンドウでは null。不透明なラベルを解釈する代わりにこれを引く。
 */
export async function projectForWindow(): Promise<WindowSession | null> {
  return invoke<WindowSession | null>('project_for_window')
}

/** Focus the window already showing this project, if any; returns whether one
 *  was found. When false, the caller switches its own window in place. */
export async function focusProjectWindow(projectId: string): Promise<boolean> {
  return invoke('focus_project_window', { projectId })
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
 * `actions` is the macOS menu bar spec (#254): labels come from the frontend i18n
 * and accelerators from `keyBindings`, so Rust keeps no copy of either.
 * Best-effort — never blocks project operations if a menu can't be built.
 */
export async function menusRefresh(lang: string, shells: MenuShell[], actions: MenuAction[]): Promise<void> {
  return invoke('menus_refresh', { lang, shells, actions })
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
  /** IGNORED_DIRS のディレクトリ（node_modules 等）: 淡色・歯車アイコン。展開はできるが監視・検索の対象外 */
  ignored: boolean
  /** .gitignore にマッチ（ファイル/ディレクトリ両方）。色分け用。 */
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
  /** `maxBytes` を超えていたときのバイト数（#362）。このとき `content` は空。 */
  tooLarge?: number
}

/**
 * パスを OS に開かせる。**ディレクトリならエクスプローラー / Finder、ファイルなら関連付けられた
 * アプリ**で開く（#362 の「関連付けられたアプリで開く」もこれ）。
 */
export async function fsOpenInExplorer(shell: ShellType, path: string): Promise<void> {
  return invoke('fs_open_in_explorer', { shell, path })
}

/** ファイルを選んだ状態でエクスプローラー / Finder を開く（#362）。 */
export async function fsRevealInExplorer(shell: ShellType, path: string): Promise<void> {
  return invoke('fs_reveal_in_explorer', { shell, path })
}

/**
 * `maxBytes` を渡すと、上限を超えたファイルはエラーではなく `tooLarge`（バイト数）付きの結果で
 * 返る（#362。`allowMissing` と `isNew` と同じ形）。渡さなければ従来どおり 2MB でエラーになる。
 */
export async function fsReadFile(
  shell: ShellType,
  path: string,
  encoding?: string,
  options?: { allowMissing?: boolean; maxBytes?: number },
): Promise<FileReadResult> {
  return invoke<FileReadResult>('fs_read_file', {
    shell,
    path,
    encoding: encoding ?? null,
    allowMissing: options?.allowMissing ?? null,
    maxBytes: options?.maxBytes ?? null,
  })
}

/** 部分読み込みの 1 回ぶん（#362）。`nextOffset >= totalSize` なら末尾まで読んだ。 */
export interface FileChunk {
  content: string
  encoding: string
  nextOffset: number
  totalSize: number
}

export async function fsReadFileChunk(
  shell: ShellType,
  path: string,
  offset: number,
  len: number,
  encoding?: string,
): Promise<FileChunk> {
  return invoke<FileChunk>('fs_read_file_chunk', { shell, path, offset, len, encoding: encoding ?? null })
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

/** Every candidate that exists as a regular file, in the given order (one round-trip). */
export async function fsExistingPaths(shell: ShellType, candidates: string[]): Promise<string[]> {
  return invoke<string[]>('fs_existing_paths', { shell, candidates })
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
  /** `GitFileChange.origPath`（#306）。 */
  origPath: string | null = null,
): Promise<string> {
  return invoke<string>('git_diff', { root, shell, path, staged, untracked, origPath })
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

export async function gitFetch(root: string, shell: ShellType): Promise<GitNetworkResult> {
  return invoke<GitNetworkResult>('git_fetch', { root, shell })
}

export async function gitPush(root: string, shell: ShellType, options?: PushOption[]): Promise<GitNetworkResult> {
  return invoke<GitNetworkResult>('git_push', { root, shell, options })
}

export async function gitPull(root: string, shell: ShellType, options?: PullOption[]): Promise<GitNetworkResult> {
  return invoke<GitNetworkResult>('git_pull', { root, shell, options })
}

/**
 * 鍵のパスフレーズを ssh-agent へ預ける（#386）。
 *
 * **これが秘密を運ぶ唯一の IPC。** Rust 側は受け取った値を `ssh-add` の標準入力へ一度
 * 流すだけで、どこにも書かない（`ssh_agent::add_key`）。**呼び出し側も覚えないこと**:
 * 保持するのは agent で、Pike ではない。
 */
export async function gitSshAdd(root: string, shell: ShellType, passphrase: string): Promise<void> {
  return invoke<void>('git_ssh_add', { root, shell, passphrase })
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

/** コミット全体の差分（#374）。`parent` は第 1 親（最初のコミットなら `null`）。 */
export async function gitCommitPatch(
  root: string,
  shell: ShellType,
  hash: string,
  parent: string | null,
): Promise<{ patch: string; truncated: boolean }> {
  return invoke<{ patch: string; truncated: boolean }>('git_commit_patch', { root, shell, hash, parent })
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

/**
 * ガターのホバーで見せる「消えた行」1 かたまり（#322）。Rust の `RemovedBlock`。
 *
 * `lines` は上限（40 行 / 1 行 200 文字）で切ってあり、`total` が本当の行数。
 */
export interface RemovedBlock {
  /** 新しい側でこのかたまりが現れる行（`modified` の開始、または `deleted` の位置）。 */
  line: number
  lines: string[]
  total: number
}

export interface GitDiffLines {
  added: [number, number][]
  modified: [number, number][]
  deleted: number[]
  removed: RemovedBlock[]
}

export async function gitDiffLines(root: string, shell: ShellType, path: string): Promise<GitDiffLines> {
  return invoke<GitDiffLines>('git_diff_lines', { root, shell, path })
}

export async function gitDiffWorking(root: string, shell: ShellType): Promise<string> {
  return invoke<string>('git_diff_working', { root, shell })
}

// Search

/** `refresh` は覚えた答えを捨てて聞き直す（ripgrep を入れ直したあと）。 */
export async function searchDetectBackend(shell: ShellType, refresh = false): Promise<SearchBackendInfo> {
  return invoke<SearchBackendInfo>('search_detect_backend', { shell, refresh })
}

export async function searchExecute(shell: ShellType, root: string, options: SearchOptions): Promise<SearchResult> {
  return invoke<SearchResult>('search_execute', { shell, root, options })
}

export async function searchReplaceApply(shell: ShellType, edits: ReplaceFileEdit[]): Promise<ReplaceOutcome> {
  return invoke<ReplaceOutcome>('search_replace_apply', { shell, edits })
}

export async function listProjectFiles(shell: ShellType, root: string): Promise<string[]> {
  return invoke<string[]>('list_project_files', { shell, root })
}

// Agents (#275)

/**
 * PATH にあるエージェントの `bin` 名を返す（1 回のシェル起動で全部聞く）。
 * どの名前を聞くかは `lib/agents.ts` の表が決める。
 */
export async function agentDetect(shell: ShellType, root: string, bins: string[]): Promise<string[]> {
  return invoke<string[]>('agent_detect', { shell, root, bins })
}

// Issues (#278)

export async function issuesGhAvailable(shell: ShellType, root: string, force: boolean): Promise<boolean> {
  return invoke<boolean>('issues_gh_available', { shell, root, force })
}

export async function issuesList(shell: ShellType, root: string, limit: number): Promise<IssueListResult> {
  return invoke<IssueListResult>('issues_list', { shell, root, limit })
}

export async function issuesView(shell: ShellType, root: string, number: number): Promise<IssueDetail> {
  return invoke<IssueDetail>('issues_view', { shell, root, number })
}

// ブラウザのタブ（#368）。座標はウィンドウの client 領域の CSS ピクセル（論理ピクセル）。

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

/** ページへ差し込む 1 ルール（Rust の `site_rules::SiteRule`。作るのは `activeSiteRules`）。 */
export interface SiteRulePayload {
  id: string
  name: string
  domains: string[]
  js: string
  css: string
}

/**
 * 子 webview を作る・動かす・閉じる指示を、**ウィンドウの中で送った順に 1 本ずつ**流す（#402）。
 *
 * Rust のコマンドは別々のタスクで走るので、続けて送ると届く順が入れ替わりうる。タブ 1 枚の中は
 * `BrowserTab.vue` の `sync` が直列にしているが、子 webview を別のタブへ譲る（`lib/browserHandoff.ts`）
 * と、譲った側が送った「隠す」が受け取った側の「見せる」より後に届き、見えるはずのページが
 * 消えたまま残りうる。ここで並べれば、どのタブから送ったものでも順が保たれる。
 */
let browserChain: Promise<unknown> = Promise.resolve()
function inOrder<T>(send: () => Promise<T>): Promise<T> {
  const run = browserChain.then(send, send)
  browserChain = run.catch(() => {})
  return run
}

export async function browserOpen(
  label: string,
  url: string,
  bounds: BrowserBounds,
  rules: SiteRulePayload[],
  /** Jira の拡張機能を入れるか（#380。入れるのは `*.atlassian.net` のページだけ）。 */
  jira: boolean,
): Promise<void> {
  return inOrder(() => invoke('browser_open', { label, url, bounds, rules, jira }))
}

/** ルールを変えたとき、開いているページの CSS を当て直す。 */
export async function browserApplyCss(label: string, rules: SiteRulePayload[]): Promise<void> {
  return invoke('browser_apply_css', { label, rules })
}

/**
 * 位置と表示をまとめて 1 回で送る。`bounds` を省くと表示だけを変える（隠すときは
 * 位置を送る意味が無い）。リサイズ中は毎フレーム呼ばれるので、2 往復に分けない。
 */
export async function browserPlace(label: string, visible: boolean, bounds?: BrowserBounds): Promise<void> {
  return inOrder(() => invoke('browser_place', { label, visible, bounds: bounds ?? null }))
}

export async function browserNavigate(label: string, url: string): Promise<void> {
  return invoke('browser_navigate', { label, url })
}

/** 今いるページの URL。ページの中の移動を拾うために定期的に引く（#368）。 */
export async function browserUrl(label: string): Promise<string> {
  return invoke('browser_url', { label })
}

export type BrowserHistoryAction = 'back' | 'forward' | 'reload'

export async function browserHistory(label: string, action: BrowserHistoryAction): Promise<void> {
  return invoke('browser_history', { label, action })
}

export async function browserClose(label: string): Promise<void> {
  return inOrder(() => invoke('browser_close', { label }))
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

export async function openProjectWindow(projectId: string, held?: string[]): Promise<void> {
  return invoke('open_project_window', { projectId, held: held ?? null })
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

/** ブラウザのタブに出すサイトのアイコン（#400）。取れなければ null。 */
export async function browserFavicon(url: string): Promise<RemoteImage | null> {
  return invoke<RemoteImage | null>('browser_favicon', { url })
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

/**
 * フォルダ選択。`initial` はダイアログの初期位置（#271）。WSL のディレクトリを選ぶには
 * `wslNativeToUnc` で作った UNC を渡す（Windows のダイアログは UNC を辿れる）。
 */
export async function pickFolder(initial?: string): Promise<string | null> {
  return invoke<string | null>('pick_folder', { initial: initial ?? null })
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

/** 通知からのコールドスタートで行きたいプロジェクト（#334）。**開くのはフロント**で、
 *  前回のセッションを復元してからそこへ行く（理由は Rust の `CliAction` の doc）。 */
export interface CliFocusProject {
  action: 'focusProject'
  id: string
}

/** `pike <dir>` を Pike のターミナルから叩いたときに、そのウィンドウへ届く（#352）。
 *  受け口は `adoptProject`（理由は Rust の `CliAction` の doc）。 */
export interface CliAdoptProject {
  action: 'adoptProject'
  id: string
}

export interface CliNone {
  action: 'none'
}

export type CliAction =
  | CliOpenFiles
  | CliOpenDirectory
  | CliOpenTerminal
  | CliOpenProject
  | CliFocusProject
  | CliAdoptProject
  | CliNone

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

// Agent usage (#263)

/**
 * そのエージェントの使用量。**種別ごとの口を持たない**（`id` で振り分けるのは Rust 側）。
 * `force` は Rust 側にキャッシュがある問い（Claude のレート）のための素通し。
 */
export async function agentUsageGet(
  id: string,
  shell: ShellType,
  projectRoot: string,
  force = false,
): Promise<AgentUsage> {
  return invoke<AgentUsage>('agent_usage', { id, shell, projectRoot, force })
}

/**
 * そのエージェントの、このプロジェクトでの過去セッション（新しい順、#220 / #267）。
 * 起動メニューの再開一覧が使う。**メニューを開いたときだけ呼ぶ**（ディスクを読み、
 * opencode ではプロセスを起こす）。
 */
export async function agentSessionsList(id: string, shell: ShellType, projectRoot: string): Promise<AgentSession[]> {
  return invoke<AgentSession[]>('agent_sessions', { id, shell, projectRoot })
}

// Claude Code の hook からのアカウント申告（#299）

/**
 * hook の登録の状態。正本は Rust の `src-tauri/src/agent_hook.rs`。
 *
 * `registered`（`settings.json` に書いてあるか）と `declared`（実際に申告が届いたか）は
 * 別物で、**効いているかを言うのは後者**。登録した直後はまだ null で、次に claude を
 * 起動したときに埋まる。
 */
export interface AgentHookTarget {
  /** そのシェルから見た設定ディレクトリ。`agentHookInstall` の宛先の指定にも使う。 */
  configDir: string
  settingsPath: string
  /** このマシンで登録する hook が全部入っているか。 */
  registered: boolean
  /** Pike の行が 1 本でもあるか。**削除ボタンはこちらで出す**（Rust 側の doc が正本）。 */
  hasAny: boolean
  /** 今の解決結果がここを指しているか。 */
  active: boolean
  /** この宛先を使うインストール（`wsl:<distro>` / ホスト）。install / uninstall に渡す。 */
  installKey: string
  /** この宛先に書く（書いた）コマンド行。シェルによって違う。 */
  command: string
}

export interface AgentHookStatus {
  /** 登録できる設定ディレクトリ。**アカウントごと・シェルごとにある**（#299）。 */
  targets: AgentHookTarget[]
  declared: string | null
}

/**
 * `distros` を渡すのは、**候補をプロジェクトのシェルに絞らない**ため（#299）。hook は
 * アカウントごとに持つものなので、Windows のプロジェクトを開いていても WSL の
 * `~/.claude` を登録できる必要がある。検出はフロントが済ませているものを使い回す
 * （Rust 側で `wsl.exe` をもう 1 本起こさない）。
 */
export async function agentHookStatus(
  shell: ShellType,
  projectRoot: string,
  distros: string[],
): Promise<AgentHookStatus> {
  return invoke<AgentHookStatus>('agent_hook_status', { shell, projectRoot, distros })
}

/** その設定ディレクトリの `settings.json` へ hook を足す。冪等。 */
export async function agentHookInstall(
  shell: ShellType,
  projectRoot: string,
  distros: string[],
  target: AgentHookTarget,
): Promise<AgentHookStatus> {
  return invoke<AgentHookStatus>('agent_hook_install', {
    shell,
    projectRoot,
    distros,
    configDir: target.configDir,
    installKey: target.installKey,
  })
}

/** 未登録の候補すべてへまとめて登録する。起動時の提案（1 回きり）が使う。 */
export async function agentHookInstallMissing(
  shell: ShellType,
  projectRoot: string,
  distros: string[],
): Promise<AgentHookStatus> {
  return invoke<AgentHookStatus>('agent_hook_install_missing', { shell, projectRoot, distros })
}

/**
 * 足した hook を取り除く。**消えるのは Pike が足した行だけ**。受け取った申告も
 * 一緒に捨てる（残すと、hook を外したのにそのプロジェクトが申告に縛られる）。
 */
export async function agentHookUninstall(
  shell: ShellType,
  projectRoot: string,
  distros: string[],
  target: AgentHookTarget,
): Promise<AgentHookStatus> {
  return invoke<AgentHookStatus>('agent_hook_uninstall', {
    shell,
    projectRoot,
    distros,
    configDir: target.configDir,
    installKey: target.installKey,
  })
}

/** 受け取った申告を捨てて、解決を推測（`.envrc` → シェルの環境変数 → 既定）へ戻す。 */
export async function agentHookForget(
  shell: ShellType,
  projectRoot: string,
  distros: string[],
): Promise<AgentHookStatus> {
  return invoke<AgentHookStatus>('agent_hook_forget', { shell, projectRoot, distros })
}
