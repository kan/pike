/**
 * エージェントの入力待ち / ターンの完了を受けて知らせる（#265）。
 *
 * 出所は Claude Code の hook（`Notification` / `Stop`）で、経路は
 * `pike agent-hook --event=…` → WM_COPYDATA → Rust の `agent_hook::try_handle_notice`
 * → このウィンドウへの `agent_notice`。**判断の正本は `src-tauri/src/agent_hook.rs` の
 * モジュール doc**（なぜ配送が WM_COPYDATA で、なぜ Windows 限定か）。
 *
 * ここが持つのは「受け取ったあとどうするか」だけ:
 *
 * - **デスクトップ通知は出さない。** Windows で押せるトーストを出すには AppUserModelID を
 *   書いたショートカットの登録が要り、それが無いと「クリックが届かず、バナーも出ずに
 *   通知センターへ直行する」ことを実機で確かめた。**代わりにタスクバーを点滅させる**
 *   （`windowFlash`）。押せば OS がそのウィンドウを前に出し、そこから先は画面内の印が導く
 * - **見えているものには何もしない。** そのウィンドウがアクティブで、かつそのタブが
 *   描かれているなら、エージェントのプロンプトは既に目の前にある
 * - **印はタブに立てる**（`awaitingInput`）。プロジェクト単位の緑のドットはその集約
 *   （`tabStore.awaitingProjectIds`）で、消す処理を別に持たない
 */

import { getCurrentWindow } from '@tauri-apps/api/window'
import { watch } from 'vue'
import type { AgentId } from '../lib/agents'
import { windowFlash } from '../lib/tauri'
import { windowFocused } from '../lib/window'
import { type AgentNotifyMode, useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'

/** Rust の `AgentNotice`（`agent_hook.rs`）。 */
interface AgentNotice {
  ptyId: string
  /** 表の id（`AgentId`）。**送り側が名乗る**ので、`AGENTS` に無い綴りは届かない。 */
  agent: AgentId
  event: 'waiting' | 'done'
}

let initialized = false

export async function initAgentNotice() {
  if (initialized) return
  initialized = true
  // **「オフ」にしたら、既に立っている印も下ろす。** 設定の説明（と マニュアル）が
  // 「何もしません（点も付きません）」と言っているので、切り替えた瞬間に消える必要が
  // ある。下の `handleNotice` は `off` で早期 return するため、そこには置けない。
  watch(
    () => useSettingsStore().agentNotify,
    (mode) => {
      if (mode === 'off') useTabStore().clearAllAwaiting()
    },
  )
  // **このウィンドウ宛てだけ受ける**（`useCliOpen` と同じ規約）。Rust は pty id から
  // ウィンドウを引いて `emit_to` するので、素の `listen`（target = Any）だと全ウィンドウが
  // 同じ知らせを受ける。
  await getCurrentWindow().listen<AgentNotice>('agent_notice', (event) => {
    void handleNotice(event.payload)
  })
}

async function handleNotice(notice: AgentNotice) {
  const mode = useSettingsStore().agentNotify
  // **`off` は機能ごと止める**（印も出さない）。設定の名前が言っているとおりに振る舞う。
  // hook は登録したままなので、戻せばすぐ効く（登録は #299 の申告にも要る）。
  if (mode === 'off') return

  const tabStore = useTabStore()
  const tab = tabStore.terminalByPty(notice.ptyId)
  if (!tab) return

  const waiting = notice.event === 'waiting'
  const known = tab.awaitingInput === true
  // 目の前にあるなら印は要らない（画面にプロンプトが出ている）。
  const seen = windowFocused.value && tabStore.isTabVisible(tab.id)
  // **印の更新は早期 return より前に置く。** 「見えているから何もしない」で先に返すと、
  // ターンの終わり（`done`）で下ろす経路まで飛ばしてしまい、立った印が残る。すると
  // `known` が真のまま固定され、**そのターミナルでは二度と知らせが出なくなる**（同時に
  // プロジェクト側の緑のドットも消えない）。**`all` でなくても下ろす**: 印が言うのは
  // 「待っている」ことなので、知らせるかどうかとは別。
  tabStore.markTabAwaiting(tab.id, waiting && !seen)
  if (seen || !shouldFlash(mode, waiting, known)) return

  await windowFlash().catch((e: unknown) => console.error('[agent-notice] flash failed:', e))
}

/**
 * **同じ待ちで 2 度光らせない。** 権限の確認が続けて出ると `Notification` も続けて来るが、
 * まだ答えていないのだから知らせ直す意味が無い（`markTabActivity` と同じ判断）。
 */
function shouldFlash(mode: AgentNotifyMode, waiting: boolean, known: boolean): boolean {
  return waiting ? !known : mode === 'all'
}
