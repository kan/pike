/**
 * Claude Code 固有の型。**使用量はここに無い**（#263 で `types/agentUsage.ts` の
 * 種別に依らない形へ移した）。残っているのはセッション一覧だけで、あれは Claude 決め打ちの
 * 機能（`claude --resume`）なので種別に依らない形を持たない。
 */

/**
 * One entry of the terminal launcher's resume list (#220) — a past interactive
 * Claude Code session of this project, read out of `~/.claude/projects/…`.
 */
export interface ClaudeSession {
  /** Session id; the argument of `claude --resume`. */
  id: string
  /** Claude's generated title, falling back to the session's last prompt. */
  title: string
  /** Transcript mtime (epoch ms). */
  modifiedAt: number
  gitBranch: string | null
}
