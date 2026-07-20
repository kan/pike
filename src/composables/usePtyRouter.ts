import { listen } from '@tauri-apps/api/event'

type OutputHandler = (data: string) => void
type ExitHandler = (code: number) => void

const outputHandlers = new Map<string, OutputHandler>()
const exitHandlers = new Map<string, ExitHandler>()

let initialized = false

async function init() {
  if (initialized) return
  initialized = true

  await listen<{ id: string; data: string }>('pty_output', (event) => {
    const { id, data } = event.payload
    outputHandlers.get(id)?.(data)
  })

  await listen<{ id: string; code: number }>('pty_exit', (event) => {
    const { id, code } = event.payload
    exitHandlers.get(id)?.(code)
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

// 登録済みハンドラへ出力を直接配送する（pty_output イベントと同じ経路）。
// E2E 撮影 (#142) で pty_spawn をモックし実プロセスなしにターミナルへ合成出力を
// 流すために使う。通常運用では呼ばれない。
function feed(ptyId: string, data: string): void {
  outputHandlers.get(ptyId)?.(data)
}

export const ptyRouter = { init, register, unregister, feed }
