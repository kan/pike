import { invoke } from "@tauri-apps/api/core";

export interface PtySpawnResult {
  id: string;
}

export async function ptySpawn(cols: number, rows: number): Promise<PtySpawnResult> {
  return invoke<PtySpawnResult>("pty_spawn", { cols, rows });
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
