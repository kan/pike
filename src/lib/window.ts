import { getCurrentWindow } from '@tauri-apps/api/window'
import { ref } from 'vue'

const PROJECT_WINDOW_PREFIX = 'project-'
/** Label of the current window (e.g. 'main', 'project-<id>', 'global-<n>'). */
export const windowLabel = getCurrentWindow().label

export function getWindowProjectId(): string | null {
  if (!windowLabel.startsWith(PROJECT_WINDOW_PREFIX)) return null
  // A window built while `project-{id}` was taken carries a unique
  // `project-{id}:{uuid}` label (see focus_or_build_project_window). Project ids
  // are slugs ([a-zA-Z0-9_-]), so `:` only ever separates the uuid suffix.
  const rest = windowLabel.slice(PROJECT_WINDOW_PREFIX.length)
  const sep = rest.indexOf(':')
  return sep === -1 ? rest : rest.slice(0, sep)
}

/**
 * WebView のカラースキーム（`prefers-color-scheme`）を app のテーマに追従させる。
 * Windows では Tauri の `set_theme` が WebView2 の PreferredColorScheme を設定するため、
 * これでマニュアルプレビューの `<picture>` 等が OS ではなく Pike のテーマに従う。
 * null でシステム追従（既定）に戻す。失敗は無害（機能低下のみ）。
 */
export async function setWebviewTheme(theme: 'light' | 'dark' | null): Promise<void> {
  try {
    await getCurrentWindow().setTheme(theme)
  } catch (e) {
    console.error('[window] setTheme failed:', e)
  }
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

/** Whether this Pike process runs elevated (Windows administrator). Static per
 *  process; App.vue resolves it once at startup via `is_elevated`. Drives the
 *  admin indicator (status bar shield, window title). */
export const elevated = ref(false)

/** Transient window whose session must not be persisted. Set for the elevated
 *  admin project window (#138): it runs in a separate process sharing the same
 *  project config, so saving its lean single-terminal session would clobber the
 *  real session written by the non-elevated instance. */
export const ephemeralWindow = ref(false)
