import type { ShellType } from '../types/tab'

export function pathSep(shell?: ShellType): string {
  return shell?.kind === 'wsl' ? '/' : '\\'
}

export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

export function extension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp'])

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(extension(path))
}

export function mimeType(path: string): string {
  const ext = extension(path)
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
    case 'ico':
      return 'image/x-icon'
    case 'bmp':
      return 'image/bmp'
    default:
      return 'application/octet-stream'
  }
}

export function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/** Case-insensitive fuzzy match: checks if all characters of `pattern` appear in order in `text`. */
export function fuzzyMatch(text: string, pattern: string): boolean {
  const lowerText = text.toLowerCase()
  const lowerPattern = pattern.toLowerCase()
  let pi = 0
  for (let ti = 0; ti < lowerText.length && pi < lowerPattern.length; ti++) {
    if (lowerText[ti] === lowerPattern[pi]) pi++
  }
  return pi === lowerPattern.length
}

/** Strip a root prefix to get a relative path. */
export function toRelativePath(fullPath: string, root: string): string {
  if (root && fullPath.startsWith(root)) {
    let rel = fullPath.slice(root.length)
    if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1)
    return rel
  }
  return fullPath
}

export function gitStatusColor(status: string): string {
  switch (status) {
    case 'M':
      return 'var(--git-modify)'
    case 'A':
      return 'var(--git-add)'
    case 'D':
      return 'var(--git-delete)'
    case '?':
      return 'var(--git-untracked)'
    case 'R':
      return 'var(--accent)'
    default:
      return 'var(--git-untracked)'
  }
}
