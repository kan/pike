import { invoke } from '@tauri-apps/api/core'
import type { ComposeService, ContainerInfo } from '../types/docker'
import type { GitFileChange, GitLogEntry, GitStatusResult } from '../types/git'
import type { ProjectConfig } from '../types/project'
import type { SearchBackend, SearchResult } from '../types/search'
import type { ShellType } from '../types/tab'

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

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke('pty_resize', { id, cols, rows })
}

export async function ptyKill(id: string): Promise<void> {
  return invoke('pty_kill', { id })
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

// Filesystem

export interface FsEntry {
  name: string
  isDir: boolean
}

export async function fsListDir(shell: ShellType, path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>('fs_list_dir', { shell, path })
}

export interface FileReadResult {
  content: string
  encoding: string
}

export async function fsReadFile(shell: ShellType, path: string, encoding?: string): Promise<FileReadResult> {
  return invoke<FileReadResult>('fs_read_file', { shell, path, encoding: encoding ?? null })
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

export async function fsCreateFile(shell: ShellType, path: string): Promise<void> {
  return invoke('fs_create_file', { shell, path })
}

export async function fsCreateDir(shell: ShellType, path: string): Promise<void> {
  return invoke('fs_create_dir', { shell, path })
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

export async function gitLog(root: string, shell: ShellType, count?: number, all?: boolean): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>('git_log', { root, shell, count: count ?? null, all: all ?? null })
}

export async function gitDiff(root: string, shell: ShellType, path: string, staged: boolean): Promise<string> {
  return invoke<string>('git_diff', { root, shell, path, staged })
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

export async function gitBranchList(root: string, shell: ShellType): Promise<string[]> {
  return invoke<string[]>('git_branch_list', { root, shell })
}

export async function gitCheckout(root: string, shell: ShellType, branch: string): Promise<void> {
  return invoke('git_checkout', { root, shell, branch })
}

export async function gitFetch(root: string, shell: ShellType): Promise<void> {
  return invoke('git_fetch', { root, shell })
}

export async function gitPush(root: string, shell: ShellType): Promise<string> {
  return invoke<string>('git_push', { root, shell })
}

export async function gitPull(root: string, shell: ShellType): Promise<string> {
  return invoke<string>('git_pull', { root, shell })
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

export async function dockerComposeServices(root: string, shell: ShellType): Promise<ComposeService[]> {
  return invoke<ComposeService[]>('docker_compose_services', { root, shell })
}

export async function dockerListContainers(): Promise<ContainerInfo[]> {
  return invoke<ContainerInfo[]>('docker_list_containers')
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

// Window

export async function openProjectWindow(projectId: string): Promise<void> {
  return invoke('open_project_window', { projectId })
}

export async function openUrl(url: string): Promise<void> {
  return invoke('open_url', { url })
}

export async function pickFolder(): Promise<string | null> {
  return invoke<string | null>('pick_folder')
}

export async function pickSaveFile(defaultName?: string): Promise<string | null> {
  return invoke<string | null>('pick_save_file', { defaultName: defaultName ?? null })
}

// CLI

export interface CliOpenFile {
  action: 'openFile'
  path: string
  line: number | null
}

export interface CliOpenDirectory {
  action: 'openDirectory'
  path: string
}

export interface CliNone {
  action: 'none'
}

export type CliAction = CliOpenFile | CliOpenDirectory | CliNone

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

// Codex

import type { CodexAuthState } from '../types/codex'

export async function codexDisconnect(): Promise<void> {
  return invoke('codex_disconnect')
}

export async function codexCheckAvailable(shell: ShellType): Promise<string> {
  return invoke<string>('codex_check_available', { shell })
}

export async function codexAuthStatus(): Promise<CodexAuthState> {
  return invoke<CodexAuthState>('codex_auth_status')
}

export async function codexAuthLoginChatGpt(): Promise<void> {
  return invoke('codex_auth_login_chatgpt')
}

export async function codexAuthLogout(): Promise<void> {
  return invoke('codex_auth_logout')
}

export async function codexStartSession(
  shell: ShellType,
  cwd: string,
  threadId: string | null,
  sandboxMode?: string | null,
  approvalPolicy?: string | null,
): Promise<string> {
  return invoke<string>('codex_start_session', {
    shell,
    cwd,
    threadId,
    sandboxMode: sandboxMode ?? null,
    approvalPolicy: approvalPolicy ?? null,
  })
}

export interface CodexEditorContext {
  path: string
  line: number | null
  col: number | null
  selectionStart: number | null
  selectionEnd: number | null
}

export async function codexSubmitTurn(
  prompt: string,
  editorContext?: CodexEditorContext | null,
  model?: string | null,
): Promise<void> {
  return invoke('codex_submit_turn', { prompt, editorContext: editorContext ?? null, model: model ?? null })
}

export interface CodexModelInfo {
  id: string
  displayName: string | null
  description: string | null
  isDefault: boolean
}

export async function codexModelList(): Promise<CodexModelInfo[]> {
  return invoke<CodexModelInfo[]>('codex_model_list')
}

export async function codexInterruptTurn(): Promise<void> {
  return invoke('codex_interrupt_turn')
}

export async function codexCompactThread(): Promise<void> {
  return invoke('codex_compact_thread')
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export async function codexRespondApproval(requestId: number | string, decision: ApprovalDecision): Promise<void> {
  return invoke('codex_respond_approval', { requestId, decision })
}
