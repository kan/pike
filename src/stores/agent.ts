/**
 * Unified agent store — works with Codex, Claude Code, and other ACP agents.
 *
 * This store mirrors the structure of the codex store but uses the unified
 * agent_* Tauri commands and agent:// events. The UI can use this store
 * regardless of which runtime backs the agent session.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useEditorInfo } from '../composables/useEditorInfo'
import { deleteChatHistory, loadChatHistory, saveChatHistory } from '../lib/codexHistory'
import { estimateOpenAICost } from '../lib/format'
import {
  agentAuthLogin,
  agentAuthLogout,
  agentAuthStatus,
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
  projectUpdate,
} from '../lib/tauri'
import type {
  AgentApprovalDecision,
  AgentAuthState,
  AgentCapabilities,
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
  try {
    const raw = localStorage.getItem(`${AGENT_SETTINGS_PREFIX}${projectId}`)
    if (raw) return { agentType: 'codex', sandboxMode: null, approvalPolicy: null, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return { agentType: 'codex', sandboxMode: null, approvalPolicy: null }
}

function saveAgentProjectSettings(projectId: string, settings: AgentProjectSettings) {
  localStorage.setItem(`${AGENT_SETTINGS_PREFIX}${projectId}`, JSON.stringify(settings))
}

/** Cached editor context */
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

function saveSessionIdToProject(sessionId: string) {
  const projectStore = useProjectStore()
  if (projectStore.currentProject) {
    projectStore.currentProject.agentSessionId = sessionId
    projectUpdate(projectStore.currentProject).catch(() => {})
  }
}

export const useAgentStore = defineStore('agent', () => {
  // --- State ---
  const connected = ref(false)
  const agentType = ref<AgentType>('codex')
  const capabilities = ref<AgentCapabilities | null>(null)
  const authState = ref<AgentAuthState>({ status: 'unknown' })
  const messages = ref<ChatMessage[]>([])
  const isGenerating = ref(false)
  const currentSessionId = ref<string | null>(null)
  const pendingCommandApproval = ref<CommandApprovalRequest | null>(null)
  const pendingFileApproval = ref<FileApprovalRequest | null>(null)
  const pendingGenericApproval = ref<GenericApprovalRequest | null>(null)
  const agentVersion = ref<string | null>(null)
  const versionWarning = ref<string | null>(null)
  /** Non-null while auto-installing the agent binary */
  const installStatus = ref<string | null>(null)
  const scrollTrigger = ref(0)
  const detectedInstructionsFile = ref<string | null>(null)
  const selectedModel = ref<string | null>(null)
  const availableModels = ref<AgentModelInfo[]>([])
  const tokenUsage = ref<{ input: number; output: number } | null>(null)
  const estimatedCostUsd = computed<number | null>(() => {
    if (!tokenUsage.value || !selectedModel.value) return null
    return estimateOpenAICost(selectedModel.value, tokenUsage.value.input, tokenUsage.value.output)
  })
  const disconnectReason = ref<string | null>(null)
  const sandboxMode = ref<string | null>(null)
  const approvalPolicy = ref<string | null>(null)

  function currentAgentMsg(): ChatMessage | undefined {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const m = messages.value[i]
      if (m.role === 'agent' && !m.completed) return m
    }
    return undefined
  }

  // --- Actions ---

  async function startSession(shell: ShellType, cwd: string, sessionId?: string, requestedAgentType?: AgentType) {
    try {
      // Load per-project settings
      const projectStore = useProjectStore()
      const projectId = projectStore.currentProject?.id
      if (projectId) {
        const projSettings = loadAgentProjectSettings(projectId)
        sandboxMode.value = projSettings.sandboxMode
        approvalPolicy.value = projSettings.approvalPolicy
      }
      // Determine agent type: explicit request > per-project > global setting > fallback
      if (requestedAgentType) {
        agentType.value = requestedAgentType
      } else if (projectId) {
        const projSettings = loadAgentProjectSettings(projectId)
        agentType.value = projSettings.agentType
      } else {
        const settings = useSettingsStore()
        agentType.value = settings.agentDefault === 'ask' ? 'claude-code' : settings.agentDefault
      }

      // Check agent availability — auto-install for claude-code if missing
      try {
        const ver = await agentCheckAvailable(agentType.value, shell)
        agentVersion.value = ver
        if (agentType.value === 'codex') {
          checkCodexVersionCompatibility(ver)
        }
      } catch (e) {
        if (agentType.value === 'claude-code') {
          installStatus.value = 'installing'
          try {
            const ver = await agentEnsureInstalled(agentType.value, shell)
            agentVersion.value = ver
          } catch (installErr) {
            installStatus.value = null
            throw new Error(`Failed to install claude-agent-acp: ${installErr}`)
          } finally {
            installStatus.value = null
          }
        } else {
          throw new Error(`${agentType.value} not found: ${e}`)
        }
      }

      // Windows (non-WSL) always uses externalSandbox for Codex
      const effectiveSandbox =
        agentType.value === 'codex' && isWindowsShell(shell) ? 'externalSandbox' : sandboxMode.value

      const sid = await agentStartSession(
        agentType.value,
        shell,
        cwd,
        sessionId ?? null,
        effectiveSandbox,
        approvalPolicy.value,
      )

      currentSessionId.value = sid
      connected.value = true
      disconnectReason.value = null
      tokenUsage.value = null

      // Restore chat history
      if (messages.value.length === 0) {
        const history = await loadChatHistory(sid)
        if (history.length > 0) {
          messages.value = history
        }
      }

      // Persist session ID
      saveSessionIdToProject(sid)

      // Detect AGENTS.md / CLAUDE.md
      detectedInstructionsFile.value = null
      const sep = shell.kind === 'wsl' ? '/' : '\\'
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        try {
          await fsReadFile(shell, `${cwd}${sep}${name}`)
          detectedInstructionsFile.value = name
          break
        } catch {
          // File doesn't exist
        }
      }

      // Check auth (if supported)
      try {
        authState.value = await agentAuthStatus()
      } catch {
        // ignore
      }
      if (capabilities.value?.supportsAuthFlow && authState.value.status !== 'authenticated') {
        await login()
      }
    } catch (e) {
      console.error('[agent] Failed to start session:', e)
      throw e
    }
  }

  function checkCodexVersionCompatibility(version: string) {
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
    if (!match) {
      versionWarning.value = `Unknown version: ${version}`
      return
    }
    const major = Number.parseInt(match[1], 10)
    const minor = Number.parseInt(match[2], 10)
    if (major === 0 && minor < 100) {
      versionWarning.value = `Version ${version} may not be compatible (expected 0.100+)`
    } else {
      versionWarning.value = null
    }
  }

  async function disconnect() {
    try {
      await agentDisconnect()
    } catch (e) {
      console.error('[agent] disconnect error:', e)
    }
    connected.value = false
    currentSessionId.value = null
    isGenerating.value = false
  }

  async function login() {
    authState.value = { status: 'authenticating' }
    try {
      await agentAuthLogin()
    } catch (e) {
      console.error('[agent] login error:', e)
      authState.value = { status: 'error', message: String(e) }
    }
  }

  async function logout() {
    try {
      await agentAuthLogout()
      authState.value = { status: 'unauthenticated' }
    } catch (e) {
      console.error('[agent] logout error:', e)
    }
  }

  async function submitTurn(prompt: string, displayText?: string) {
    const userMsg: ChatMessage = {
      id: `msg-${++msgCounter}`,
      role: 'user',
      text: displayText ?? prompt,
      segments: [],
      items: [],
      completed: true,
    }
    messages.value.push(userMsg)
    persistHistory()

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
      const editorCtx = getEditorContext()
      await agentSubmitTurn(prompt, editorCtx, selectedModel.value)
    } catch (e) {
      agentMsg.text = `Error: ${e}`
      agentMsg.segments = [{ kind: 'text', text: `Error: ${e}` }]
      agentMsg.completed = true
      isGenerating.value = false
    }
  }

  async function listModels(): Promise<AgentModelInfo[]> {
    try {
      const models = await agentListModels()
      availableModels.value = models
      return models
    } catch (e) {
      console.error('[agent] listModels error:', e)
      throw e
    }
  }

  function setModel(modelId: string | null) {
    selectedModel.value = modelId
  }

  async function rollbackTurn() {
    try {
      await agentRollbackTurn()
      while (messages.value.length > 0) {
        const last = messages.value[messages.value.length - 1]
        messages.value.pop()
        if (last.role === 'user') break
      }
      persistHistory()
    } catch (e) {
      console.error('[agent] rollback error:', e)
      throw e
    }
  }

  async function compactThread() {
    try {
      await agentCompact()
    } catch (e) {
      console.error('[agent] compact error:', e)
      throw e
    }
  }

  async function interruptTurn() {
    try {
      await agentInterruptTurn()
    } catch (e) {
      console.error('[agent] interrupt error:', e)
    }
    isGenerating.value = false
    const msg = currentAgentMsg()
    if (msg) msg.completed = true
  }

  // --- Event handlers (called from useAgentRouter) ---

  function handleMessageDelta(delta: string) {
    const msg = currentAgentMsg()
    if (!msg) return
    msg.text += delta
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

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  function persistHistory() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      if (currentSessionId.value) {
        saveChatHistory(currentSessionId.value, messages.value).catch(() => {})
      }
    }, 300)
  }

  function handleItemStarted(item: TurnItem) {
    const msg = currentAgentMsg()
    if (!msg) return
    if (msg.items.some((i) => i.id === item.id)) return
    msg.items.push({ ...item, completed: false })
    msg.segments.push({ kind: 'item', item: msg.items[msg.items.length - 1] })
  }

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

  function handleAuthUpdated(state: AgentAuthState) {
    authState.value = state
  }

  function handleTokenUsage(usage: { input: number; output: number }) {
    tokenUsage.value = usage
  }

  function handleDisconnect(reason: string) {
    connected.value = false
    isGenerating.value = false
    disconnectReason.value = reason
    const msg = currentAgentMsg()
    if (msg) msg.completed = true
  }

  async function respondApproval(requestId: unknown, decision: AgentApprovalDecision) {
    await agentRespondApproval(requestId, decision)
    pendingCommandApproval.value = null
    pendingFileApproval.value = null
    pendingGenericApproval.value = null
  }

  function setAgentType(type: AgentType) {
    agentType.value = type
    const projectId = useProjectStore().currentProject?.id
    if (projectId) {
      const s = loadAgentProjectSettings(projectId)
      s.agentType = type
      saveAgentProjectSettings(projectId, s)
    }
  }

  function updateProjectSetting<K extends keyof AgentProjectSettings>(field: K, value: AgentProjectSettings[K]) {
    const projectId = useProjectStore().currentProject?.id
    if (projectId) {
      const s = loadAgentProjectSettings(projectId)
      s[field] = value
      saveAgentProjectSettings(projectId, s)
    }
  }

  function setSandboxMode(mode: string | null) {
    sandboxMode.value = mode
    updateProjectSetting('sandboxMode', mode)
  }

  function setApprovalPolicy(policy: string | null) {
    approvalPolicy.value = policy
    updateProjectSetting('approvalPolicy', policy)
  }

  function addSystemMessage(text: string) {
    messages.value.push({
      id: `sys-${Date.now()}`,
      role: 'agent',
      text,
      segments: [{ kind: 'text', text }],
      items: [],
      completed: true,
    })
    persistHistory()
  }

  function clearMessages() {
    messages.value = []
    if (currentSessionId.value) {
      deleteChatHistory(currentSessionId.value).catch(() => {})
    }
  }

  async function newConversation() {
    clearMessages()
    await disconnect()
    const projectStore = useProjectStore()
    if (projectStore.currentProject) {
      projectStore.currentProject.agentSessionId = undefined
      projectUpdate(projectStore.currentProject).catch(() => {})
    }
  }

  return {
    // State
    connected,
    agentType,
    capabilities,
    authState,
    messages,
    isGenerating,
    currentSessionId,
    pendingCommandApproval,
    pendingFileApproval,
    pendingGenericApproval,
    agentVersion,
    versionWarning,
    scrollTrigger,
    detectedInstructionsFile,
    selectedModel,
    tokenUsage,
    estimatedCostUsd,
    disconnectReason,
    installStatus,
    sandboxMode,
    approvalPolicy,
    availableModels,
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
    handleCommandOutputDelta,
    handleItemCompleted,
    handleAuthUpdated,
    handleTokenUsage,
    handleDisconnect,
  }
})
