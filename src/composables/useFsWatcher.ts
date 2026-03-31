import { ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { fsWatchStart, fsWatchStop } from "../lib/tauri";
import type { ShellType } from "../types/tab";

export interface FsChangeEntry {
  path: string;
  kind: 'create' | 'modify' | 'delete';
}

const recentlySaved = new Set<string>();

export function markRecentlySaved(path: string) {
  recentlySaved.add(path);
  setTimeout(() => recentlySaved.delete(path), 2000);
}

export function isRecentlySaved(path: string): boolean {
  return recentlySaved.has(path);
}

interface FsChangedPayload {
  watcherId: string;
  changedDirs: string[];
  changedFiles: FsChangeEntry[];
}

type DirChangeHandler = (dirs: string[]) => void;
type FileChangeHandler = (files: FsChangeEntry[]) => void;

const currentWatcherId = ref<string | null>(null);
const startError = ref<string | null>(null);
const dirHandlers: DirChangeHandler[] = [];
const fileHandlers: FileChangeHandler[] = [];

let initialized = false;

async function init() {
  if (initialized) return;
  initialized = true;

  await listen<FsChangedPayload>("fs_changed", (event) => {
    const { watcherId, changedDirs, changedFiles } = event.payload;
    if (watcherId !== currentWatcherId.value) return;
    for (const h of dirHandlers) h(changedDirs);
    for (const h of fileHandlers) h(changedFiles);
  });
}

async function start(shell: ShellType, root: string) {
  await stop();
  try {
    currentWatcherId.value = await fsWatchStart(shell, root);
    startError.value = null;
  } catch (e) {
    startError.value = String(e);
  }
}

async function stop() {
  if (currentWatcherId.value) {
    try {
      await fsWatchStop(currentWatcherId.value);
    } catch { /* ignore */ }
    currentWatcherId.value = null;
  }
}

function onDirChange(handler: DirChangeHandler) {
  dirHandlers.push(handler);
  return () => {
    const idx = dirHandlers.indexOf(handler);
    if (idx >= 0) dirHandlers.splice(idx, 1);
  };
}

function onFileChange(handler: FileChangeHandler) {
  fileHandlers.push(handler);
  return () => {
    const idx = fileHandlers.indexOf(handler);
    if (idx >= 0) fileHandlers.splice(idx, 1);
  };
}

export const fsWatcher = { init, start, stop, onDirChange, onFileChange, startError };
