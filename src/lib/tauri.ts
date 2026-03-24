import { invoke } from "@tauri-apps/api/core";
import type { ShellType } from "../types/tab";
import type { ProjectConfig } from "../types/project";

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
