export interface GitFileChange {
  path: string
  status: string
}

export interface GitStatusResult {
  branch: string
  isDirty: boolean
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  ahead: number
  behind: number
}

export interface GitLogEntry {
  hash: string
  author: string
  date: string
  message: string
}
