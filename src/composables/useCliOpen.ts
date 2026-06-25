import { getCurrentWindow } from '@tauri-apps/api/window'
import { type CliAction, cliGetInitialAction } from '../lib/tauri'
import { useTabStore } from '../stores/tabs'

let initialized = false

/**
 * Handle a CLI action in the current window.
 * Routing (which window to target) is handled on the Rust side;
 * the frontend simply opens the requested tab.
 */
function handleActionLocal(action: CliAction) {
  if (action.action === 'none') return

  const tabStore = useTabStore()

  if (action.action === 'openFile') {
    tabStore.addEditorTab({ path: action.path, initialLine: action.line ?? undefined })
  } else if (action.action === 'openDirectory') {
    tabStore.addTerminalTab({ cwd: action.path })
  }
}

/**
 * Fetch and cache the pending CLI action for this window.
 * The action is consumed from the Rust side on first call; the cached
 * value is reused by initCliOpen to avoid a redundant IPC roundtrip.
 */
export async function hasPendingCliAction(): Promise<boolean> {
  const initial = await cliGetInitialAction()
  cachedInitial = initial
  return initial.action !== 'none'
}

let cachedInitial: CliAction | null = null

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
    handleActionLocal(initial)
  }
}
