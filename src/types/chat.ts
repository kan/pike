export type CodexAuthState =
  | { status: 'unknown' }
  | { status: 'unauthenticated' }
  | { status: 'authenticatingChatGpt' }
  | { status: 'authenticated'; mode: string; planType: string | null; email: string | null }
  | { status: 'error'; message: string }

/** A segment of agent output — either a text block or an action item. */
export type ContentSegment = { kind: 'text'; text: string } | { kind: 'item'; item: TurnItem }

export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  /** Flat text (used for user messages). Agent messages use `segments` instead. */
  text: string
  /** Time-ordered segments for agent messages (text chunks interleaved with items). */
  segments: ContentSegment[]
  items: TurnItem[]
  completed: boolean
}

export interface TurnItem {
  type: string
  id: string
  data: Record<string, unknown>
  completed: boolean
}

export interface CommandApprovalRequest {
  requestId: number | string
  itemId: string
  threadId: string
  turnId: string
  command: string | null
  cwd: string | null
  environment: string
  sandboxTrusted: boolean
}

export interface FileChangeApprovalRequest {
  requestId: number | string
  itemId: string
  threadId: string
  turnId: string
  reason: string | null
  filePath: string | null
  environment: string
  sandboxTrusted: boolean
}
