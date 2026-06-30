import { getCurrentWindow } from '@tauri-apps/api/window'

const PROJECT_WINDOW_PREFIX = 'project-'
/** Label of the current window (e.g. 'main', 'project-<id>', 'secondary-<n>'). */
export const windowLabel = getCurrentWindow().label

export function getWindowProjectId(): string | null {
  return windowLabel.startsWith(PROJECT_WINDOW_PREFIX) ? windowLabel.slice(PROJECT_WINDOW_PREFIX.length) : null
}

export function isMainWindow(): boolean {
  return windowLabel === 'main'
}

export function isSecondaryWindow(): boolean {
  return windowLabel.startsWith('secondary-')
}
