/**
 * Event router for the unified agent API.
 *
 * Listens for `agent://` prefixed Tauri events and dispatches them
 * to the correct per-tab session in the agent store via `tabId`.
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { resolveNotifier } from '../lib/notify'
import { useAgentStore } from '../stores/agent'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import type { AgentAuthState, AgentCommandInfo } from '../types/agent'
import type { AgentChatTab } from '../types/tab'

function isAgentTabVisible(tabId: string): boolean {
  const tabStore = useTabStore()
  return tabStore.activeTabId === tabId && document.visibilityState === 'visible' && document.hasFocus()
}

function findAgentTab(tabId: string): AgentChatTab | undefined {
  return useTabStore().tabs.find((t): t is AgentChatTab => t.kind === 'agent-chat' && t.id === tabId)
}

function focusAgentTab(tabId: string) {
  const tab = findAgentTab(tabId)
  if (tab) {
    const win = getCurrentWindow()
    win.unminimize().catch(() => {})
    win.setFocus().catch(() => {})
    useTabStore().setActiveTab(tab.id)
  }
}

// Per-tab dedup state (module scope so cleanupAgentRouterTab can access)
const lastDelta = new Map<string, { key: string; time: number }>()

/** Clean up per-tab router state when a tab is closed. */
export function cleanupAgentRouterTab(tabId: string) {
  lastDelta.delete(tabId)
}

let initialized = false

export async function initAgentRouter() {
  if (initialized) return
  initialized = true

  const agent = useAgentStore()
  const settings = useSettingsStore()
  const tabs = useTabStore()
  const win = getCurrentWindow()
  const notify = await resolveNotifier()

  /** Listen for an agent event, extracting tabId and guarding against missing values. */
  function listenAgent(event: string, handler: (tabId: string, payload: Record<string, unknown>) => void) {
    return win.listen<Record<string, unknown>>(event, (e) => {
      const tabId = (e.payload.tabId as string) ?? null
      if (!tabId) return
      handler(tabId, e.payload)
    })
  }

  /** Send desktop notification if the agent tab is in the background. */
  function notifyIfBackground(tabId: string, description: string) {
    if (settings.codexNotification && !isAgentTabVisible(tabId)) {
      tabs.markTabActivity(tabId)
      notify?.('Agent', description, () => focusAgentTab(tabId))
    }
  }

  // --- Message delta ---
  await listenAgent('agent://message-delta', (tabId, p) => {
    const delta = (p.delta as string) ?? ''
    const itemId = (p.itemId as string) ?? ''

    const key = `${itemId}:${delta}`
    const now = Date.now()
    const prev = lastDelta.get(tabId)
    if (prev && prev.key === key && now - prev.time < 50) return
    lastDelta.set(tabId, { key, time: now })

    agent.handleMessageDelta(tabId, delta)
  })

  // --- Turn lifecycle ---
  await listenAgent('agent://turn-started', (tabId) => {
    const s = agent.getExistingSession(tabId)
    if (s) s.isGenerating = true
  })

  await listenAgent('agent://turn-completed', (tabId) => {
    agent.handleTurnCompleted(tabId)
    notifyIfBackground(tabId, 'Turn completed')
  })

  // --- Item lifecycle ---
  await listenAgent('agent://item-started', (tabId, p) => {
    const itemType = (p.itemType as string) ?? ''
    const itemId = (p.itemId as string) ?? ''
    const data: Record<string, unknown> = { ...(p.data as Record<string, unknown>) }

    if (itemType === 'fileChange') {
      const changes = data.changes as Array<Record<string, unknown>> | undefined
      const filePath = (changes?.[0]?.path as string | undefined) ?? (data.filePath as string | undefined)
      data.filePath = filePath
      const s = agent.getExistingSession(tabId)
      const pending = s?.pendingFileApproval
      if (pending && pending.itemId === itemId && !pending.filePath && filePath) {
        pending.filePath = filePath
      }
    } else if (itemType === 'commandExecution') {
      if (!data.command && data.tool_arguments) {
        const args = data.tool_arguments as Record<string, unknown>
        data.command = args.command as string | undefined
      }
    }

    agent.handleItemStarted(tabId, { type: itemType, id: itemId, data, completed: false })
  })

  await listenAgent('agent://item-completed', (tabId, p) => {
    const itemId = (p.itemId as string) ?? ''
    const pData = (p.data as Record<string, unknown>) ?? {}
    const completedData: Record<string, unknown> = {}

    if (pData.exitCode !== undefined) completedData.exitCode = pData.exitCode
    if (pData.text !== undefined) completedData.text = pData.text
    if (pData.summary !== undefined) completedData.summary = pData.summary
    if (pData.filePath !== undefined) completedData.filePath = pData.filePath
    if (pData.additions !== undefined) completedData.additions = pData.additions
    if (pData.deletions !== undefined) completedData.deletions = pData.deletions

    agent.handleItemCompleted(tabId, itemId, completedData)
  })

  // --- Command output ---
  await listenAgent('agent://command-output-delta', (tabId, p) => {
    agent.handleCommandOutputDelta(tabId, (p.itemId as string) ?? '', (p.delta as string) ?? '')
  })

  // --- Approval requests ---
  await listenAgent('agent://approval-command', (tabId, p) => {
    const s = agent.getExistingSession(tabId)
    if (!s) return
    s.pendingCommandApproval = {
      requestId: p.requestId,
      itemId: (p.itemId as string) ?? '',
      command: (p.command as string) ?? null,
      cwd: (p.cwd as string) ?? null,
      payload: (p.payload as Record<string, unknown>) ?? {},
    }
    notifyIfBackground(tabId, `Approval required: ${(p.command as string) ?? 'action'}`)
  })

  await listenAgent('agent://approval-file', (tabId, p) => {
    const s = agent.getExistingSession(tabId)
    if (!s) return
    const itemId = (p.itemId as string) ?? ''
    let fileItem: Record<string, unknown> | undefined
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].role !== 'agent') continue
      fileItem = s.messages[i].items.find((it) => it.id === itemId)?.data
      if (fileItem) break
    }
    const filePath = (p.filePath as string) ?? (fileItem?.filePath as string) ?? null
    s.pendingFileApproval = {
      requestId: p.requestId,
      itemId,
      filePath,
      reason: (p.reason as string) ?? null,
      payload: (p.payload as Record<string, unknown>) ?? {},
    }
    notifyIfBackground(tabId, filePath ? `File change: ${filePath}` : 'File change approval required')
  })

  await listenAgent('agent://approval-generic', (tabId, p) => {
    const s = agent.getExistingSession(tabId)
    if (!s) return
    s.pendingGenericApproval = {
      requestId: p.requestId,
      toolName: (p.toolName as string) ?? 'unknown',
      toolArguments: (p.toolArguments as Record<string, unknown>) ?? {},
      options: (p.options as string[]) ?? [],
      payload: (p.payload as Record<string, unknown>) ?? {},
    }
    notifyIfBackground(tabId, `Permission required: ${p.toolName}`)
  })

  // --- Auth ---
  await listenAgent('agent://auth-updated', (tabId, p) => {
    const state = p.state as AgentAuthState | undefined
    if (state) {
      agent.handleAuthUpdated(tabId, state)
    }
    if (state?.status === 'unknown') {
      import('../lib/tauri').then(({ agentAuthStatus }) => {
        agentAuthStatus(tabId)
          .then((s) => agent.handleAuthUpdated(tabId, s))
          .catch(() => {})
      })
    }
  })

  // --- Session info (title) ---
  await listenAgent('agent://session-info', (tabId, p) => {
    agent.handleSessionInfo(tabId, (p.title as string) ?? null)
  })

  // --- Available commands (slash commands from ACP) ---
  await listenAgent('agent://available-commands', (tabId, p) => {
    const raw = p.commands as AgentCommandInfo[] | undefined
    if (raw) agent.handleAvailableCommands(tabId, raw)
  })

  // --- Token usage ---
  await listenAgent('agent://token-usage', (tabId, p) => {
    agent.handleTokenUsage(tabId, {
      input: (p.input as number) ?? 0,
      output: (p.output as number) ?? 0,
    })
  })

  // --- Disconnect ---
  await listenAgent('agent://disconnect', (tabId, p) => {
    const reason = (p.reason as string) ?? 'unknown'
    console.warn('[agent-event] disconnect:', tabId, reason)
    agent.handleDisconnect(tabId, reason)
  })

  // --- Error ---
  await listenAgent('agent://error', (tabId, p) => {
    console.error('[agent-event] error', tabId, p)
  })
}
