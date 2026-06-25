import { pathSep } from '../lib/paths'
import { fsCreateDir, fsWriteFile, fsWriteFileBase64 } from '../lib/tauri'
import { useProjectStore } from '../stores/project'
import { useSettingsStore } from '../stores/settings'

const UPLOADS_DIR = '.pike/uploads'
/** Max upload size. Keep in sync with Rust `MAX_UPLOAD_SIZE` in fs/mod.rs. */
export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50 MB

/** Human-readable MB, rounded, for size messages. */
export function toMb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

function rand4(): string {
  return Math.random().toString(16).slice(2, 6)
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
function isGenericName(name: string): boolean {
  const stem = name.replace(/\.[^.]*$/, '').toLowerCase()
  return stem === '' || stem === 'image' || stem === 'blob' || stem === 'clipboard'
}

function sanitize(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '_')
}

/**
 * Build the stored filename. Real files keep their original name (stem-hex.ext
 * to dodge collisions); nameless clipboard blobs get a generated name from MIME.
 */
function buildFilename(file: File): string {
  if (file.name && !isGenericName(file.name)) {
    const dot = file.name.lastIndexOf('.')
    const stem = dot > 0 ? file.name.slice(0, dot) : file.name
    const ext = dot > 0 ? file.name.slice(dot + 1) : extFromMime(file.type)
    return `${sanitize(stem)}-${rand4()}.${sanitize(ext)}`
  }
  return `upload-${Date.now()}-${rand4()}.${extFromMime(file.type)}`
}

function fileToBase64(file: File): Promise<string> {
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

/** Ensure .pike/uploads/ exists and drop a .pike/.gitignore once per session. */
const gitignoreEnsured = new Set<string>()
async function ensureUploadsDir(shell: Parameters<typeof fsWriteFile>[0], root: string): Promise<string> {
  const sep = pathSep(shell)
  const pikeDir = `${root}${sep}.pike`
  const uploadDir = `${pikeDir}${sep}uploads`
  await fsCreateDir(shell, uploadDir).catch(() => {})
  if (!gitignoreEnsured.has(root)) {
    gitignoreEnsured.add(root)
    // .pike is tool-managed scratch space — keep it out of the user's repo.
    fsWriteFile(shell, `${pikeDir}${sep}.gitignore`, '*\n').catch(() => {})
  }
  return uploadDir
}

/** Save any file to .pike/uploads/ and return the relative path. */
export async function saveUploadFile(file: File): Promise<string> {
  const project = useProjectStore().currentProject
  if (!project) throw new Error('No active project')
  if (file.size > MAX_UPLOAD_SIZE)
    throw new Error(`File too large (${toMb(file.size)}MB, max ${toMb(MAX_UPLOAD_SIZE)}MB)`)

  const sep = pathSep(project.shell)
  const filename = buildFilename(file)
  const uploadDir = await ensureUploadsDir(project.shell, project.root)
  const fullPath = `${uploadDir}${sep}${filename}`

  const base64 = await fileToBase64(file)
  await fsWriteFileBase64(project.shell, fullPath, base64)

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
 * When "inline small text files" is enabled and the file is small enough and
 * looks like text, return its decoded content (to splat inline instead of
 * uploading). Otherwise return null — the caller should upload via saveUploadFile.
 */
export async function tryInlineFile(file: File): Promise<string | null> {
  const settings = useSettingsStore()
  if (!settings.inlineSmallTextFiles) return null
  if (file.size > settings.inlineSmallTextThreshold) return null
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!isProbablyText(bytes)) return null
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}
