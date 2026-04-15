/**
 * Event router for the unified agent API.
 *
 * Listens for `agent://` prefixed Tauri events and dispatches them
 * to the agent store. Works with any agent runtime (Codex, Claude Code, etc.).
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { resolveNotifier } from '../lib/notify'
import { useAgentStore } from '../stores/agent'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import type { AgentAuthState } from '../types/agent'
import type { AgentChatTab } from '../types/tab'

function isAgentTabVisible(): boolean {
  const activeTab = useTabStore().activeTab
  return activeTab?.kind === 'agent-chat' && document.visibilityState === 'visible' && document.hasFocus()
}

function findAgentTab(): AgentChatTab | undefined {
  return useTabStore().tabs.find((t): t is AgentChatTab => t.kind === 'agent-chat')
}

function markAgentActivity() {
  const tab = findAgentTab()
  if (tab && tab.id !== useTabStore().activeTabId) {
    tab.hasActivity = true
  }
}

function focusAgentTab() {
  const tab = findAgentTab()
  if (tab) {
    const win = getCurrentWindow()
    win.unminimize().catch(() => {})
    win.setFocus().catch(() => {})
    useTabStore().setActiveTab(tab.id)
  }
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
  let lastDeltaKey = ''
  let lastDeltaTime = 0

  await win.listen<{ type: string; delta: string; itemId: string | null }>('agent://message-delta', (event) => {
    const p = event.payload
    const key = `${p.itemId ?? ''}:${p.delta}`
    const now = Date.now()
    if (key === lastDeltaKey && now - lastDeltaTime < 50) return
    lastDeltaKey = key
    lastDeltaTime = now
    agent.handleMessageDelta(p.delta)
  })

  // --- Turn lifecycle ---
  await win.listen('agent://turn-started', () => {
    agent.isGenerating = true
  })

  await win.listen('agent://turn-completed', () => {
    agent.handleTurnCompleted()
    if (settings.codexNotification && !isAgentTabVisible()) {
      markAgentActivity()
      notify?.('Agent', 'Turn completed', focusAgentTab)
    }
  })

  // --- Item lifecycle ---
  await win.listen<{ type: string; itemType: string; itemId: string; data: Record<string, unknown> }>(
    'agent://item-started',
    (event) => {
      const p = event.payload
      const data: Record<string, unknown> = { ...p.data }

      // Extract common fields from ACP data
      if (p.itemType === 'fileChange') {
        const changes = data.changes as Array<Record<string, unknown>> | undefined
        const filePath = (changes?.[0]?.path as string | undefined) ?? (data.filePath as string | undefined)
        data.filePath = filePath
        // Backfill filePath on pending approval
        const pending = agent.pendingFileApproval
        if (pending && pending.itemId === p.itemId && !pending.filePath && filePath) {
          pending.filePath = filePath
        }
      } else if (p.itemType === 'commandExecution') {
        // Extract command from tool_arguments for ACP
        if (!data.command && data.tool_arguments) {
          const args = data.tool_arguments as Record<string, unknown>
          data.command = args.command as string | undefined
        }
      }

      agent.handleItemStarted({
        type: p.itemType,
        id: p.itemId,
        data,
        completed: false,
      })
    },
  )

  await win.listen<{ type: string; itemId: string; data: Record<string, unknown> }>(
    'agent://item-completed',
    (event) => {
      const p = event.payload
      const completedData: Record<string, unknown> = {}

      // Extract known completion fields
      if (p.data.exitCode !== undefined) completedData.exitCode = p.data.exitCode
      if (p.data.text !== undefined) completedData.text = p.data.text
      if (p.data.summary !== undefined) completedData.summary = p.data.summary
      if (p.data.filePath !== undefined) completedData.filePath = p.data.filePath
      if (p.data.additions !== undefined) completedData.additions = p.data.additions
      if (p.data.deletions !== undefined) completedData.deletions = p.data.deletions

      agent.handleItemCompleted(p.itemId, completedData)
    },
  )

  // --- Command output ---
  await win.listen<{ type: string; itemId: string; delta: string }>('agent://command-output-delta', (event) => {
    agent.handleCommandOutputDelta(event.payload.itemId, event.payload.delta)
  })

  // --- Approval requests ---
  await win.listen<Record<string, unknown>>('agent://approval-command', (event) => {
    const p = event.payload
    agent.pendingCommandApproval = {
      requestId: p.requestId,
      itemId: (p.itemId as string) ?? '',
      command: (p.command as string) ?? null,
      cwd: (p.cwd as string) ?? null,
      payload: (p.payload as Record<string, unknown>) ?? {},
    }
    if (settings.codexNotification && !isAgentTabVisible()) {
      markAgentActivity()
      notify?.('Agent', `Approval required: ${(p.command as string) ?? 'action'}`, focusAgentTab)
    }
  })

  await win.listen<Record<string, unknown>>('agent://approval-file', (event) => {
    const p = event.payload
    const itemId = (p.itemId as string) ?? ''
    // Look up filePath from matching item
    const msgs = agent.messages
    let fileItem: Record<string, unknown> | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== 'agent') continue
      fileItem = msgs[i].items.find((it) => it.id === itemId)?.data
      if (fileItem) break
    }
    const filePath = (p.filePath as string) ?? (fileItem?.filePath as string) ?? null
    agent.pendingFileApproval = {
      requestId: p.requestId,
      itemId,
      filePath,
      reason: (p.reason as string) ?? null,
      payload: (p.payload as Record<string, unknown>) ?? {},
    }
    if (settings.codexNotification && !isAgentTabVisible()) {
      markAgentActivity()
      const desc = filePath ? `File change: ${filePath}` : 'File change approval required'
      notify?.('Agent', desc, focusAgentTab)
    }
  })

  await win.listen<Record<string, unknown>>('agent://approval-generic', (event) => {
    const p = event.payload
    agent.pendingGenericApproval = {
      requestId: p.requestId,
      toolName: (p.toolName as string) ?? 'unknown',
      toolArguments: (p.toolArguments as Record<string, unknown>) ?? {},
      options: (p.options as string[]) ?? [],
      payload: (p.payload as Record<string, unknown>) ?? {},
    }
    if (settings.codexNotification && !isAgentTabVisible()) {
      markAgentActivity()
      notify?.('Agent', `Permission required: ${p.toolName}`, focusAgentTab)
    }
  })

  // --- Auth ---
  await win.listen<{ type: string; state: AgentAuthState }>('agent://auth-updated', (event) => {
    const state = event.payload.state
    if (state) {
      agent.handleAuthUpdated(state)
    }
    // If state is 'unknown', re-fetch (triggered by login/completed)
    if (state?.status === 'unknown') {
      import('../lib/tauri').then(({ agentAuthStatus }) => {
        agentAuthStatus()
          .then((s) => agent.handleAuthUpdated(s))
          .catch(() => {})
      })
    }
  })

  // --- Token usage ---
  await win.listen<{ type: string; input: number; output: number }>('agent://token-usage', (event) => {
    agent.handleTokenUsage({
      input: event.payload.input ?? 0,
      output: event.payload.output ?? 0,
    })
  })

  // --- Disconnect ---
  await win.listen<{ type: string; reason: string }>('agent://disconnect', (event) => {
    const reason = event.payload?.reason ?? 'unknown'
    console.warn('[agent-event] disconnect:', reason)
    agent.handleDisconnect(reason)
  })

  // --- Error ---
  await win.listen<{ type: string; message: string }>('agent://error', (event) => {
    console.error('[agent-event] error', event.payload)
  })
}
