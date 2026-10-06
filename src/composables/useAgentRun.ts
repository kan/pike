/**
 * ターミナルで動くエージェントの状態を受け取る（#437）。
 *
 * 出所は Pike が同梱する Claude Code の mod で、経路は入力待ちの知らせ（`useAgentNotice`）と
 * 同じ（`pike agent-hook --state=…` → WM_COPYDATA → Rust の `agent_hook::try_handle_notice`
 * → このウィンドウへの `agent_state`）。**判断の正本は `src-tauri/src/agent_hook.rs` の
 * `StateKind`**（何を状態として持ち、何を持たないか）。
 *
 * ここが持つのは 2 つ:
 *
 * - **タブへ写す**（`TerminalTab.agentRun`）。タブバーの印と、エージェント状態タブの一覧が
 *   それを読む。**報告は起きた順に届く**（mod が 1 本ずつ送る。`register.ts` の `enqueue`）
 *   ので、ここでは順序を疑わない
 * - **mod が動いていないことに気付く**（`expectAgentReport`）。mod を読み込ませる設定の
 *   あいだは hook の登録を提案しない（`useAgentHookPrompt`）ので、その代わりの入口
 */

import { getCurrentWindow } from '@tauri-apps/api/window'
import { type AgentId, agentById, commandMentionsAgent } from '../lib/agents'
import { ptyIsBusy } from '../lib/tauri'
import { useTabStore } from '../stores/tabs'
import type { AgentRun } from '../types/tab'
import { type HookPlace, modCarriesHooks, offerAgentHook } from './useAgentHookPrompt'

/** Rust の `AgentState`（`agent_hook.rs`）。 */
interface AgentStateReport {
  ptyId: string
  agent: AgentId
  /** 綴りの正本は Rust の `StateKind`。 */
  state: 'session' | 'running' | 'waiting' | 'idle' | 'ended'
  sessionId: string | null
  context: NonNullable<AgentRun['context']> | null
}

/**
 * 起動してから、mod の報告が無いと見なすまでの時間。**報告はセッションの開始と同時に来る**
 * （`SessionStart`）ので、足りないのは claude の起動と、その前に出る確認（フォルダを
 * 信頼するか、など）に答える時間だけ。
 */
const REPORT_GRACE_MS = 60_000

/**
 * 状態の報告が 1 度でも届いたターミナル（pty id）。**`agentRun` の有無では代用できない**:
 * あちらはセッションが終われば下りるので、「報告が来てから終わった」と「一度も来て
 * いない」を見分けられない。
 */
const reported = new Set<string>()

let initialized = false

export async function initAgentRun() {
  if (initialized) return
  initialized = true
  // **このウィンドウ宛てだけ受ける**（`useAgentNotice` と同じ規約。Rust が pty id から
  // ウィンドウを引いて `emit_to` する）。
  await getCurrentWindow().listen<AgentStateReport>('agent_state', (event) => {
    applyState(event.payload)
  })
}

function applyState(report: AgentStateReport) {
  reported.add(report.ptyId)
  const tabStore = useTabStore()
  const tab = tabStore.terminalByPty(report.ptyId)
  if (!tab) return
  // **許可の確認に答えが出たら、「まだ見ていない」印も下ろす。** 待ちの表示は印と状態を
  // 合わせて読む（`isAgentWaiting`）ので、印だけ残ると、進み出したあとも待っていると出る
  // （分割して見えているタブで答えた場合など、タブを選び直さない経路がある）。
  if (tab.agentRun?.phase === 'waiting' && report.state !== 'waiting') tabStore.markTabAwaiting(tab.id, false)
  tabStore.setAgentRun(tab.id, nextRun(tab.agentRun, report))
}

function nextRun(prev: AgentRun | undefined, report: AgentStateReport): AgentRun | undefined {
  switch (report.state) {
    case 'ended':
      return undefined
    case 'session':
      // **いまの状態は引き継ぐ。** `SessionStart` はターンの途中にも来る（自動の圧縮）。
      // コンテキストは捨てる: 新しいセッションでも圧縮のあとでも、前の値はもう違う。
      return { agent: report.agent, sessionId: report.sessionId ?? undefined, phase: prev?.phase ?? 'idle' }
    case 'running':
    case 'waiting':
      return { ...prev, agent: report.agent, phase: report.state }
    case 'idle':
      return { ...prev, agent: report.agent, phase: 'idle', context: report.context ?? prev?.context }
  }
}

/**
 * Pike が起動したエージェントから、mod の報告が届くかを見張る。届かなければ hook の登録を
 * 提案する（古い Claude Code、`disableAllHooks`、組織のポリシーで mod が止まる環境）。
 *
 * **見張るのは Pike が起動したものだけ**（起動ボタン、固定タブの `autoStart`）。手で打った
 * `claude` は、いつ起動したかを Pike が知らない。その場合の入口は設定画面に残っている。
 *
 * 提案そのものはシェルごとに 1 度きり（`offerAgentHook` の記録）なので、ここが何度呼んでも
 * 聞き直しにはならない。**だからこそ誤って聞かない**: 1 度きりの機会を、mod とは関係の
 * ない理由で使い切ると、本当に動かないときに出なくなる。
 *
 * - `modLoaded` は**そのターミナルを開いたときに** mod を読み込ませたか。設定は次に開く
 *   ターミナルからしか効かないので、今の設定値で見ると、オフのときに開いたターミナルで
 *   必ず聞くことになる
 * - 時間が来たとき、そのシェルで何も動いていなければ聞かない（`command not found` や、
 *   すぐに抜けた場合。claude が動いていない以上、報告が無いのは mod のせいではない）
 *
 * **残る誤検出は、起動時の確認（フォルダを信頼するか、ログイン）で `REPORT_GRACE_MS` より
 * 長く止まった場合。** claude は動いているので上の 2 つでは見分けられない。
 */
export function expectAgentReport(ptyId: string, command: string, modLoaded: boolean, place: HookPlace) {
  if (!modLoaded || !modCarriesHooks() || reported.has(ptyId)) return
  // mod を持つのは Claude Code だけ。他のエージェントの起動では何も待たない。
  const claude = agentById('claude')
  if (!claude || !commandMentionsAgent(command, claude)) return
  setTimeout(() => {
    void offerIfUnreported(ptyId, place)
  }, REPORT_GRACE_MS)
}

async function offerIfUnreported(ptyId: string, place: HookPlace) {
  if (reported.has(ptyId)) return
  const tab = useTabStore().terminalByPty(ptyId)
  if (!tab || tab.exitCode != null) return
  // 判定に失敗したら聞かない（機会を使い切らない側へ倒す）。
  if (!(await ptyIsBusy(ptyId).catch(() => false))) return
  // 判定を待つあいだに届いていることがある。
  if (reported.has(ptyId)) return
  await offerAgentHook({ unreported: place }).catch(() => {})
}
