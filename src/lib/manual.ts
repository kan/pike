/**
 * In-app user manual viewer backed by the GitHub-hosted Markdown
 * (`docs/manual/`). No bundling: pages are fetched from raw.githubusercontent
 * (CORS `*`) and images are loaded directly via their raw URLs.
 */

const RAW_BASE = 'https://raw.githubusercontent.com/kan/pike/main/'

/** Repo-relative directory holding the manual pages. */
export const MANUAL_DIR = 'docs/manual/'

/** Repo-relative path of the manual index page. */
export const MANUAL_INDEX = `${MANUAL_DIR}README.md`

/** Build a manual deep-link target from a manual-relative `page#anchor`. */
export function manualTarget(rel: string): string {
  return MANUAL_DIR + rel
}

/** Resolve a relative link/image `href` against the current page's directory,
 *  returning a normalized repo-relative path (e.g. `docs/manual/img/x.png`).
 *  The result is confined to `MANUAL_DIR`: a `../`-laden href can't escape into
 *  the rest of the repo (the fetch target is a fixed GitHub repo, so escaping
 *  would still pull arbitrary repo files). Out-of-bounds hrefs clamp to the
 *  manual root. */
export function resolveManualPath(page: string, href: string): string {
  const dir = page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : ''
  const out: string[] = []
  for (const part of `${dir}/${href}`.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  const resolved = out.join('/')
  if (resolved === MANUAL_DIR.replace(/\/$/, '') || resolved.startsWith(MANUAL_DIR)) {
    return resolved
  }
  // Escaped the manual tree — keep only the final segment under the manual root.
  return MANUAL_DIR + (out[out.length - 1] ?? '')
}

export function manualRawUrl(page: string): string {
  return RAW_BASE + page
}

export function isMarkdownPage(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

const cache = new Map<string, string>()

/** Fetch a manual page's Markdown (memoized for the session). Pass `force` to
 *  bypass and refresh the cache (e.g. the reload button). */
export async function fetchManual(page: string, force = false): Promise<string> {
  if (!force) {
    const cached = cache.get(page)
    if (cached !== undefined) return cached
  }
  const res = await fetch(manualRawUrl(page))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  cache.set(page, text)
  return text
}
