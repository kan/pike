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
import type { AgentAuthState } from '../types/agent'
import type { AgentChatTab } from '../types/tab'

function isAgentTabVisible(tabId: string): boolean {
  const tabStore = useTabStore()
  return tabStore.activeTabId === tabId && document.visibilityState === 'visible' && document.hasFocus()
}

function findAgentTab(tabId: string): AgentChatTab | undefined {
  return useTabStore().tabs.find((t): t is AgentChatTab => t.kind === 'agent-chat' && t.id === tabId)
}

function markAgentActivity(tabId: string) {
  const tab = findAgentTab(tabId)
  if (tab && tab.id !== useTabStore().activeTabId) {
    tab.hasActivity = true
  }
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

/** Extract tabId from an event payload (added by Rust TabEvent wrapper). */
function extractTabId(payload: Record<string, unknown>): string | null {
  return (payload.tabId as string) ?? null
}

let initialized = false

export async function initAgentRouter() {
  if (initialized) return
  initialized = true

  const agent = useAgentStore()
  const settings = useSettingsStore()
  const win = getCurrentWindow()
  const notify = await resolveNotifier()

  // --- Message delta ---
  // Per-tab dedup state
  const lastDelta = new Map<string, { key: string; time: number }>()

  await win.listen<Record<string, unknown>>('agent://message-delta', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
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
  await win.listen<Record<string, unknown>>('agent://turn-started', (event) => {
    const tabId = extractTabId(event.payload)
    if (!tabId) return
    const s = agent.getExistingSession(tabId)
    if (s) s.isGenerating = true
  })

  await win.listen<Record<string, unknown>>('agent://turn-completed', (event) => {
    const tabId = extractTabId(event.payload)
    if (!tabId) return
    agent.handleTurnCompleted(tabId)
    if (settings.codexNotification && !isAgentTabVisible(tabId)) {
      markAgentActivity(tabId)
      notify?.('Agent', 'Turn completed', () => focusAgentTab(tabId))
    }
  })

  // --- Item lifecycle ---
  await win.listen<Record<string, unknown>>('agent://item-started', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
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

    agent.handleItemStarted(tabId, {
      type: itemType,
      id: itemId,
      data,
      completed: false,
    })
  })

  await win.listen<Record<string, unknown>>('agent://item-completed', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
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
  await win.listen<Record<string, unknown>>('agent://command-output-delta', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
    agent.handleCommandOutputDelta(tabId, (p.itemId as string) ?? '', (p.delta as string) ?? '')
  })

  // --- Approval requests ---
  await win.listen<Record<string, unknown>>('agent://approval-command', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
    const s = agent.getExistingSession(tabId)
    if (!s) return
    s.pendingCommandApproval = {
      requestId: p.requestId,
      itemId: (p.itemId as string) ?? '',
      command: (p.command as string) ?? null,
      cwd: (p.cwd as string) ?? null,
      payload: (p.payload as Record<string, unknown>) ?? {},
    }
    if (settings.codexNotification && !isAgentTabVisible(tabId)) {
      markAgentActivity(tabId)
      notify?.('Agent', `Approval required: ${(p.command as string) ?? 'action'}`, () => focusAgentTab(tabId))
    }
  })

  await win.listen<Record<string, unknown>>('agent://approval-file', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
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
    if (settings.codexNotification && !isAgentTabVisible(tabId)) {
      markAgentActivity(tabId)
      const desc = filePath ? `File change: ${filePath}` : 'File change approval required'
      notify?.('Agent', desc, () => focusAgentTab(tabId))
    }
  })

  await win.listen<Record<string, unknown>>('agent://approval-generic', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
    const s = agent.getExistingSession(tabId)
    if (!s) return
    s.pendingGenericApproval = {
      requestId: p.requestId,
      toolName: (p.toolName as string) ?? 'unknown',
      toolArguments: (p.toolArguments as Record<string, unknown>) ?? {},
      options: (p.options as string[]) ?? [],
      payload: (p.payload as Record<string, unknown>) ?? {},
    }
    if (settings.codexNotification && !isAgentTabVisible(tabId)) {
      markAgentActivity(tabId)
      notify?.('Agent', `Permission required: ${p.toolName}`, () => focusAgentTab(tabId))
    }
  })

  // --- Auth ---
  await win.listen<Record<string, unknown>>('agent://auth-updated', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
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

  // --- Token usage ---
  await win.listen<Record<string, unknown>>('agent://token-usage', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
    agent.handleTokenUsage(tabId, {
      input: (p.input as number) ?? 0,
      output: (p.output as number) ?? 0,
    })
  })

  // --- Disconnect ---
  await win.listen<Record<string, unknown>>('agent://disconnect', (event) => {
    const p = event.payload
    const tabId = extractTabId(p)
    if (!tabId) return
    const reason = (p.reason as string) ?? 'unknown'
    console.warn('[agent-event] disconnect:', tabId, reason)
    agent.handleDisconnect(tabId, reason)
  })

  // --- Error ---
  await win.listen<Record<string, unknown>>('agent://error', (event) => {
    console.error('[agent-event] error', event.payload)
  })
}
