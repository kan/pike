import { invoke } from "@tauri-apps/api/core";
import type { ShellType } from "../types/tab";
import type { ProjectConfig } from "../types/project";
import type { GitStatusResult, GitLogEntry, GitFileChange } from "../types/git";

// PTY

export interface PtySpawnResult {
  id: string;
}

export async function ptySpawn(
  cols: number,
  rows: number,
  opts?: { cwd?: string; shell?: ShellType }
): Promise<PtySpawnResult> {
  return invoke<PtySpawnResult>("pty_spawn", {
    cols,
    rows,
    cwd: opts?.cwd ?? null,
    shell: opts?.shell ?? null,
  });
}

export async function ptySpawnTmux(sessionName: string, cols: number, rows: number): Promise<PtySpawnResult> {
  return invoke<PtySpawnResult>("pty_spawn_tmux", { sessionName, cols, rows });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

// Environment detection

export async function detectWslDistros(): Promise<string[]> {
  return invoke<string[]>("detect_wsl_distros");
}

// Project — last project persistence

export async function projectGetLast(): Promise<string | null> {
  return invoke<string | null>("project_get_last");
}

export async function projectSetLast(id: string): Promise<void> {
  return invoke("project_set_last", { id });
}

// Project — CRUD

export async function projectList(): Promise<ProjectConfig[]> {
  return invoke<ProjectConfig[]>("project_list");
}

export async function projectGet(id: string): Promise<ProjectConfig> {
  return invoke<ProjectConfig>("project_get", { id });
}

export async function projectCreate(config: ProjectConfig): Promise<ProjectConfig> {
  return invoke<ProjectConfig>("project_create", { config });
}

export async function projectUpdate(config: ProjectConfig): Promise<void> {
  return invoke("project_update", { config });
}

export async function projectDelete(id: string): Promise<void> {
  return invoke("project_delete", { id });
}

// Filesystem

export interface FsEntry {
  name: string;
  isDir: boolean;
}

export async function fsListDir(shell: ShellType, path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("fs_list_dir", { shell, path });
}

export async function fsReadFile(shell: ShellType, path: string): Promise<string> {
  return invoke<string>("fs_read_file", { shell, path });
}

export async function fsWriteFile(shell: ShellType, path: string, content: string): Promise<void> {
  return invoke("fs_write_file", { shell, path, content });
}

// Git

export async function gitStatus(root: string, shell: ShellType): Promise<GitStatusResult> {
  return invoke<GitStatusResult>("git_status", { root, shell });
}

export async function gitLog(root: string, shell: ShellType, count?: number): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>("git_log", { root, shell, count: count ?? null });
}

export async function gitDiff(root: string, shell: ShellType, path: string, staged: boolean): Promise<string> {
  return invoke<string>("git_diff", { root, shell, path, staged });
}

export async function gitStage(root: string, shell: ShellType, paths: string[]): Promise<void> {
  return invoke("git_stage", { root, shell, paths });
}

export async function gitUnstage(root: string, shell: ShellType, paths: string[]): Promise<void> {
  return invoke("git_unstage", { root, shell, paths });
}

export async function gitCommit(root: string, shell: ShellType, message: string): Promise<void> {
  return invoke("git_commit", { root, shell, message });
}

export async function gitBranchList(root: string, shell: ShellType): Promise<string[]> {
  return invoke<string[]>("git_branch_list", { root, shell });
}

export async function gitCheckout(root: string, shell: ShellType, branch: string): Promise<void> {
  return invoke("git_checkout", { root, shell, branch });
}

export async function gitPush(root: string, shell: ShellType): Promise<string> {
  return invoke<string>("git_push", { root, shell });
}

export async function gitPull(root: string, shell: ShellType): Promise<string> {
  return invoke<string>("git_pull", { root, shell });
}

export async function gitShowFiles(root: string, shell: ShellType, hash: string): Promise<GitFileChange[]> {
  return invoke<GitFileChange[]>("git_show_files", { root, shell, hash });
}

export async function gitDiffCommit(root: string, shell: ShellType, hash: string, path: string): Promise<string> {
  return invoke<string>("git_diff_commit", { root, shell, hash, path });
}
