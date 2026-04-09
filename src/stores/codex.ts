import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useEditorInfo } from '../composables/useEditorInfo'
import { deleteChatHistory, loadChatHistory, saveChatHistory } from '../lib/codexHistory'
import {
  type ApprovalDecision,
  type CodexEditorContext,
  codexAuthLoginChatGpt,
  codexAuthLogout,
  codexAuthStatus,
  codexCheckAvailable,
  codexDisconnect,
  codexInterruptTurn,
  codexRespondApproval,
  codexStartSession,
  codexSubmitTurn,
  projectUpdate,
} from '../lib/tauri'
import type {
  ChatMessage,
  CodexAuthState,
  CommandApprovalRequest,
  FileChangeApprovalRequest,
  TurnItem,
} from '../types/codex'
import type { ShellType } from '../types/tab'
import { useProjectStore } from './project'
import { useTabStore } from './tabs'

let msgCounter = 0

/** Cached editor context — persists after switching away from the editor tab. */
let lastEditorContext: CodexEditorContext | null = null

/**
 * Get editor context for prompt injection.
 * If an editor is currently active, snapshot its info and cache it.
 * Otherwise, return the cached context from the last active editor.
 * Falls back to the first editor tab's path if no cached info exists.
 */
function getEditorContext(): CodexEditorContext | null {
  const { current } = useEditorInfo()
  const tabStore = useTabStore()

  // If an editor is currently active, use its live info and cache it
  if (current.value) {
    const tab = tabStore.tabs.find((t) => t.id === current.value?.tabId)
    if (tab && tab.kind === 'editor') {
      lastEditorContext = {
        path: tab.path,
        line: current.value.line,
        col: current.value.col,
        selectionStart: null,
        selectionEnd: null,
      }
      return lastEditorContext
    }
  }

  // Return cached context if available
  if (lastEditorContext) {
    // Verify the file is still open
    const stillOpen = tabStore.tabs.some((t) => t.kind === 'editor' && t.path === lastEditorContext?.path)
    if (stillOpen) return lastEditorContext
    lastEditorContext = null
  }

  // Fallback: find any open editor tab
  const editorTab = tabStore.tabs.find((t) => t.kind === 'editor')
  if (editorTab && editorTab.kind === 'editor') {
    return { path: editorTab.path, line: null, col: null, selectionStart: null, selectionEnd: null }
  }

  return null
}

function saveThreadIdToProject(threadId: string) {
  const projectStore = useProjectStore()
  if (projectStore.currentProject) {
    projectStore.currentProject.codexThreadId = threadId
    projectUpdate(projectStore.currentProject).catch(() => {})
  }
}

export const useCodexStore = defineStore('codex', () => {
  const connected = ref(false)
  const authState = ref<CodexAuthState>({ status: 'unknown' })
  const messages = ref<ChatMessage[]>([])
  const isGenerating = ref(false)
  const currentThreadId = ref<string | null>(null)
  const pendingCommandApproval = ref<CommandApprovalRequest | null>(null)
  const pendingFileApproval = ref<FileChangeApprovalRequest | null>(null)
  const codexVersion = ref<string | null>(null)
  const versionWarning = ref<string | null>(null)
  const scrollTrigger = ref(0)

  function currentAgentMsg(): ChatMessage | undefined {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.role === 'agent' && !m.completed) return m
    }
    return undefined
  }

  async function startSession(shell: ShellType, cwd: string, threadId?: string) {
    try {
      // Check codex version before connecting
      try {
        const ver = await codexCheckAvailable(shell)
        codexVersion.value = ver
        checkVersionCompatibility(ver)
      } catch (e) {
        throw new Error(`Codex CLI not found: ${e}`)
      }

      const tid = await codexStartSession(shell, cwd, threadId ?? null)
      currentThreadId.value = tid
      connected.value = true

      // Restore chat history from IndexedDB
      const history = await loadChatHistory(tid)
      if (history.length > 0) {
        messages.value = history
      }

      // Persist threadId to project config for session resumption
      saveThreadIdToProject(tid)

      try {
        authState.value = await codexAuthStatus()
      } catch {
        // ignore
      }
      if (authState.value.status !== 'authenticated') {
        await login()
      }
    } catch (e) {
      console.error('[codex] Failed to start session:', e)
      throw e
    }
  }

  function checkVersionCompatibility(version: string) {
    // Extract major.minor from version string like "0.104.0" or "codex 0.118.0"
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!match) {
      versionWarning.value = `Unknown Codex version: ${version}`
      return
    }
    const major = Number.parseInt(match[1])
    const minor = Number.parseInt(match[2])
    // Pike 0.4.0 was developed against Codex 0.104.0 - 0.118.0
    if (major === 0 && minor < 100) {
      versionWarning.value = `Codex ${version} may not be compatible (expected 0.100+)`
    } else {
      versionWarning.value = null
    }
  }

  async function disconnect() {
    try {
      await codexDisconnect()
    } catch (e) {
      console.error('[codex] disconnect error:', e)
    }
    connected.value = false
    currentThreadId.value = null
    isGenerating.value = false
  }

  async function login() {
    authState.value = { status: 'authenticatingChatGpt' }
    try {
      await codexAuthLoginChatGpt()
    } catch (e) {
      console.error('[codex] login error:', e)
      authState.value = { status: 'error', message: String(e) }
    }
  }

  async function logout() {
    try {
      await codexAuthLogout()
      authState.value = { status: 'unauthenticated' }
    } catch (e) {
      console.error('[codex] logout error:', e)
    }
  }

  async function submitTurn(prompt: string) {
    const userMsg: ChatMessage = {
      id: `msg-${++msgCounter}`,
      role: 'user',
      text: prompt,
      segments: [],
      items: [],
      completed: true,
    }
    messages.value.push(userMsg)

    const agentMsg: ChatMessage = {
      id: `msg-${++msgCounter}`,
      role: 'agent',
      text: '',
      segments: [],
      items: [],
      completed: false,
    }
    messages.value.push(agentMsg)
    isGenerating.value = true

    try {
      // Gather editor context from the currently active editor tab
      const editorCtx = getEditorContext()
      await codexSubmitTurn(prompt, editorCtx)
    } catch (e) {
      agentMsg.text = `Error: ${e}`
      agentMsg.segments = [{ kind: 'text', text: `Error: ${e}` }]
      agentMsg.completed = true
      isGenerating.value = false
    }
  }

  async function interruptTurn() {
    try {
      await codexInterruptTurn()
    } catch (e) {
      console.error('[codex] interrupt error:', e)
    }
    isGenerating.value = false
    const msg = currentAgentMsg()
    if (msg) msg.completed = true
  }

  function handleMessageDelta(delta: string) {
    const msg = currentAgentMsg()
    if (!msg) return
    msg.text += delta

    // Append to the last text segment, or create a new one
    const lastSeg = msg.segments[msg.segments.length - 1]
    if (lastSeg && lastSeg.kind === 'text') {
      lastSeg.text += delta
    } else {
      msg.segments.push({ kind: 'text', text: delta })
    }
  }

  function handleTurnCompleted() {
    const msg = currentAgentMsg()
    if (msg) msg.completed = true
    isGenerating.value = false
    persistHistory()
  }

  function persistHistory() {
    if (currentThreadId.value) {
      saveChatHistory(currentThreadId.value, messages.value).catch(() => {})
    }
  }

  function handleItemStarted(item: TurnItem) {
    const msg = currentAgentMsg()
    if (!msg) return
    // Deduplicate: skip if an item with the same ID already exists
    if (msg.items.some((i) => i.id === item.id)) return
    msg.items.push({ ...item, completed: false })
    // Insert as a segment so it appears inline with text
    msg.segments.push({ kind: 'item', item: msg.items[msg.items.length - 1] })
  }

  // Buffer command output deltas and flush on a timer to avoid O(n^2) string
  // concatenation and per-delta Vue reactivity updates.
  const outputBuffers = new Map<string, string>()
  let outputFlushTimer: ReturnType<typeof setTimeout> | null = null

  function handleCommandOutputDelta(itemId: string, delta: string) {
    outputBuffers.set(itemId, (outputBuffers.get(itemId) ?? '') + delta)
    if (!outputFlushTimer) {
      outputFlushTimer = setTimeout(flushOutputBuffers, 100)
    }
  }

  function flushOutputBuffers() {
    outputFlushTimer = null
    for (const [itemId, buffered] of outputBuffers) {
      for (let i = messages.value.length - 1; i >= 0; i--) {
        const item = messages.value[i].items.find((it) => it.id === itemId)
        if (item) {
          const current = (item.data.output as string) ?? ''
          // Cap at 50KB to prevent memory issues with verbose commands
          const combined = current + buffered
          item.data.output = combined.length > 50000 ? `…${combined.slice(-50000)}` : combined
          break
        }
      }
    }
    outputBuffers.clear()
    scrollTrigger.value++
  }

  function handleItemCompleted(itemId: string, itemData?: Record<string, unknown>) {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const item = messages.value[i].items.find((it) => it.id === itemId)
      if (item) {
        item.completed = true
        if (itemData) Object.assign(item.data, itemData)
        break
      }
    }
  }

  function handleAuthUpdated(state: CodexAuthState) {
    authState.value = state
  }

  async function respondApproval(requestId: number | string, decision: ApprovalDecision) {
    await codexRespondApproval(requestId, decision)
    pendingCommandApproval.value = null
    pendingFileApproval.value = null
  }

  function clearMessages() {
    messages.value = []
    if (currentThreadId.value) {
      deleteChatHistory(currentThreadId.value).catch(() => {})
    }
  }

  /** Start a new conversation: disconnect, clear history, remove saved threadId. */
  async function newConversation() {
    clearMessages()
    await disconnect()
    const projectStore = useProjectStore()
    if (projectStore.currentProject) {
      projectStore.currentProject.codexThreadId = undefined
      projectUpdate(projectStore.currentProject).catch(() => {})
    }
  }

  return {
    connected,
    authState,
    messages,
    isGenerating,
    currentThreadId,
    pendingCommandApproval,
    pendingFileApproval,
    codexVersion,
    versionWarning,
    scrollTrigger,
    startSession,
    disconnect,
    login,
    logout,
    submitTurn,
    interruptTurn,
    handleMessageDelta,
    handleTurnCompleted,
    handleItemStarted,
    handleCommandOutputDelta,
    handleItemCompleted,
    handleAuthUpdated,
    respondApproval,
    clearMessages,
    newConversation,
  }
})
