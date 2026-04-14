import { pathSep } from '../lib/paths'
import { fsWriteFileBase64 } from '../lib/tauri'
import { useProjectStore } from '../stores/project'

const UPLOADS_DIR = '.pike/uploads'
const MAX_SIZE = 10 * 1024 * 1024 // 10 MB

function generateFilename(ext: string): string {
  const ts = Date.now()
  const hex = Math.random().toString(16).slice(2, 6)
  return `img-${ts}-${hex}.${ext}`
}

function extFromMime(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('bmp')) return 'bmp'
  return 'png'
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

/** Extract image files from a ClipboardEvent. Returns empty array if none. */
export function getClipboardImages(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items
  if (!items) return []
  const files: File[] = []
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  return files
}

/** Save an image file to .pike/uploads/ and return the relative path. */
export async function saveImageFile(file: File): Promise<string> {
  const project = useProjectStore().currentProject
  if (!project) throw new Error('No active project')
  if (file.size > MAX_SIZE) throw new Error(`Image too large (${Math.round(file.size / 1024 / 1024)}MB, max 10MB)`)

  const sep = pathSep(project.shell)
  const ext = extFromMime(file.type)
  const filename = generateFilename(ext)
  const uploadDir = `${project.root}${sep}${UPLOADS_DIR.replaceAll('/', sep)}`
  const fullPath = `${uploadDir}${sep}${filename}`

  const base64 = await fileToBase64(file)
  await fsWriteFileBase64(project.shell, fullPath, base64)

  return `${UPLOADS_DIR.replaceAll('/', sep)}${sep}${filename}`
}
