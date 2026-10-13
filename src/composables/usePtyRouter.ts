import { listen } from '@tauri-apps/api/event'
import { ptyHold } from '../lib/tauri'

type OutputHandler = (data: string) => void
type ExitHandler = (code: number) => void

const outputHandlers = new Map<string, OutputHandler>()
const exitHandlers = new Map<string, ExitHandler>()
/** `hold` が待っている「預かり始めた」印（#469）。pty の id → 待ちを解く関数。 */
const heldWaiters = new Map<string, () => void>()

/**
 * 印を待つのをやめるまで。印は先に出た出力の後ろに並ぶので、出力が流れ続けている
 * ターミナルでは遅れる。**待ち切れなかったことは呼び出し側へ返す**（`hold` の戻り値）:
 * 届いたことにして進むと、まだ途中の出力が画面にも預かりにも入らず欠ける。
 */
const HOLD_TIMEOUT_MS = 10_000

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

  await listen<string>('pty_held', (event) => {
    heldWaiters.get(event.payload)?.()
  })
}

/**
 * pty の出力と終了の受け口を登録する。**`pty_spawn` を頼む前に呼ぶこと**（#459）: 受け口の
 * 無い id に届いたものは捨てるので、起動してから登録すると最初の出力を取りこぼす。pty の id は
 * 呼び出し側が決めて `pty_spawn` に渡す（`TerminalTab.vue`）。
 */
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

/**
 * 出力を Rust に預からせ、**それより前の出力がこのウィンドウへ届き終わるまで待つ**（#469。
 * プロジェクトを別のウィンドウへ移す前）。
 *
 * コマンドの戻りを待つだけでは足りない。出力はイベントで届き、戻り値とは別の経路なので、
 * 戻った時点でまだ途中の出力がありうる。Rust は預かり始めた印（`pty_held`）を**出力と同じ
 * 経路で、最後の出力のあとに**送るので、それを待てば画面を書き出してよい。
 *
 * 戻り値は「全部の印が届いたか」。偽でも Rust は預かり始めているので、呼び出し側は
 * やめるなら `ptyResume` で戻す。
 */
async function hold(ptyIds: string[]): Promise<boolean> {
  const marks = ptyIds.map(
    (id) =>
      new Promise<boolean>((resolve) => {
        const done = (arrived: boolean) => {
          heldWaiters.delete(id)
          clearTimeout(timer)
          resolve(arrived)
        }
        const timer = setTimeout(() => done(false), HOLD_TIMEOUT_MS)
        heldWaiters.set(id, () => done(true))
      }),
  )
  await ptyHold(ptyIds)
  return (await Promise.all(marks)).every(Boolean)
}

export const ptyRouter = { init, register, unregister, feed, hold }
