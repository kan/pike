import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCodexStore } from '../stores/codex'
import type { CodexAuthState } from '../types/codex'

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
  const win = getCurrentWindow()

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
  await win.listen('codex://turn/completed', (event) => {
    console.log('[codex-event] turn/completed', event.payload)
    codex.handleTurnCompleted()
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
      codex.handleItemStarted({
        type: (item.type as string) ?? 'unknown',
        id: (item.id as string) ?? '',
        data: {
          command: item.command as string | undefined,
          status: item.status as string | undefined,
        },
        completed: false,
      })
    }
  })

  await win.listen<Record<string, unknown>>('codex://item/completed', (event) => {
    const p = event.payload
    const item = p.item as Record<string, unknown> | undefined
    if (item) {
      codex.handleItemCompleted((item.id as string) ?? '', {
        exitCode: item.exitCode as number | undefined,
        text: item.text as string | undefined,
      })
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
    console.log('[codex-event] approval/command', event.payload)
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
  })

  await win.listen<Record<string, unknown>>('codex://approval/file', (event) => {
    console.log('[codex-event] approval/file', event.payload)
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
  })

  // --- Error ---
  await win.listen<{ message?: string }>('codex://error', (event) => {
    console.error('[codex-event] error', event.payload)
  })
}
