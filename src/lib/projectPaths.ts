/**
 * Translation between a machine's real project roots and the base-relative
 * paths shared through the sync file (#164). Only the part below the base is
 * portable: every machine keeps its own base, so `oss/pike` resolves to
 * `C:\Users\kanfu\src\oss\pike` here and `/home/kan/src/oss/pike` there.
 */

import { joinPath, normalizeSep } from './paths'

/**
 * プロジェクトのプラットフォーム。**一覧はこの配列が単一の出典**で、型も実行時の
 * 検証（`isProjectPlatform`）もここから導く。
 *
 * 以前は型の union と `stores/project.ts` の同期 allowlist が別々に書かれていて、
 * 「増やしたらこちらにも足すこと」というコメントだけが結び付けていた。忘れると
 * **知らない platform のエントリが同期ファイルから消える**（push は allowlist を
 * 通した結果を全量書き戻すので、別のマシンが書いたものを消す）。配列から導けば
 * 足し忘れが型エラーになる。
 *
 * `unix` は macOS / Linux ホストのローカルなプロジェクト。パスの扱いは `wsl` と
 * 同じ POSIX（`/` 区切り・大小を区別）だが、**同期のベースは別枠**にする: 同じ
 * マシンに WSL と macOS が同居することはなく、`wsl` の base を流用すると
 * 「distro のホームを指す設定」が macOS 側に見えてしまう。
 */
export const PROJECT_PLATFORMS = ['wsl', 'windows', 'unix'] as const

export type ProjectPlatform = (typeof PROJECT_PLATFORMS)[number]

/** 実行時の検証。同期ファイル・localStorage など信頼できない入力の入口で使う。 */
export function isProjectPlatform(v: unknown): v is ProjectPlatform {
  return PROJECT_PLATFORMS.includes(v as ProjectPlatform)
}

/** POSIX 規約（`/` 区切り・大小を区別）で扱うプラットフォームか。 */
export function isPosixPlatform(platform: ProjectPlatform): boolean {
  return platform === 'wsl' || platform === 'unix'
}

/** Machine-local base directory per platform. Never synced or broadcast. */
export interface ProjectBase {
  /** Windows-side base, e.g. `C:\Users\me\src`. */
  windows: string
  /** WSL-side base as a native path, e.g. `/home/me/src`. */
  wsl: string
  /** Distro the WSL base lives in — projects created from sync use this shell. */
  wslDistro: string
  /** macOS / Linux ホストの base, e.g. `/Users/me/src`. */
  unix: string
}

export function emptyProjectBase(): ProjectBase {
  return { windows: '', wsl: '', wslDistro: '', unix: '' }
}

export function baseForPlatform(base: ProjectBase, platform: ProjectPlatform): string {
  if (platform === 'wsl') return base.wsl
  if (platform === 'unix') return base.unix
  return base.windows
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
  const [a, b] = isPosixPlatform(platform)
    ? [normalizedBase, normalizedRoot]
    : [normalizedBase.toLowerCase(), normalizedRoot.toLowerCase()]
  if (!b.startsWith(`${a}/`)) return null
  return normalizedRoot.slice(normalizedBase.length + 1)
}

/**
 * A comparison key for "do these two roots name the same directory". Separators
 * are normalized and a trailing one dropped, so a root typed as `C:\src\pike`
 * matches the `C:/src/pike` that `joinBase` produces.
 *
 * Deliberately case-insensitive on both platforms, unlike `relativeToBase`:
 * this answers whether the user already registered a directory, and two WSL
 * paths differing only in case are not worth telling apart for that.
 */
export function rootKey(root: string): string {
  return normalizeSep(root).replace(/\/+$/, '').toLowerCase()
}

/** Inverse of `relativeToBase`: an absolute root in this machine's layout. */
export function joinBase(base: string, rel: string, platform: ProjectPlatform): string {
  return joinPath(base, rel, platformSep(platform))
}

/** `pathSep` のプラットフォーム版。区切りの規則はこの 2 つに閉じる。 */
/*  export しないのは、`paths.ts` の `pathSep` と並ぶ「区切りの出典」を 2 つに
 *  増やさないため（呼び出しは同ファイルの `joinBase` だけ）。 */
function platformSep(platform: ProjectPlatform): '/' | '\\' {
  return isPosixPlatform(platform) ? '/' : '\\'
}
