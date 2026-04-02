import { listen } from '@tauri-apps/api/event'

type OutputHandler = (data: string) => void
type ExitHandler = () => void

const outputHandlers = new Map<string, OutputHandler>()
const exitHandlers = new Map<string, ExitHandler>()

let initialized = false

async function init() {
  if (initialized) return
  initialized = true

  await listen<{ streamId: string; data: string }>('docker_log_output', (event) => {
    outputHandlers.get(event.payload.streamId)?.(event.payload.data)
  })

  await listen<{ streamId: string }>('docker_log_exit', (event) => {
    exitHandlers.get(event.payload.streamId)?.()
  })
}

function register(streamId: string, onOutput: OutputHandler, onExit: ExitHandler) {
  outputHandlers.set(streamId, onOutput)
  exitHandlers.set(streamId, onExit)
}

function unregister(streamId: string) {
  outputHandlers.delete(streamId)
  exitHandlers.delete(streamId)
}

export const dockerLogRouter = { init, register, unregister }
