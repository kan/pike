/** Agent type identifier */
export type AgentType = 'codex' | 'claude-code'

/** Agent capabilities declared by the runtime */
export interface AgentCapabilities {
  displayName: string
  supportsModelSelection: boolean
  supportsSessionResume: boolean
  supportsRollback: boolean
  supportsCompact: boolean
  supportsSandboxConfig: boolean
  supportsApprovalConfig: boolean
  supportsAuthFlow: boolean
}

/** Authentication state — shared across runtimes */
export type AgentAuthState =
  | { status: 'unknown' }
  | { status: 'unauthenticated' }
  | { status: 'authenticating' }
  | { status: 'authenticated'; mode: string; planType: string | null; email: string | null }
  | { status: 'error'; message: string }

/** Model information */
export interface AgentModelInfo {
  id: string
  displayName: string | null
  description: string | null
  isDefault: boolean
}

/** Slash command advertised by an agent runtime */
export interface AgentCommandInfo {
  name: string
  description: string
  inputHint: string | null
}

/** Approval decision sent back to the runtime */
export type AgentApprovalDecision = 'allow' | 'allowAlways' | 'reject' | 'cancel'

/** Editor context for prompt injection */
export interface AgentEditorContext {
  path: string
  line: number | null
  col: number | null
  selectionStart: number | null
  selectionEnd: number | null
}

// ---------------------------------------------------------------------------
// Agent events (emitted by the Rust backend)
// ---------------------------------------------------------------------------

export interface AgentEventMessageDelta {
  type: 'messageDelta'
  delta: string
  itemId: string | null
}

export interface AgentEventTurnStarted {
  type: 'turnStarted'
}

export interface AgentEventTurnCompleted {
  type: 'turnCompleted'
}

export interface AgentEventItemStarted {
  type: 'itemStarted'
  itemType: string
  itemId: string
  data: Record<string, unknown>
}

export interface AgentEventItemCompleted {
  type: 'itemCompleted'
  itemId: string
  data: Record<string, unknown>
}

export interface AgentEventCommandOutputDelta {
  type: 'commandOutputDelta'
  itemId: string
  delta: string
}

export interface AgentEventApprovalCommand {
  type: 'approvalCommandRequest'
  requestId: unknown
  itemId: string
  command: string | null
  cwd: string | null
  payload: Record<string, unknown>
}

export interface AgentEventApprovalFile {
  type: 'approvalFileRequest'
  requestId: unknown
  itemId: string
  filePath: string | null
  reason: string | null
  payload: Record<string, unknown>
}

export interface AgentEventApprovalGeneric {
  type: 'approvalGenericRequest'
  requestId: unknown
  toolName: string
  toolArguments: Record<string, unknown>
  options: string[]
  payload: Record<string, unknown>
}

export interface AgentEventAuthUpdated {
  type: 'authUpdated'
  state: AgentAuthState
}

export interface AgentEventTokenUsage {
  type: 'tokenUsage'
  input: number
  output: number
  cachedRead: number | null
  cachedWrite: number | null
}

export interface AgentEventReasoning {
  type: 'reasoning'
  itemId: string
  summary: string | null
}

export interface AgentEventDisconnected {
  type: 'disconnected'
  reason: string
}

export interface AgentEventError {
  type: 'error'
  message: string
}

/** Union of all agent events */
export type AgentEvent =
  | AgentEventMessageDelta
  | AgentEventTurnStarted
  | AgentEventTurnCompleted
  | AgentEventItemStarted
  | AgentEventItemCompleted
  | AgentEventCommandOutputDelta
  | AgentEventApprovalCommand
  | AgentEventApprovalFile
  | AgentEventApprovalGeneric
  | AgentEventAuthUpdated
  | AgentEventTokenUsage
  | AgentEventReasoning
  | AgentEventDisconnected
  | AgentEventError

/** Command approval request (displayed in UI) */
export interface CommandApprovalRequest {
  requestId: unknown
  itemId: string
  command: string | null
  cwd: string | null
  payload: Record<string, unknown>
}

/** File change approval request (displayed in UI) */
export interface FileApprovalRequest {
  requestId: unknown
  itemId: string
  filePath: string | null
  reason: string | null
  payload: Record<string, unknown>
}

/** Generic approval request (displayed in UI) */
export interface GenericApprovalRequest {
  requestId: unknown
  toolName: string
  toolArguments: Record<string, unknown>
  options: string[]
  payload: Record<string, unknown>
}
