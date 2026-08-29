import { pathSep } from '../lib/paths'
import { ensurePikeDir } from '../lib/pikeDir'
import { fsWriteFileBase64 } from '../lib/tauri'
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'
import type { ShellType } from '../types/tab'

const UPLOADS_DIR = '.pike/uploads'
/** Max upload size. Keep in sync with Rust `MAX_UPLOAD_SIZE` in fs/mod.rs. */
export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50 MB

/** Thrown by saveUploadFile when a file exceeds MAX_UPLOAD_SIZE, so callers can
 * show a localized "too large" message without re-checking the threshold. */
export class UploadTooLargeError extends Error {
  constructor(readonly fileSize: number) {
    super(`File too large (${toMb(fileSize)}MB, max ${toMb(MAX_UPLOAD_SIZE)}MB)`)
    this.name = 'UploadTooLargeError'
  }
}

/** Human-readable MB, rounded, for size messages. */
export function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

function rand4(): string {
  return Math.random().toString(16).slice(2, 6)
}

// Monotonic per-session counter folded into every filename so two concurrent
// uploads of identically named files can never resolve to the same path (rand4
// alone is only 16 bits). The increment is synchronous, so even parallel
// saveUploadFile calls get distinct ids.
let uploadSeq = 0
function uniqueId(): string {
  uploadSeq += 1
  return `${uploadSeq.toString(36)}${rand4()}`
}

function extFromMime(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('bmp')) return 'bmp'
  if (mime.includes('svg')) return 'svg'
  if (mime.includes('pdf')) return 'pdf'
  if (mime.includes('json')) return 'json'
  if (mime.includes('plain')) return 'txt'
  return 'bin'
}

// File.name is generic ("image.png", "blob", "clipboard") for clipboard blobs
// that never had a real on-disk name. Treat those as nameless and synthesize.
export function isGenericName(name: string): boolean {
  const stem = name.replace(/\.[^.]*$/, '').toLowerCase()
  return stem === '' || stem === 'image' || stem === 'blob' || stem === 'clipboard'
}

function sanitize(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_')
}

/**
 * `stem-hex.ext`, so a second file of the same name can sit in the same
 * directory without replacing the first. `fallbackExt` covers names with no
 * extension of their own.
 */
export function uniqueFilename(name: string, fallbackExt: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot + 1) : fallbackExt
  return `${sanitize(stem)}-${uniqueId()}.${sanitize(ext)}`
}

/**
 * Build the stored filename. Real files keep their original name; nameless
 * clipboard blobs get a generated one from the MIME type.
 */
export function buildFilename(file: File): string {
  if (file.name && !isGenericName(file.name)) return uniqueFilename(file.name, extFromMime(file.type))
  return `upload-${Date.now()}-${uniqueId()}.${extFromMime(file.type)}`
}

/** base64-encode a small byte buffer (avoids a second full read of the File). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Read a File's bytes as base64 (no data-URL prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      // Strip "data:...;base64," prefix
      resolve(result.split(',')[1])
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

/** Extract file items from a ClipboardEvent. Returns empty array if none. */
export function getClipboardFiles(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items
  if (!items) return []
  const files: File[] = []
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  return files
}

/**
 * Async Clipboard API 経由で現在のクリップボード上の画像を取得。
 * Ctrl+V を keydown で食う xterm 経由の paste 等、ClipboardEvent が
 * 取れない経路でも使える。permission denied / 画像なしは空配列を返す。
 * NOTE: この API は画像とテキストしか返さず、任意のファイルは取得できない
 * （ブラウザ仕様）。ターミナルへの任意ファイル投入は D&D を主経路とする。
 */
export async function readClipboardImages(): Promise<File[]> {
  try {
    const items = await navigator.clipboard.read()
    const files: File[] = []
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'))
      if (imageType) {
        const blob = await item.getType(imageType)
        files.push(new File([blob], 'clipboard', { type: imageType }))
      }
    }
    return files
  } catch {
    return []
  }
}

/**
 * Write `file` into `dir` under a collision-proof name, and return that name.
 * Throws UploadTooLargeError past MAX_UPLOAD_SIZE. When `bytes` is supplied
 * (already read by the caller, e.g. tryInlineFile) it is reused to avoid a
 * second full read of the File.
 *
 * The size cap is the reason to come through here rather than calling
 * `fsWriteFileBase64` directly: the bytes cross the IPC bridge as a base64
 * string, so an unbounded file is not merely slow.
 */
export async function saveFileTo(file: File, shell: ShellType, dir: string, bytes?: Uint8Array): Promise<string> {
  if (file.size > MAX_UPLOAD_SIZE) throw new UploadTooLargeError(file.size)
  const filename = buildFilename(file)
  const base64 = bytes ? bytesToBase64(bytes) : await fileToBase64(file)
  await fsWriteFileBase64(shell, `${dir}${pathSep(shell)}${filename}`, base64)
  return filename
}

/**
 * Save any file to `<root>/.pike/uploads/` and return the path relative to
 * `root` — what a chat mention or a terminal drop pastes in.
 *
 * **`root` は受け手が相対パスを解決する場所を渡すこと**（#269）。エージェントなら
 * セッションの cwd、ターミナルならそのタブを開いた cwd で、どちらもタブの生成時に
 * 固まる。ここで `activeRoot` を読むと、worktree を切り替えたあとに古いタブへ貼った
 * ファイルが、そのタブからは見えない場所に置かれる。
 */
export async function saveUploadFile(file: File, root: string, bytes?: Uint8Array): Promise<string> {
  const project = useProjectStore().currentProject
  if (!project) throw new Error('No active project')
  const sep = pathSep(project.shell)
  const uploadDir = await ensurePikeDir(project.shell, root, 'uploads')
  const filename = await saveFileTo(file, project.shell, uploadDir, bytes)
  return `${UPLOADS_DIR.replaceAll('/', sep)}${sep}${filename}`
}

/** Heuristic: does this byte buffer look like UTF-8 text (vs binary)? */
function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false // invalid UTF-8 → binary
  }
  let control = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0) return false // NUL → binary
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++
  }
  return control / bytes.length < 0.1
}

/**
 * Probe a small file for inline expansion. Returns:
 *  - `null`  → not probed (feature off, empty, or larger than the inline
 *              threshold) → caller should upload via saveUploadFile(file).
 *  - `{ text, bytes }` → file was read. `text` is the decoded content when it
 *              looks like UTF-8 text (inline it), or `null` for binary (caller
 *              should upload, passing `bytes` back to avoid a second read).
 */
export async function tryInlineFile(file: File): Promise<{ text: string | null; bytes: Uint8Array } | null> {
  const settings = useSettingsStore()
  if (!settings.inlineSmallTextFiles) return null
  // Empty files have no content to inline — upload them so a path is still produced.
  if (file.size === 0) return null
  if (file.size > settings.inlineSmallTextThreshold) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  const text = isProbablyText(bytes) ? new TextDecoder('utf-8', { fatal: false }).decode(bytes) : null
  return { text, bytes }
}
