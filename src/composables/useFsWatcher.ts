import { listen } from '@tauri-apps/api/event'
import { ref } from 'vue'
import { normalizeSep } from '../lib/paths'
import { fsWatchStart, fsWatchStop } from '../lib/tauri'
import type { ShellType } from '../types/tab'

export interface FsChangeEntry {
  path: string
  kind: 'create' | 'modify' | 'delete'
}

const SAVE_TTL_MS = 2000

/**
 * 自分が書いたファイルの印。**通知 1 回ぶんで使い切る**（#276）。
 *
 * 以前は「保存から 2 秒のあいだの通知を全部捨てる」形で、しかも保存のたびに窓が延びた。
 * 自動保存（#262）を 2 秒より短い間隔で走らせると窓が開きっぱなしになり、**その最中に
 * エージェントが同じファイルを書いても外部変更として届かない**。届かなければ警告バーも
 * 出ず、「警告中は自動保存しない」というガードも素通りして、次の自動保存が相手の変更を
 * 黙って上書きする。
 *
 * 1 回の書き込みが生む通知は 1 回（Rust 側の `EventBuffer` がパスで畳んでから送る）なので、
 * 使い切りにすれば「自分のぶんを 1 回吸って、次からは他人のもの」になる。まとめ切れずに
 * 2 回に割れたときは、余ったほうが外部変更として出る。clean なタブなら同じ内容で読み直す
 * だけ、dirty なら消せる警告バーが 1 回出る。**黙って上書きするより、消せる誤検知を採る。**
 *
 * **`isRecentlySaved` が真を返した時点で落とす。** 判定と消費が同じ 1 回なので、
 * 「1 回ぶんで使い切る」がそのまま読める。**読む人を 2 人目にしないこと**: 同じバッチで
 * 2 つのリスナが呼ぶ形にすると、先に呼んだほうが印を食べて、後ろのリスナには自分の
 * 書き込みが他人のものとして届く（配り終えてから落とす仕組みが要る）。
 */
const selfWrites = new Map<string, number>()

export function markRecentlySaved(path: string) {
  // Keys are separator-normalized: editor tab paths can mix `/` and `\` on
  // Windows while watcher events always use `\`.
  selfWrites.set(normalizeSep(path), Date.now() + SAVE_TTL_MS)
}

export function isRecentlySaved(path: string): boolean {
  const key = normalizeSep(path)
  const expires = selfWrites.get(key)
  if (expires === undefined) return false
  selfWrites.delete(key)
  return Date.now() < expires
}

interface FsChangedPayload {
  watcherId: string
  changedDirs: string[]
  changedFiles: FsChangeEntry[]
}

type DirChangeHandler = (dirs: string[]) => void
type FileChangeHandler = (files: FsChangeEntry[]) => void

const currentWatcherId = ref<string | null>(null)
const startError = ref<string | null>(null)
const dirHandlers: DirChangeHandler[] = []
const fileHandlers: FileChangeHandler[] = []

let initialized = false

async function init() {
  if (initialized) return
  initialized = true

  await listen<FsChangedPayload>('fs_changed', (event) => {
    const { watcherId, changedDirs, changedFiles } = event.payload
    if (watcherId !== currentWatcherId.value) return
    for (const h of dirHandlers) h(changedDirs)
    for (const h of fileHandlers) h(changedFiles)
  })
}

async function start(shell: ShellType, root: string) {
  await stop()
  try {
    currentWatcherId.value = await fsWatchStart(shell, root)
    startError.value = null
  } catch (e) {
    startError.value = String(e)
  }
}

async function stop() {
  if (currentWatcherId.value) {
    try {
      await fsWatchStop(currentWatcherId.value)
    } catch {
      /* ignore */
    }
    currentWatcherId.value = null
  }
}

function onDirChange(handler: DirChangeHandler) {
  dirHandlers.push(handler)
  return () => {
    const idx = dirHandlers.indexOf(handler)
    if (idx >= 0) dirHandlers.splice(idx, 1)
  }
}

function onFileChange(handler: FileChangeHandler) {
  fileHandlers.push(handler)
  return () => {
    const idx = fileHandlers.indexOf(handler)
    if (idx >= 0) fileHandlers.splice(idx, 1)
  }
}

export const fsWatcher = { init, start, stop, onDirChange, onFileChange, startError }
