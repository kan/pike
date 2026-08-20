/**
 * External images in the Markdown preview (#239).
 *
 * A README badge lives on a third-party host, so rendering it means talking to
 * a server the user never chose to visit — a tracking pixel is the same markup.
 * The webview's CSP blocks remote images outright, which is what keeps the
 * agent chat, the SVG preview and the manual from reaching out; the preview
 * therefore does not try to load them in the page. For a host the user
 * approved it asks the backend for the bytes and inlines them as a `data:`
 * URL, the same shape local images already take.
 *
 * That leaves the CSP as the thing that actually blocks, and this module as
 * presentation: a missed spot shows a broken image, never a silent request.
 */

import { remoteImageFetch } from './tauri'

/**
 * Host of an image URL, lowercased, or null when the preview cannot offer it:
 * relative paths (read from disk instead), `data:`, and plain `http:` — the
 * backend refuses those, so there is nothing to approve.
 */
export function imageHostOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Fetched images, keyed by URL, shared across tabs. The preview is rebuilt on
 * every debounced edit, so without this a badge would be re-fetched on every
 * keystroke burst. A failure is cached too — otherwise a dead URL is retried
 * just as often — and cleared by `retryRemoteImage` when the user asks again.
 */
const cache = new Map<string, string | null>()
const CACHE_MAX = 100

/** The image as a `data:` URL, or null if it could not be fetched. */
export async function remoteImageDataUrl(url: string): Promise<string | null> {
  const hit = cache.get(url)
  if (hit !== undefined) return hit
  let dataUrl: string | null = null
  try {
    const img = await remoteImageFetch(url)
    dataUrl = `data:${img.mime};base64,${img.base64}`
  } catch {
    dataUrl = null
  }
  // Map preserves insertion order → the oldest entry is the first key.
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(url, dataUrl)
  return dataUrl
}

/** Forget a cached failure so the next pass fetches the image again. */
export function retryRemoteImage(url: string) {
  if (cache.get(url) === null) cache.delete(url)
}
