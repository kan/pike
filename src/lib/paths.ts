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
