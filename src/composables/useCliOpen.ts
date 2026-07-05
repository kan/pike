import { getCurrentWindow } from '@tauri-apps/api/window'
import { extension, isImageFile, mimeType } from '../lib/paths'
import { type CliAction, type CliFileTarget, cliGetInitialAction, fsReadFileBase64 } from '../lib/tauri'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'
import type { ShellType } from '../types/tab'

let initialized = false

/**
 * Path the tab should use for a CLI file target. In a project-less (global)
 * window file I/O runs on the Windows side, so WSL-native paths are rebuilt
 * as UNC (\\wsl.localhost\<distro>\...). Project windows keep the native
 * form — their shell config handles it.
 *
 * Must stay in sync with `wait_tab_path` in src-tauri/src/lib.rs, which
 * registers --wait files under the same form for close-signal matching.
 */
function tabPathFor(file: CliFileTarget): string {
  if (file.distro && !useProjectStore().currentProject) {
    return `\\\\wsl.localhost\\${file.distro}${file.path.replace(/\//g, '\\')}`
  }
  return file.path
}

/** Open one CLI file target in the tab kind matching its extension. */
async function openFileTarget(file: CliFileTarget) {
  const tabStore = useTabStore()
  const path = tabPathFor(file)
  if (isImageFile(path)) {
    const shell: ShellType = useProjectStore().currentProject?.shell ?? { kind: 'powershell' }
    try {
      const base64 = await fsReadFileBase64(shell, path)
      tabStore.addPreviewTab({ path, dataUrl: `data:${mimeType(path)};base64,${base64}` })
      return
    } catch {
      // Unreadable image — fall through to the editor, which reports the error
    }
  }
  if (extension(path) === 'pdf') {
    tabStore.addPdfTab({ path })
    return
  }
  tabStore.addEditorTab({ path, initialLine: file.line ?? undefined })
}

/**
 * Handle a CLI action in the current window.
 * Routing (which window to target) is handled on the Rust side;
 * the frontend simply opens the requested tabs.
 */
async function handleActionLocal(action: CliAction) {
  if (action.action === 'none') return

  const tabStore = useTabStore()

  if (action.action === 'openFiles') {
    // Sequential await keeps the tab order matching the argument order
    for (const file of action.files) {
      await openFileTarget(file)
    }
  } else if (action.action === 'openDirectory') {
    tabStore.addTerminalTab({ cwd: action.path })
  } else if (action.action === 'openTerminal') {
    tabStore.addTerminalTab({ cwd: action.cwd ?? undefined, shell: action.shell })
  }
}

let cachedInitial: CliAction | null = null

/**
 * Fetch and cache the pending CLI action for this window.
 * The action is consumed from the Rust side on first call; the cached
 * value is reused by initCliOpen to avoid a redundant IPC roundtrip.
 * App.vue uses the result to decide between project restore and global mode.
 */
export async function peekInitialCliAction(): Promise<CliAction> {
  cachedInitial ??= await cliGetInitialAction()
  return cachedInitial
}

export async function initCliOpen() {
  if (initialized) return
  initialized = true

  // Scope to THIS window: the Rust side targets a specific window via
  // `emit_to(label)`. The global `listen` (target `Any`) would fire in every
  // window, so opening an external file from one terminal made all other
  // windows try (and fail) to open it too.
  await getCurrentWindow().listen<CliAction>('cli_open', (event) => {
    handleActionLocal(event.payload)
  })

  const initial = cachedInitial ?? (await cliGetInitialAction())
  cachedInitial = null
  if (initial.action !== 'none') {
    await handleActionLocal(initial)
  }
}
