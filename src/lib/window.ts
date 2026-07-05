import { getCurrentWindow } from '@tauri-apps/api/window'
import { ref } from 'vue'

const PROJECT_WINDOW_PREFIX = 'project-'
/** Label of the current window (e.g. 'main', 'project-<id>', 'global-<n>'). */
export const windowLabel = getCurrentWindow().label

export function getWindowProjectId(): string | null {
  return windowLabel.startsWith(PROJECT_WINDOW_PREFIX) ? windowLabel.slice(PROJECT_WINDOW_PREFIX.length) : null
}

export function isMainWindow(): boolean {
  return windowLabel === 'main'
}

/** Project-independent global-mode window (sidebar-less editor/terminal).
 *  Must match GLOBAL_PREFIX in src-tauri/src/lib.rs. */
export function isGlobalWindow(): boolean {
  return windowLabel.startsWith('global-')
}

/** Reactive global-mode flag. `global-` windows always start in it; the main
 *  window enters it on cold start with file args (App.vue sets it). UI that
 *  is project-bound (sidebar, switcher, status bar project label) hides on it. */
export const globalMode = ref(isGlobalWindow())
