export interface GitFileChange {
  path: string
  status: string
  /**
   * リネーム / コピーの元の名前（#306）。それ以外では省かれる。
   * diff とアンステージで要る理由は `.claude/rules/git.md`。
   */
  origPath?: string
}

export interface GitStatusResult {
  branch: string
  /** Current HEAD commit oid, or "(initial)" before the first commit. */
  head: string
  isDirty: boolean
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  /** Unmerged paths (merge/rebase conflicts). `status` is the XY code (e.g. "UU"). */
  conflicted: GitFileChange[]
  ahead: number
  behind: number
  /** A rebase/merge/… git stopped in the middle of (#222); null when idle. */
  operation: GitOperation | null
}

/** A half-finished git operation, read from the state files in the gitdir. */
export interface GitOperation {
  /** Also the git subcommand `--continue` / `--abort` are appended to. */
  kind: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'am' | 'bisect'
  /** Branch being rebased — `status.branch` reports `(detached)` meanwhile. */
  branch: string | null
  /** Both set, or both null: a half-read `0/0` is worse than no progress. */
  step: number | null
  total: number | null
  stop: 'conflict' | 'commit-failed' | 'stopped'
  /** The commit a `commit-failed` rebase could not write (`git commit -C`). */
  stoppedSha: string | null
  stoppedSubject: string | null
  /** Whether `--continue` / `--abort` apply — false for `am` and `bisect`. */
  canContinue: boolean
}

export interface GitLogEntry {
  hash: string
  parents: string[]
  refs: string
  author: string
  date: string
  message: string
}

/** Options offered by the pull/push button context menus (#179). Mirrors the
 *  Rust `PullOption` / `PushOption` enums, which map them to git flags. */
export type PullOption = 'rebase' | 'autostash' | 'ff-only'
export type PushOption = 'force-with-lease' | 'tags' | 'set-upstream'

export interface GitBranches {
  local: string[]
  /** `<remote>/<branch>` form, e.g. `origin/main`. */
  remote: string[]
}

export interface GitWorktree {
  path: string
  branch: string | null
  head: string | null
  isBare: boolean
  isDetached: boolean
  isMain: boolean
}
