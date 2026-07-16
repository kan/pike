/**
 * In-app user manual viewer backed by the GitHub-hosted Markdown
 * (`docs/manual/`). No bundling: pages are fetched from raw.githubusercontent
 * (CORS `*`) and images are loaded directly via their raw URLs.
 *
 * Version pinning: releases are tagged `vX.Y.Z`, so we serve the manual from
 * the tag matching the running app (`getVersion()`) — keeping docs in step with
 * the installed build. Dev/unreleased versions have no tag, so we fall back to
 * `main`. The resolved ref is fixed for the session so a page and its images
 * never come from different refs.
 */
import { getVersion } from '@tauri-apps/api/app'

const REPO_BASE = 'https://raw.githubusercontent.com/kan/pike/'
const DEFAULT_REF = 'main'

/** The git ref the manual is currently served from (resolved lazily). */
let activeRef = DEFAULT_REF
let refPromise: Promise<string> | null = null

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

/** Build a raw URL for a repo-relative `page`, using the session's resolved
 *  ref. Synchronous by design (called during Markdown render for images and
 *  links); callers await `fetchManual` first, which resolves the ref. */
export function manualRawUrl(page: string): string {
  return `${REPO_BASE}${activeRef}/${page}`
}

/** Resolve the manual ref once per session: the app-version tag if the manual
 *  exists there, else `main`. Memoized. On success the index page is primed
 *  into the cache so the probe doesn't cost an extra fetch. */
function resolveRef(): Promise<string> {
  if (refPromise) return refPromise
  refPromise = (async () => {
    let version: string
    try {
      version = await getVersion()
    } catch {
      return DEFAULT_REF
    }
    const tag = `v${version}`
    try {
      const res = await fetch(`${REPO_BASE}${tag}/${MANUAL_INDEX}`)
      if (res.ok) {
        cache.set(MANUAL_INDEX, await res.text())
        activeRef = tag
        return tag
      }
    } catch {
      // network error / offline — fall back to main
    }
    return DEFAULT_REF
  })()
  return refPromise
}

export function isMarkdownPage(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

/** The git ref (version tag or `main`) the manual is being served from,
 *  resolving it first if needed. */
export function getManualRef(): Promise<string> {
  return resolveRef()
}

const cache = new Map<string, string>()

/** Fetch a manual page's Markdown (memoized for the session). Pass `force` to
 *  bypass and refresh the cache (e.g. the reload button). */
export async function fetchManual(page: string, force = false): Promise<string> {
  // Resolve the version ref first so this fetch and later image/link URLs
  // (via the synchronous manualRawUrl) all share the same ref.
  await resolveRef()
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
