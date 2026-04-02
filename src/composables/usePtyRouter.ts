import { listen } from '@tauri-apps/api/event'

type OutputHandler = (data: string) => void
type ExitHandler = (code: number) => void

const outputHandlers = new Map<string, OutputHandler>()
const exitHandlers = new Map<string, ExitHandler>()
const globalExitListeners: ((id: string, code: number) => void)[] = []

let initialized = false

async function init() {
  if (initialized) return
  initialized = true

  await listen<{ id: string; data: string }>('pty_output', (event) => {
    outputHandlers.get(event.payload.id)?.(event.payload.data)
  })

  await listen<{ id: string; code: number }>('pty_exit', (event) => {
    const { id, code } = event.payload
    exitHandlers.get(id)?.(code)
    for (const listener of globalExitListeners) {
      listener(id, code)
    }
  })
}

function register(ptyId: string, onOutput: OutputHandler, onExit: ExitHandler) {
  outputHandlers.set(ptyId, onOutput)
  exitHandlers.set(ptyId, onExit)
}

function unregister(ptyId: string) {
  outputHandlers.delete(ptyId)
  exitHandlers.delete(ptyId)
}

function onGlobalExit(listener: (id: string, code: number) => void): () => void {
  globalExitListeners.push(listener)
  return () => {
    const idx = globalExitListeners.indexOf(listener)
    if (idx !== -1) globalExitListeners.splice(idx, 1)
  }
}

export const ptyRouter = { init, register, unregister, onGlobalExit }
