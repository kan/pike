import { getCurrentWindow } from '@tauri-apps/api/window'
import { resolveNotifier } from '../lib/notify'
import { useCodexStore } from '../stores/codex'
import { useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'
import type { CodexAuthState } from '../types/codex'
import type { CodexChatTab } from '../types/tab'

function isCodexTabVisible(): boolean {
  const activeTab = useTabStore().activeTab
  return activeTab?.kind === 'codex-chat' && document.visibilityState === 'visible' && document.hasFocus()
}

function findCodexTab(): CodexChatTab | undefined {
  return useTabStore().tabs.find((t): t is CodexChatTab => t.kind === 'codex-chat')
}

function markCodexActivity() {
  const tab = findCodexTab()
  if (tab && tab.id !== useTabStore().activeTabId) {
    tab.hasActivity = true
  }
}

function focusCodexTab() {
  const tab = findCodexTab()
  if (tab) {
    const win = getCurrentWindow()
    win.unminimize().catch(() => {})
    win.setFocus().catch(() => {})
    useTabStore().setActiveTab(tab.id)
  }
}

function parseAccountUpdated(params: Record<string, unknown>): CodexAuthState {
  const account = params.account as Record<string, unknown> | undefined
  if (!account) return { status: 'unauthenticated' }
  const accountType = account.type as string | undefined
  if (accountType === 'chatgpt') {
    return {
      status: 'authenticated',
      mode: 'chatgpt',
      planType: (account.planType as string) ?? null,
      email: (account.email as string) ?? null,
    }
  }
  if (accountType === 'apiKey') {
    return { status: 'authenticated', mode: 'apiKey', planType: null, email: null }
  }
  return { status: 'unauthenticated' }
}

let initialized = false

export async function initCodexRouter() {
  if (initialized) return
  initialized = true

  const codex = useCodexStore()
  const settings = useSettingsStore()
  const win = getCurrentWindow()
  const notify = await resolveNotifier()

  // --- Streaming text delta (v2) ---
  // Codex sends both v1 (codex/event/agent_message_content_delta) and v2
  // (item/agentMessage/delta) notifications with the same delta. On WSL (v0.118.0)
  // this causes doubled text. Deduplicate by tracking recent deltas.
  let lastDeltaKey = ''
  let lastDeltaTime = 0

  await win.listen<{ delta: string; itemId: string }>('codex://item/agentMessage/delta', (event) => {
    const key = `${event.payload.itemId}:${event.payload.delta}`
    const now = Date.now()
    if (key === lastDeltaKey && now - lastDeltaTime < 50) return
    lastDeltaKey = key
    lastDeltaTime = now
    codex.handleMessageDelta(event.payload.delta)
  })

  // --- Turn lifecycle (v2) ---
  await win.listen('codex://turn/completed', () => {
    codex.handleTurnCompleted()
    if (settings.codexNotification && !isCodexTabVisible()) {
      markCodexActivity()
      notify?.('Codex', 'Turn completed', focusCodexTab)
    }
  })

  await win.listen('codex://turn/started', (event) => {
    console.log('[codex-event] turn/started', event.payload)
    codex.isGenerating = true
  })

  // --- Turn lifecycle (v1 fallback) ---
  await win.listen('codex://codex/event/task_completed', (event) => {
    console.log('[codex-event] task_completed (v1 fallback)', event.payload)
    codex.handleTurnCompleted()
  })

  // --- Item lifecycle (v2) ---
  await win.listen<Record<string, unknown>>('codex://item/started', (event) => {
    const p = event.payload
    const item = p.item as Record<string, unknown> | undefined
    if (item) {
      const type = (item.type as string) ?? 'unknown'
      const data: Record<string, unknown> = {
        command: item.command as string | undefined,
        status: item.status as string | undefined,
      }
      if (type === 'fileChange') {
        data.filePath = item.filePath as string | undefined
        data.reason = item.reason as string | undefined
      } else if (type === 'reasoning') {
        data.summary = item.summary as string | undefined
      }
      codex.handleItemStarted({ type, id: (item.id as string) ?? '', data, completed: false })
    }
  })

  await win.listen<Record<string, unknown>>('codex://item/completed', (event) => {
    const p = event.payload
    const item = p.item as Record<string, unknown> | undefined
    if (item) {
      const completedData: Record<string, unknown> = {
        exitCode: item.exitCode as number | undefined,
        text: item.text as string | undefined,
      }
      if (item.type === 'reasoning') {
        completedData.summary = item.summary as string | undefined
      }
      if (item.type === 'fileChange') {
        completedData.filePath = item.filePath as string | undefined
        completedData.additions = item.additions as number | undefined
        completedData.deletions = item.deletions as number | undefined
      }
      codex.handleItemCompleted((item.id as string) ?? '', completedData)
    }
  })

  // --- Command execution output ---
  await win.listen<{ delta: string; itemId: string }>('codex://item/commandExecution/outputDelta', (event) => {
    codex.handleCommandOutputDelta(event.payload.itemId, event.payload.delta)
  })

  // --- Item lifecycle (v1 fallback) ---
  await win.listen<Record<string, unknown>>('codex://codex/event/item_completed', (event) => {
    const p = event.payload
    const msg = p.msg as Record<string, unknown> | undefined
    const item = msg?.item as Record<string, unknown> | undefined
    if (item) {
      codex.handleItemCompleted((item.id as string) ?? '')
    }
  })

  // --- Auth ---
  await win.listen<Record<string, unknown>>('codex://account/updated', (event) => {
    const state = parseAccountUpdated(event.payload)
    codex.handleAuthUpdated(state)
  })

  await win.listen('codex://account/login/completed', async () => {
    try {
      const { codexAuthStatus } = await import('../lib/tauri')
      codex.handleAuthUpdated(await codexAuthStatus())
    } catch {
      // ignore
    }
  })

  // --- Approval requests ---
  await win.listen<Record<string, unknown>>('codex://approval/command', (event) => {
    const p = event.payload
    codex.pendingCommandApproval = {
      requestId: p.requestId as number | string,
      itemId: (p.itemId as string) ?? '',
      threadId: (p.threadId as string) ?? '',
      turnId: (p.turnId as string) ?? '',
      command: (p.command as string) ?? null,
      cwd: (p.cwd as string) ?? null,
      environment: (p.environment as string) ?? '',
      sandboxTrusted: p.sandboxTrusted !== false,
    }
    if (settings.codexNotification && !isCodexTabVisible()) {
      markCodexActivity()
      notify?.('Codex', `Approval required: ${(p.command as string) ?? 'command'}`, focusCodexTab)
    }
  })

  await win.listen<Record<string, unknown>>('codex://approval/file', (event) => {
    const p = event.payload
    codex.pendingFileApproval = {
      requestId: p.requestId as number | string,
      itemId: (p.itemId as string) ?? '',
      threadId: (p.threadId as string) ?? '',
      turnId: (p.turnId as string) ?? '',
      reason: (p.reason as string) ?? null,
      environment: (p.environment as string) ?? '',
      sandboxTrusted: p.sandboxTrusted !== false,
    }
    if (settings.codexNotification && !isCodexTabVisible()) {
      markCodexActivity()
      notify?.('Codex', 'File change approval required', focusCodexTab)
    }
  })

  // --- Token usage ---
  await win.listen<Record<string, unknown>>('codex://thread/tokenUsage/updated', (event) => {
    const p = event.payload
    const usage = p.usage as Record<string, unknown> | undefined
    if (usage) {
      codex.handleTokenUsage({
        input: (usage.inputTokens as number) ?? (usage.input as number) ?? 0,
        output: (usage.outputTokens as number) ?? (usage.output as number) ?? 0,
      })
    }
  })

  // --- Disconnect ---
  await win.listen<Record<string, unknown>>('codex://disconnect', (event) => {
    const reason = (event.payload?.reason as string) ?? 'unknown'
    console.warn('[codex-event] disconnect:', reason)
    codex.handleDisconnect(reason)
  })

  // --- Error ---
  await win.listen<{ message?: string }>('codex://error', (event) => {
    console.error('[codex-event] error', event.payload)
  })
}
