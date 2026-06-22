export interface GitFileChange {
  path: string
  status: string
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
}

export interface GitLogEntry {
  hash: string
  parents: string[]
  refs: string
  author: string
  date: string
  message: string
}

export interface GitWorktree {
  path: string
  branch: string | null
  head: string | null
  isBare: boolean
  isDetached: boolean
  isMain: boolean
}
