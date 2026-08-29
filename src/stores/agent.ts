/**
 * Unified agent store — manages multiple per-tab agent sessions.
 *
 * Each agent-chat tab has its own independent session state (messages,
 * connection, approval requests, etc.). The store is keyed by tab ID.
 */
import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { useEditorInfo } from '../composables/useEditorInfo'
import { deleteChatHistory, loadChatHistory, saveChatHistory } from '../lib/codexHistory'
import { estimateOpenAICost } from '../lib/format'
import { pathSep } from '../lib/paths'
import { loadJson, saveJson } from '../lib/storage'
import {
  agentAuthLogin,
  agentAuthLogout,
  agentAuthStatus,
  agentCapabilities,
  agentCheckAvailable,
  agentCompact,
  agentDisconnect,
  agentEnsureInstalled,
  agentInterruptTurn,
  agentListModels,
  agentRespondApproval,
  agentRollbackTurn,
  agentStartSession,
  agentSubmitTurn,
  fsReadFile,
} from '../lib/tauri'
import type {
  AgentApprovalDecision,
  AgentAuthState,
  AgentCapabilities,
  AgentCommandInfo,
  AgentEditorContext,
  AgentModelInfo,
  AgentType,
  CommandApprovalRequest,
  FileApprovalRequest,
  GenericApprovalRequest,
} from '../types/agent'
import type { ChatMessage, TurnItem } from '../types/chat'
import { isWindowsShell, type ShellType } from '../types/tab'
import { useProjectStore } from './project'
import { useSettingsStore } from './settings'
import { useTabStore } from './tabs'

let msgCounter = 0

// ---------------------------------------------------------------------------
// Per-project agent settings (localStorage)
// ---------------------------------------------------------------------------

const AGENT_SETTINGS_PREFIX = 'pike:agent:'

interface AgentProjectSettings {
  agentType: AgentType
  sandboxMode: string | null
  approvalPolicy: string | null
}

function loadAgentProjectSettings(projectId: string): AgentProjectSettings {
  return {
    agentType: 'codex',
    sandboxMode: null,
    approvalPolicy: null,
    ...loadJson<Partial<AgentProjectSettings>>(`${AGENT_SETTINGS_PREFIX}${projectId}`, {}),
  }
}

function saveAgentProjectSettings(projectId: string, settings: AgentProjectSettings) {
  saveJson(`${AGENT_SETTINGS_PREFIX}${projectId}`, settings)
}

/** Cached editor context (global, shared across sessions) */
let lastEditorContext: AgentEditorContext | null = null

function getEditorContext(): AgentEditorContext | null {
  const { current } = useEditorInfo()
  const tabStore = useTabStore()

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

  if (lastEditorContext) {
    const stillOpen = tabStore.tabs.some((t) => t.kind === 'editor' && t.path === lastEditorContext?.path)
    if (stillOpen) return lastEditorContext
    lastEditorContext = null
  }

  const editorTab = tabStore.tabs.find((t) => t.kind === 'editor')
  if (editorTab && editorTab.kind === 'editor') {
    return { path: editorTab.path, line: null, col: null, selectionStart: null, selectionEnd: null }
  }

  return null
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

export interface AgentSessionState {
  connected: boolean
  agentType: AgentType
  /**
   * このセッションを起動したディレクトリ。**開始時の値を持ち続ける**（#269）。
   * 相対パス（@メンション・`/read`・`/diff`）の基準はここで、あとから worktree を
   * 切り替えても走っているセッションの足元は動かないため、`activeRoot` を読み直すと
   * エージェントに届かないパスを送ることになる。
   */
  cwd: string | null
  capabilities: AgentCapabilities | null
  authState: AgentAuthState
  messages: ChatMessage[]
  isGenerating: boolean
  currentSessionId: string | null
  pendingCommandApproval: CommandApprovalRequest | null
  pendingFileApproval: FileApprovalRequest | null
  pendingGenericApproval: GenericApprovalRequest | null
  agentVersion: string | null
  versionWarning: string | null
  installStatus: string | null
  scrollTrigger: number
  detectedInstructionsFile: string | null
  selectedModel: string | null
  availableModels: AgentModelInfo[]
  tokenUsage: { input: number; output: number } | null
  estimatedCostUsd: number | null
  disconnectReason: string | null
  sandboxMode: string | null
  approvalPolicy: string | null
  availableCommands: AgentCommandInfo[]
}

function createDefaultSession(agentType: AgentType = 'codex'): AgentSessionState {
  return {
    connected: false,
    agentType,
    cwd: null,
    capabilities: null,
    authState: { status: 'unknown' },
    messages: [],
    isGenerating: false,
    currentSessionId: null,
    pendingCommandApproval: null,
    pendingFileApproval: null,
    pendingGenericApproval: null,
    agentVersion: null,
    versionWarning: null,
    installStatus: null,
    scrollTrigger: 0,
    detectedInstructionsFile: null,
    selectedModel: null,
    availableModels: [],
    tokenUsage: null,
    estimatedCostUsd: null,
    disconnectReason: null,
    sandboxMode: null,
    approvalPolicy: null,
    availableCommands: [],
  }
}

// Per-session timers/buffers (not reactive — plain Maps)
/** Cap for text that streams into a single turn item (command output, thinking). */
const MAX_ITEM_TEXT = 50000
const capText = (text: string) => (text.length > MAX_ITEM_TEXT ? `…${text.slice(-MAX_ITEM_TEXT)}` : text)

/** Pending appends per tab, keyed by item id: which `data` field, and the text so far. */
const appendBuffers = new Map<string, Map<string, { field: string; text: string }>>()
const appendFlushTimers = new Map<string, ReturnType<typeof setTimeout>>()
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAgentStore = defineStore('agent', () => {
  const sessions = reactive<Record<string, AgentSessionState>>({})

  /** Get or create a session for a tab. Use for UI/action code that needs auto-creation. */
  function getSession(tabId: string): AgentSessionState {
    if (!sessions[tabId]) {
      const tabStore = useTabStore()
      const tab = tabStore.tabs.find((t) => t.id === tabId)
      const agentType: AgentType = tab?.kind === 'agent-chat' ? tab.agentType : 'claude-code'
      sessions[tabId] = createDefaultSession(agentType)
    }
    return sessions[tabId]
  }

  /** Get a session only if it exists. Use in event handlers to avoid resurrecting closed tabs. */
  function getExistingSession(tabId: string): AgentSessionState | undefined {
    return sessions[tabId]
  }

  function removeSession(tabId: string) {
    delete sessions[tabId]
    // Clean up timers
    const pt = persistTimers.get(tabId)
    if (pt) {
      clearTimeout(pt)
      persistTimers.delete(tabId)
    }
    const aft = appendFlushTimers.get(tabId)
    if (aft) {
      clearTimeout(aft)
      appendFlushTimers.delete(tabId)
    }
    appendBuffers.delete(tabId)
  }

  // --- Helpers ---

  function currentAgentMsg(tabId: string): ChatMessage | undefined {
    const s = sessions[tabId]
    if (!s) return undefined
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i]
      if (m.role === 'agent' && !m.completed) return m
    }
    return undefined
  }

  function persistHistory(tabId: string) {
    const existing = persistTimers.get(tabId)
    if (existing) clearTimeout(existing)
    persistTimers.set(
      tabId,
      setTimeout(() => {
        persistTimers.delete(tabId)
        const s = sessions[tabId]
        if (s?.currentSessionId) {
          saveChatHistory(s.currentSessionId, s.messages).catch(() => {})
        }
      }, 300),
    )
  }

  function updateEstimatedCost(s: AgentSessionState) {
    if (s.tokenUsage && s.selectedModel) {
      s.estimatedCostUsd = estimateOpenAICost(s.selectedModel, s.tokenUsage.input, s.tokenUsage.output)
    } else {
      s.estimatedCostUsd = null
    }
  }

  // --- Actions ---

  async function startSession(
    tabId: string,
    shell: ShellType,
    cwd: string,
    sessionId?: string,
    requestedAgentType?: AgentType,
  ) {
    const s = getSession(tabId)
    try {
      // Load per-project settings
      const projectStore = useProjectStore()
      const projectId = projectStore.currentProject?.id
      if (projectId) {
        const projSettings = loadAgentProjectSettings(projectId)
        s.sandboxMode = projSettings.sandboxMode
        s.approvalPolicy = projSettings.approvalPolicy
        if (!requestedAgentType) {
          s.agentType = projSettings.agentType
        }
      }
      if (requestedAgentType) {
        s.agentType = requestedAgentType
      } else if (!projectId) {
        const settings = useSettingsStore()
        s.agentType = settings.agentDefault === 'ask' ? 'claude-code' : settings.agentDefault
      }

      // Check agent availability — auto-install for claude-code if missing
      try {
        const ver = await agentCheckAvailable(s.agentType, shell)
        s.agentVersion = ver
        if (s.agentType === 'codex') {
          checkCodexVersionCompatibility(s, ver)
        }
      } catch (e) {
        if (s.agentType === 'claude-code') {
          s.installStatus = 'installing'
          try {
            const ver = await agentEnsureInstalled(s.agentType, shell)
            s.agentVersion = ver
          } catch (installErr) {
            s.installStatus = null
            throw new Error(`Failed to install claude-agent-acp: ${installErr}`)
          } finally {
            s.installStatus = null
          }
        } else {
          throw new Error(`${s.agentType} not found: ${e}`)
        }
      }

      // Windows (non-WSL) always uses externalSandbox for Codex
      const effectiveSandbox = s.agentType === 'codex' && isWindowsShell(shell) ? 'externalSandbox' : s.sandboxMode

      const sid = await agentStartSession(
        tabId,
        s.agentType,
        shell,
        cwd,
        sessionId ?? null,
        effectiveSandbox,
        s.approvalPolicy,
      )

      s.currentSessionId = sid
      s.cwd = cwd
      s.connected = true
      s.disconnectReason = null
      s.tokenUsage = null
      updateEstimatedCost(s)

      // Fetch capabilities from the runtime
      try {
        s.capabilities = await agentCapabilities(tabId)
      } catch {
        // ignore — capabilities are optional
      }

      // Restore chat history
      if (s.messages.length === 0) {
        const history = await loadChatHistory(sid)
        if (history.length > 0) {
          s.messages = history
        }
      }

      // Detect AGENTS.md / CLAUDE.md
      s.detectedInstructionsFile = null
      const sep = pathSep(shell)
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        try {
          await fsReadFile(shell, `${cwd}${sep}${name}`)
          s.detectedInstructionsFile = name
          break
        } catch {
          // File doesn't exist
        }
      }

      // Check auth (if supported)
      try {
        s.authState = await agentAuthStatus(tabId)
      } catch {
        // ignore
      }
      if (s.capabilities?.supportsAuthFlow && s.authState.status !== 'authenticated') {
        await login(tabId)
      }
    } catch (e) {
      console.error('[agent] Failed to start session:', e)
      throw e
    }
  }

  function checkCodexVersionCompatibility(s: AgentSessionState, version: string) {
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!match) {
      s.versionWarning = `Unknown version: ${version}`
      return
    }
    const major = Number.parseInt(match[1], 10)
    const minor = Number.parseInt(match[2], 10)
    if (major === 0 && minor < 100) {
      s.versionWarning = `Version ${version} may not be compatible (expected 0.100+)`
    } else {
      s.versionWarning = null
    }
  }

  async function disconnect(tabId: string) {
    try {
      await agentDisconnect(tabId)
    } catch (e) {
      console.error('[agent] disconnect error:', e)
    }
    const s = sessions[tabId]
    if (s) {
      markDisconnected(s)
      s.currentSessionId = null
    }
  }

  /**
   * セッションが死んだときの共通のリセット。**`cwd` を手放すのが要点**（#269）: 残すと、
   * 切断したタブが古い worktree を基準に相対パスを組み立て続ける（次のセッションは
   * `activeRoot` で始まるので、そのパスは届かない）。
   */
  function markDisconnected(s: AgentSessionState) {
    s.connected = false
    s.isGenerating = false
    s.availableCommands = []
    s.cwd = null
  }

  async function login(tabId: string) {
    const s = getSession(tabId)
    s.authState = { status: 'authenticating' }
    try {
      await agentAuthLogin(tabId)
    } catch (e) {
      console.error('[agent] login error:', e)
      s.authState = { status: 'error', message: String(e) }
    }
  }

  async function logout(tabId: string) {
    const s = getSession(tabId)
    try {
      await agentAuthLogout(tabId)
      s.authState = { status: 'unauthenticated' }
    } catch (e) {
      console.error('[agent] logout error:', e)
    }
  }

  async function submitTurn(tabId: string, prompt: string, displayText?: string) {
    const s = getSession(tabId)
    const userMsg: ChatMessage = {
      id: `msg-${++msgCounter}`,
      role: 'user',
      text: displayText ?? prompt,
      segments: [],
      items: [],
      completed: true,
    }
    s.messages.push(userMsg)
    persistHistory(tabId)

    const agentMsg: ChatMessage = {
      id: `msg-${++msgCounter}`,
      role: 'agent',
      text: '',
      segments: [],
      items: [],
      completed: false,
    }
    s.messages.push(agentMsg)
    s.isGenerating = true

    try {
      const editorCtx = getEditorContext()
      await agentSubmitTurn(tabId, prompt, editorCtx, s.selectedModel)
    } catch (e) {
      agentMsg.text = `Error: ${e}`
      agentMsg.segments = [{ kind: 'text', text: `Error: ${e}` }]
      agentMsg.completed = true
      s.isGenerating = false
    }
  }

  async function listModels(tabId: string): Promise<AgentModelInfo[]> {
    const s = getSession(tabId)
    try {
      const models = await agentListModels(tabId)
      s.availableModels = models
      return models
    } catch (e) {
      console.error('[agent] listModels error:', e)
      throw e
    }
  }

  function setModel(tabId: string, modelId: string | null) {
    const s = getSession(tabId)
    s.selectedModel = modelId
    updateEstimatedCost(s)
  }

  async function rollbackTurn(tabId: string) {
    const s = getSession(tabId)
    try {
      await agentRollbackTurn(tabId)
      while (s.messages.length > 0) {
        const last = s.messages[s.messages.length - 1]
        s.messages.pop()
        if (last.role === 'user') break
      }
      persistHistory(tabId)
    } catch (e) {
      console.error('[agent] rollback error:', e)
      throw e
    }
  }

  async function compactThread(tabId: string) {
    try {
      await agentCompact(tabId)
    } catch (e) {
      console.error('[agent] compact error:', e)
      throw e
    }
  }

  async function interruptTurn(tabId: string) {
    const s = getSession(tabId)
    try {
      await agentInterruptTurn(tabId)
    } catch (e) {
      console.error('[agent] interrupt error:', e)
    }
    s.isGenerating = false
    const msg = currentAgentMsg(tabId)
    if (msg) msg.completed = true
  }

  // --- Event handlers (called from useAgentRouter) ---

  function handleMessageDelta(tabId: string, delta: string) {
    const msg = currentAgentMsg(tabId)
    if (!msg) return
    msg.text += delta
    const lastSeg = msg.segments[msg.segments.length - 1]
    if (lastSeg && lastSeg.kind === 'text') {
      lastSeg.text += delta
    } else {
      msg.segments.push({ kind: 'text', text: delta })
    }
  }

  function handleTurnCompleted(tabId: string) {
    const s = sessions[tabId]
    if (!s) return
    const msg = currentAgentMsg(tabId)
    if (msg) msg.completed = true
    s.isGenerating = false
    persistHistory(tabId)
  }

  function handleItemStarted(tabId: string, item: TurnItem) {
    const msg = currentAgentMsg(tabId)
    if (!msg) return
    // 同じ id が再び来るのは「既存の項目を詳しくする」更新。ACP は最初のツール呼び出しを
    // 入力がまだ流れきる前に送るので（Bash なら title が "Terminal" のまま）、後から来る
    // 本当のコマンドはこの経路でしか届かない。捨てずに重ねる（#227）。
    const existing = msg.items.find((i) => i.id === item.id)
    if (existing) {
      // `undefined` は上書きしない。あとから来る更新が、先に取れていた値（ファイル
      // パスなど）を消してしまう。`handleItemCompleted` 側も同じ規約。
      for (const [key, value] of Object.entries(item.data)) {
        if (value !== undefined) existing.data[key] = value
      }
      return
    }
    msg.items.push({ ...item, completed: false })
    msg.segments.push({ kind: 'item', item: msg.items[msg.items.length - 1] })
  }

  /**
   * Agent thinking and plans (#227). Unlike other items these arrive repeatedly for
   * the same id — thinking as chunks to append, a plan as the whole list to replace —
   * so this updates in place instead of going through `handleItemStarted`, which
   * ignores an id it has already seen.
   */
  function handleReasoning(tabId: string, itemId: string, summary: string, append: boolean) {
    if (!summary) return
    const msg = currentAgentMsg(tabId)
    if (!msg) return
    const existing = msg.items.find((i) => i.id === itemId)
    if (!existing) {
      handleItemStarted(tabId, { type: 'reasoning', id: itemId, data: { summary }, completed: false })
    } else if (append) {
      bufferAppend(tabId, itemId, 'summary', summary)
    } else {
      existing.data.summary = capText(summary)
    }
  }

  function handleCommandOutputDelta(tabId: string, itemId: string, delta: string) {
    bufferAppend(tabId, itemId, 'output', delta)
  }

  /**
   * Coalesce text that streams into one turn item (command output, thinking).
   *
   * Both arrive in small chunks and the item body is re-rendered — thinking is even
   * re-parsed as markdown — on every write, so writing per chunk makes a long turn
   * progressively slower. Batching on a timer keeps that flat.
   */
  function bufferAppend(tabId: string, itemId: string, field: string, text: string) {
    if (!appendBuffers.has(tabId)) appendBuffers.set(tabId, new Map())
    const buf = appendBuffers.get(tabId)!
    buf.set(itemId, { field, text: (buf.get(itemId)?.text ?? '') + text })
    if (!appendFlushTimers.has(tabId)) {
      appendFlushTimers.set(
        tabId,
        setTimeout(() => flushAppendBuffers(tabId), 100),
      )
    }
  }

  function flushAppendBuffers(tabId: string) {
    appendFlushTimers.delete(tabId)
    const buf = appendBuffers.get(tabId)
    if (!buf) return
    const s = sessions[tabId]
    if (!s) return
    for (const [itemId, { field, text }] of buf) {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const item = s.messages[i].items.find((it) => it.id === itemId)
        if (item) {
          item.data[field] = capText(String(item.data[field] ?? '') + text)
          break
        }
      }
    }
    buf.clear()
    s.scrollTrigger++
  }

  function handleItemCompleted(tabId: string, itemId: string, itemData?: Record<string, unknown>) {
    const s = sessions[tabId]
    if (!s) return
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const item = s.messages[i].items.find((it) => it.id === itemId)
      if (item) {
        item.completed = true
        if (itemData) Object.assign(item.data, itemData)
        break
      }
    }
  }

  function handleAuthUpdated(tabId: string, state: AgentAuthState) {
    const s = sessions[tabId]
    if (s) s.authState = state
  }

  function handleTokenUsage(tabId: string, usage: { input: number; output: number }) {
    const s = sessions[tabId]
    if (s) {
      s.tokenUsage = usage
      updateEstimatedCost(s)
    }
  }

  function handleAvailableCommands(tabId: string, commands: AgentCommandInfo[]) {
    const s = sessions[tabId]
    if (s) s.availableCommands = commands
  }

  function handleDisconnect(tabId: string, reason: string) {
    const s = sessions[tabId]
    if (!s) return
    markDisconnected(s)
    s.disconnectReason = reason
    const msg = currentAgentMsg(tabId)
    if (msg) msg.completed = true
  }

  async function respondApproval(
    tabId: string,
    requestId: unknown,
    decision: AgentApprovalDecision,
    optionId?: string,
  ) {
    await agentRespondApproval(tabId, requestId, decision, optionId)
    const s = sessions[tabId]
    if (s) {
      s.pendingCommandApproval = null
      s.pendingFileApproval = null
      s.pendingGenericApproval = null
    }
  }

  function setAgentType(type: AgentType) {
    const projectId = useProjectStore().currentProject?.id
    if (projectId) {
      const settings = loadAgentProjectSettings(projectId)
      settings.agentType = type
      saveAgentProjectSettings(projectId, settings)
    }
  }

  function updateProjectSetting<K extends keyof AgentProjectSettings>(field: K, value: AgentProjectSettings[K]) {
    const projectId = useProjectStore().currentProject?.id
    if (projectId) {
      const settings = loadAgentProjectSettings(projectId)
      settings[field] = value
      saveAgentProjectSettings(projectId, settings)
    }
  }

  function setSandboxMode(tabId: string, mode: string | null) {
    const s = getSession(tabId)
    s.sandboxMode = mode
    updateProjectSetting('sandboxMode', mode)
  }

  function setApprovalPolicy(tabId: string, policy: string | null) {
    const s = getSession(tabId)
    s.approvalPolicy = policy
    updateProjectSetting('approvalPolicy', policy)
  }

  function addSystemMessage(tabId: string, text: string) {
    const s = getSession(tabId)
    s.messages.push({
      id: `sys-${Date.now()}`,
      role: 'agent',
      text,
      segments: [{ kind: 'text', text }],
      items: [],
      completed: true,
    })
    persistHistory(tabId)
  }

  function clearMessages(tabId: string) {
    const s = getSession(tabId)
    s.messages = []
    if (s.currentSessionId) {
      deleteChatHistory(s.currentSessionId).catch(() => {})
    }
  }

  async function newConversation(tabId: string) {
    clearMessages(tabId)
    await disconnect(tabId)
  }

  return {
    sessions,
    getSession,
    getExistingSession,
    removeSession,
    // Actions
    startSession,
    disconnect,
    login,
    logout,
    submitTurn,
    compactThread,
    rollbackTurn,
    listModels,
    setModel,
    interruptTurn,
    respondApproval,
    setAgentType,
    setSandboxMode,
    setApprovalPolicy,
    addSystemMessage,
    clearMessages,
    newConversation,
    // Event handlers
    handleMessageDelta,
    handleTurnCompleted,
    handleItemStarted,
    handleReasoning,
    handleCommandOutputDelta,
    handleItemCompleted,
    handleAuthUpdated,
    handleTokenUsage,
    handleAvailableCommands,
    handleDisconnect,
  }
})
