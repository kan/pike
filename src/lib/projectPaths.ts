/**
 * Translation between a machine's real project roots and the base-relative
 * paths shared through the sync file (#164). Only the part below the base is
 * portable: every machine keeps its own base, so `oss/pike` resolves to
 * `C:\Users\kanfu\src\oss\pike` here and `/home/kan/src/oss/pike` there.
 */

import { joinPath, normalizeSep } from './paths'

export type ProjectPlatform = 'wsl' | 'windows'

/** Machine-local base directory per platform. Never synced or broadcast. */
export interface ProjectBase {
  /** Windows-side base, e.g. `C:\Users\me\src`. */
  windows: string
  /** WSL-side base as a native path, e.g. `/home/me/src`. */
  wsl: string
  /** Distro the WSL base lives in — projects created from sync use this shell. */
  wslDistro: string
}

export function emptyProjectBase(): ProjectBase {
  return { windows: '', wsl: '', wslDistro: '' }
}

export function baseForPlatform(base: ProjectBase, platform: ProjectPlatform): string {
  return platform === 'wsl' ? base.wsl : base.windows
}

/**
 * `root` expressed relative to `base` with forward slashes, or null when it is
 * not strictly below the base (the un-syncable case: the project stays local).
 * Windows paths compare case-insensitively, WSL paths do not.
 */
export function relativeToBase(base: string, root: string, platform: ProjectPlatform): string | null {
  if (!base || !root) return null
  const normalizedBase = normalizeSep(base).replace(/\/+$/, '')
  const normalizedRoot = normalizeSep(root).replace(/\/+$/, '')
  const [a, b] =
    platform === 'windows'
      ? [normalizedBase.toLowerCase(), normalizedRoot.toLowerCase()]
      : [normalizedBase, normalizedRoot]
  if (!b.startsWith(`${a}/`)) return null
  return normalizedRoot.slice(normalizedBase.length + 1)
}

/** Inverse of `relativeToBase`: an absolute root in this machine's layout. */
export function joinBase(base: string, rel: string, platform: ProjectPlatform): string {
  return joinPath(base, rel, platform === 'wsl' ? '/' : '\\')
}
