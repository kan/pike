import { t } from '../i18n'
import type { ShellType } from '../types/tab'

export function pathSep(shell?: ShellType): '/' | '\\' {
  return shell?.kind === 'wsl' ? '/' : '\\'
}

/** Rewrite every separator in `path` to `sep` (mixed `/` and `\` are unified). */
export function normalizeSep(path: string, sep: '/' | '\\' = '/'): string {
  return sep === '\\' ? path.replace(/\//g, '\\') : path.replace(/\\/g, '/')
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Z]:\\/i.test(path) || path.startsWith('\\\\')
}

export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/** Drop the last path segment. Returns the directory portion (no trailing separator). */
export function dirname(path: string): string {
  const idx = path.search(/[/\\][^/\\]*$/)
  if (idx <= 0) return path
  return path.slice(0, idx)
}

/**
 * Resolve a relative path against a base directory using the given separator.
 * Collapses `.` / `..` segments. Mixed `/` and `\` are normalized to `sep`.
 */
export function joinPath(baseDir: string, rel: string, sep: '/' | '\\' = '/'): string {
  const base = normalizeSep(baseDir, sep)
  const r = normalizeSep(rel, sep)
  const baseParts = base.split(sep).filter((p, i) => p.length > 0 || i === 0)
  const relParts = r.split(sep)
  for (const part of relParts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (baseParts.length > 1) baseParts.pop()
    } else {
      baseParts.push(part)
    }
  }
  // Preserve leading `\\` on UNC paths (basically a no-op via the filter above)
  return baseParts.join(sep)
}

/** File name without its extension. */
export function stem(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
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

/** Every format a document can show; also what a file dialog offers. */
export const EMBEDDABLE_IMAGE_EXTS: readonly string[] = [...IMAGE_EXTS, 'svg']

/**
 * Is this a file to read as Markdown? `.markdown` is the same thing spelled
 * out, and forgetting it in one place while honouring it in another is how the
 * toolbar came to appear on files the Markdown language never loaded for.
 */
export function isMarkdownPath(path: string): boolean {
  const ext = extension(path)
  return ext === 'md' || ext === 'markdown'
}

/**
 * Formats an `<img>` can render, for documents that embed a picture.
 *
 * Wider than {@link isImageFile}, which routes a path to a tab kind: `.svg`
 * opens in the editor (it has its own sanitized preview there), but a Markdown
 * file pointing at one still means "show this picture". Embedding is safe
 * regardless: an SVG inside `<img>` runs no script and fetches nothing.
 */
export function isEmbeddableImage(path: string): boolean {
  return EMBEDDABLE_IMAGE_EXTS.includes(extension(path))
}

/**
 * A `\\wsl.localhost\Ubuntu\home\x` UNC path (or the older `\\wsl$\…`) split
 * into the distro and the path as that distro sees it, or null when it is not
 * one.
 *
 * The file dialogs are Windows dialogs, so a file picked out of a WSL project
 * comes back in the only form Windows can name it by.
 */
export function wslUncToNative(path: string): { distro: string; path: string } | null {
  const m = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\?(.*)$/.exec(path)
  if (!m) return null
  return { distro: m[1], path: `/${m[2].replace(/\\/g, '/')}` }
}

/** The inverse: the name Windows knows a WSL file by. */
export function wslNativeToUnc(distro: string, path: string): string {
  return `\\\\wsl.localhost\\${distro}${normalizeSep(path, '\\')}`
}

/**
 * `target` as seen from `fromDir`, `../` segments included.
 *
 * Unlike {@link toRelativePath}, which only strips a prefix, this one can climb
 * out of the directory — what a link from `docs/manual/x.md` to `docs/img/a.png`
 * needs. Returns null when the two share no directory at all (different drives,
 * or a Windows path against a WSL one), since no relative path joins those.
 */
export function relativeFromDir(fromDir: string, target: string, sep: '/' | '\\'): string | null {
  const split = (p: string) => p.replace(/[/\\]+$/, '').split(/[/\\]/)
  const fold = (s: string) => (sep === '\\' ? s.toLowerCase() : s)
  const from = split(fromDir)
  const to = split(target)
  let common = 0
  while (common < from.length && common < to.length && fold(from[common]) === fold(to[common])) common++
  if (common === 0) return null
  const up = Array(from.length - common).fill('..')
  return [...up, ...to.slice(common)].join('/')
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
  return relativeTime(new Date(iso).getTime())
}

/** Same as {@link relativeDate} for a timestamp already in epoch ms. */
export function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return t('time.justNow')
  if (mins < 60) return t('time.minutesAgo', { n: String(mins) })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('time.hoursAgo', { n: String(hours) })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('time.daysAgo', { n: String(days) })
  return new Date(epochMs).toLocaleDateString()
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

// Porcelain v2 XY codes for unmerged (conflict) paths.
const CONFLICT_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export function gitStatusColor(status: string): string {
  if (CONFLICT_STATUSES.has(status)) return 'var(--danger)'
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
