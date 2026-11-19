/**
 * 今動いている Claude Code のセッションの一覧（#625）の、ストアを読まない計算。並べ方と、
 * セッションの居る場所からプロジェクトや worktree を引く規則をここに置く
 * （`tests/liveSessions.test.ts`）。
 */

import type { LiveSession, LiveStatus } from '../types/liveSession'
import { installKey, type ShellType, shellToPlatform } from '../types/tab'
import { basename, stripTrailingSep } from './paths'
import { isSameOrUnder, type ProjectPlatform, rootKey } from './projectPaths'

/**
 * グループの並び。**返答待ちが先頭**: 利用者が手を出さないと進まないものから見せる。次が
 * 稼働中（見守るもの）、最後がアイドル（今は何もしていないもの）。
 */
const LIVE_STATUS_ORDER: readonly LiveStatus[] = ['waiting', 'busy', 'idle']

/** 状態の表示名（i18n のキー）。パネルとタブが共有する。 */
export function liveStatusKey(status: LiveStatus): string {
  return `liveSessions.${status}`
}

/**
 * 状態ごとに分ける。空のグループは返さない。グループの中は**状態が変わった時刻の新しい順**
 * （返答待ちになったばかりのものが上に来る）。**並びの正本はここ**（Rust は並べない）。
 */
export function groupLiveSessions<T extends LiveSession>(
  sessions: readonly T[],
): { status: LiveStatus; sessions: T[] }[] {
  return LIVE_STATUS_ORDER.flatMap((status) => {
    const list = sessions.filter((s) => s.status === status).sort((a, b) => (b.statusSince ?? 0) - (a.statusSince ?? 0))
    return list.length > 0 ? [{ status, sessions: list }] : []
  })
}

/**
 * `path` を含む（同じか、その下にある）もののうち、**root がいちばん深いもの**。`repo` と
 * その下の `repo/packages/web` の両方が当たるなら後者。プロジェクトを引くのにも、worktree を
 * 引くのにも使う（`repo` の中に作った worktree は `repo` の下にもある）。
 */
export function deepestContaining<T>(
  items: readonly T[],
  path: string,
  rootOf: (item: T) => string,
  platformOf: (item: T) => ProjectPlatform,
): T | null {
  let best: T | null = null
  for (const item of items) {
    if (!isSameOrUnder(rootOf(item), path, platformOf(item))) continue
    if (!best || rootKey(rootOf(item)).length > rootKey(rootOf(best)).length) best = item
  }
  return best
}

/**
 * セッションの居るディレクトリ（`cwd`）を含む登録済みのプロジェクト（いちばん深いもの）。
 *
 * **同じ場所（`installKey`）のプロジェクトだけを見る**: `shell` は一覧を読んだアカウントの
 * シェルで、WSL のセッションの `/home/...` を Windows のプロジェクトと、別の distro の同じ
 * パスと取り違えない。
 */
export function projectForCwd<P extends { root: string; shell: ShellType }>(
  cwd: string,
  shell: ShellType,
  projects: readonly P[],
): P | null {
  const place = installKey(shell)
  return deepestContaining(
    projects.filter((p) => installKey(p.shell) === place),
    cwd,
    (p) => p.root,
    (p) => shellToPlatform(p.shell),
  )
}

/** 一覧に出す名前。題が無ければ Claude Code の付けた名前、それも無ければディレクトリ名。 */
export function liveSessionLabel(s: Pick<LiveSession, 'title' | 'name' | 'cwd'>): string {
  return s.title || s.name || basename(stripTrailingSep(s.cwd)) || s.cwd
}

/**
 * 押したときにどこへ移るかの説明（i18n のキー）。行き先の決め方は `stores/liveSessions.ts` の
 * `jump` が正本で、ここはその 3 段をそのまま言う。
 */
export function liveSessionJumpKey(row: { tabId: string | null; project: unknown }): string {
  if (row.tabId) return 'liveSessions.jumpTab'
  return row.project ? 'liveSessions.jumpProject' : 'liveSessions.jumpDir'
}
