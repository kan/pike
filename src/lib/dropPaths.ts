import { getCurrentWindow } from '@tauri-apps/api/window'

export interface DroppedPath {
  path: string
  isDir: boolean
}

interface DropPathsPayload {
  id: string
  entries: DroppedPath[]
}

interface WebView2Bridge {
  postMessageWithAdditionalObjects?: (message: string, objects: FileList) => void
}

/** WebView2 host bridge (window.chrome.webview). Absent outside WebView2. */
function webview2Bridge(): WebView2Bridge | undefined {
  return (window as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview
}

export function canResolveDroppedPaths(): boolean {
  return typeof webview2Bridge()?.postMessageWithAdditionalObjects === 'function'
}

/** Must match MESSAGE_PREFIX in src-tauri/src/drop_paths.rs */
const MESSAGE_PREFIX = 'pike:drop-paths:'

const RESOLVE_TIMEOUT_MS = 3000

/**
 * Resolve the real filesystem paths of OS files dropped as DOM File objects.
 *
 * Pike disables Tauri's native drag-drop (HTML5 DnD needs the DOM events), so
 * dropped Files carry no path. WebView2's postMessageWithAdditionalObjects
 * hands the File objects to the Rust side (drop_paths.rs), which answers with
 * a window-scoped `drop_paths` event carrying path + isDir per file.
 * Resolves to [] when the bridge is unavailable or the reply times out.
 */
export async function resolveDroppedPaths(files: FileList): Promise<DroppedPath[]> {
  const bridge = webview2Bridge()
  if (!bridge?.postMessageWithAdditionalObjects || files.length === 0) return []
  const id = crypto.randomUUID()
  return new Promise<DroppedPath[]>((resolve) => {
    let unlisten: (() => void) | null = null
    const finish = (entries: DroppedPath[]) => {
      clearTimeout(timer)
      unlisten?.()
      unlisten = null
      resolve(entries)
    }
    const timer = setTimeout(() => finish([]), RESOLVE_TIMEOUT_MS)
    getCurrentWindow()
      .listen<DropPathsPayload>('drop_paths', (event) => {
        if (event.payload.id !== id) return
        finish(event.payload.entries)
      })
      .then((fn) => {
        // Register the listener before posting so the reply can't race it.
        unlisten = fn
        bridge.postMessageWithAdditionalObjects?.(`${MESSAGE_PREFIX}${id}`, files)
      })
      .catch(() => finish([]))
  })
}
