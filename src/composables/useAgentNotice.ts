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
 * - **知らせ方は 2 つを並べる**（#318）。タスクバーの点滅（`windowFlash`）と、押すと
 *   このウィンドウが前に出るデスクトップ通知（`toastNotify`、Windows のみ・設定で切れる）。
 *   排他にしないのは、トーストを見逃してもタスクバーには残っていてほしいため。
 *   通知が押せる形で出せるようになった経緯（AppUserModelID を書いたショートカット）は
 *   `src-tauri/src/toast/mod.rs` の doc が正本
 * - **見えているものには何もしない。** そのウィンドウがアクティブで、かつそのタブが
 *   描かれているなら、エージェントのプロンプトは既に目の前にある
 * - **印はタブに立てる**（`awaitingInput`）。プロジェクト単位の緑のドットはその集約
 *   （`tabStore.awaitingProjectIds`）で、消す処理を別に持たない
 */

import { getCurrentWindow } from '@tauri-apps/api/window'
import { watch } from 'vue'
import { t } from '../i18n'
import { type AgentId, agentById } from '../lib/agents'
import { tabDisplayTitle } from '../lib/tabTitle'
import { toastNotify, windowFlash } from '../lib/tauri'
import { windowFocused } from '../lib/window'
import { useProjectStore } from '../stores/project'
import { type AgentNotifyMode, useSettingsStore } from '../stores/settings'
import { useTabStore } from '../stores/tabs'

/** Rust の `AgentNotice`（`agent_hook.rs`）。 */
interface AgentNotice {
  ptyId: string
  /** 表の id（`AgentId`）。**送り側が名乗る**ので、`AGENTS` に無い綴りは届かない。 */
  agent: AgentId
  /** 契機。綴りの正本は Rust の `NoticeKind`。 */
  event: NoticeKind
}

type NoticeKind = 'waiting' | 'idle' | 'done'

/**
 * 通知の本文。**`Record` で持つ**ので、Rust 側に契機を足したらここが型エラーになる
 * （キーを組み立てる形だと、翻訳の無い契機が素の文字列として通知に出る）。
 */
const BODY_KEYS: Record<NoticeKind, string> = {
  waiting: 'agentNotice.waiting',
  idle: 'agentNotice.idle',
  done: 'agentNotice.done',
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
  // 通知のクリック（#318）。**Rust が押されたウィンドウにだけ送る**ので、こちらも
  // 同じく自分宛てだけを受ける。
  await getCurrentWindow().listen<string>('toast_activated', (event) => {
    void handleActivated(event.payload)
  })
}

async function handleNotice(notice: AgentNotice) {
  const mode = useSettingsStore().agentNotify
  // **`off` は機能ごと止める**（印も出さない）。設定の名前が言っているとおりに振る舞う。
  // hook は登録したままなので、戻せばすぐ効く（登録は #299 の申告にも要る）。
  if (mode === 'off') return

  // **知らせないアイドルは、届かなかったものとして扱う（#338）。** 印だけ立てると、
  // それが次の知らせの `known`（＝「もう知らせた」）として読まれ、**そのあとに来る本物の
  // 入力待ちが握り潰される**。長いサブエージェントを待っているあいだに 60 秒の
  // `idle_prompt` が来て、その後の権限確認が黙る、という #338 が直したい場面そのもので
  // 起きる。印と「知らせた」を 1 つで持っている以上、ここで分けるしかない。
  if (notice.event === 'idle' && !useSettingsStore().agentNotifyIdle) return

  const tabStore = useTabStore()
  const tab = tabStore.terminalByPty(notice.ptyId)
  if (!tab) return

  // **`idle` も「待っている」側**（#338）。分かれるのは知らせるかどうかだけで、印の意味は
  // 同じ（実際に待ってはいる）。
  const waiting = notice.event !== 'done'
  const known = tab.awaitingInput === true
  // 目の前にあるなら印は要らない（画面にプロンプトが出ている）。
  const seen = windowFocused.value && tabStore.isTabVisible(tab.id)
  // **印の更新は早期 return より前に置く。** 「見えているから何もしない」で先に返すと、
  // ターンの終わり（`done`）で下ろす経路まで飛ばしてしまい、立った印が残る。すると
  // `known` が真のまま固定され、**そのターミナルでは二度と知らせが出なくなる**（同時に
  // プロジェクト側の緑のドットも消えない）。**`all` でなくても下ろす**: 印が言うのは
  // 「待っている」ことなので、知らせるかどうかとは別。
  tabStore.markTabAwaiting(tab.id, waiting && !seen)
  if (seen || !shouldFlash(mode, notice.event, known)) return

  await windowFlash().catch((e: unknown) => console.error('[agent-notice] flash failed:', e))
  if (!useSettingsStore().desktopNotify) return
  // **文言はここで組む**（Rust は表示名も UI 言語も知らない）。見出しが「プロジェクト名 ＋
  // タブ名」なのは、**通知が別プロジェクトのタブについても出る**ため（`terminalByPty` は
  // パーク中も含む全部を引く）。押せばそこへ切り替わるので、行き先が読める必要がある。
  // アプリ名は要らない（送信元の名前がトーストの上に既に出ている）。
  const agent = agentName(notice.agent)
  const body = t(BODY_KEYS[notice.event], { agent })
  const title = [projectNameOf(tab.projectId), tabDisplayTitle(tab)].filter(Boolean).join(' ')
  // #337 の調査用。見出しに別のプロジェクトの名前が出るという報告があり、ここまでの
  // 材料（どの pty から、どのタブを引いて、その持ち主が誰か）が合っているかを確かめる。
  // **原因が分かったら消す。** デバッグビルドのコンソールにしか出ない。
  if (import.meta.env.DEV) {
    console.info('[agent-notice]', {
      pty: notice.ptyId,
      event: notice.event,
      tabId: tab.id,
      tabTitle: tab.title,
      tabProject: tab.projectId,
      shownProject: useProjectStore().currentProject?.id,
      title,
    })
  }
  // **プロジェクトも渡す（#334）。** 通知センターから数時間後に押されたとき、その pty は
  // もう無いことのほうが多い。そこまで分かっていればプロジェクトのウィンドウへは行ける。
  await toastNotify(notice.ptyId, tab.projectId ?? null, title, body).catch((e: unknown) =>
    console.error('[agent-notice] toast failed:', e),
  )
}

/**
 * 見出しに出すプロジェクト名。**グローバルモードのウィンドウでは空**（タブが
 * プロジェクトを持たない）なので、呼び出し側が落とせるよう空文字を返す。
 *
 * **`currentProject` ではなくタブの持ち主を引く**（`findProject` は一時プロジェクト
 * #230 も見る）。通知は別プロジェクトのタブについても出るので、今見ているほうの名前を
 * 出すと嘘になる。
 */
function projectNameOf(projectId: string | null | undefined): string {
  return (projectId && useProjectStore().findProject(projectId)?.name) || ''
}

/**
 * 通知を押されたら、そのタブまで連れて行く（#318）。
 *
 * **ウィンドウを前に出すのは Rust の仕事**（`toast/mod.rs`。クリックは WinRT の
 * スレッドプールで来るので、あちらがメインスレッドへ回して `restore_window` を呼ぶ）。
 * こちらは**その先**で、別プロジェクトのタブなら切り替えてから選ぶ。
 *
 * **切り替えが要るのは普通に起きる。** 通知が引くタブは `tabs`（パーク中の他プロジェクトも
 * 含む全部）から探すので、#264 で保持しているプロジェクトのタブについても通知は出る。
 * ウィンドウを前に出すだけだと、そのタブは表示すらされていない。
 */
async function handleActivated(ptyId: string) {
  const tabStore = useTabStore()
  // 押されるまでのあいだにタブが閉じられていることがある（通知は消えない）。
  const tab = tabStore.terminalByPty(ptyId)
  if (!tab) return
  const projectStore = useProjectStore()
  if (tab.projectId && tab.projectId !== projectStore.currentProject?.id) {
    // **公開 API を通す**（`switchProject` は非公開）。
    await projectStore.openProject(tab.projectId, 'switch')
    // **切り替わったかを確かめてから選ぶ。** root が今このマシンに無ければ
    // （切断されたネットワークドライブ、消えたディレクトリ）`ensureRootPresent` が
    // 確認を出して切り替えずに戻る。そこで押し進めると、**タブバーには何も出ないのに
    // 中身だけ別プロジェクトのものが見える**状態になる（`project.md` の #264）。
    if (projectStore.currentProject?.id !== tab.projectId) return
  }
  // 印はここで下りる（`setActiveTab` → `clearTabMarks`）ので、別に消さない。
  tabStore.setActiveTab(tab.id)
}

/** 表の表示名。**表に無い綴りは届かない**（`parse_notice`）ので、素の id には落ちない。 */
function agentName(id: AgentId): string {
  return agentById(id)?.label ?? id
}

/**
 * **同じ待ちで 2 度光らせない。** 権限の確認が続けて出ると `Notification` も続けて来るが、
 * まだ答えていないのだから知らせ直す意味が無い（`markTabActivity` と同じ判断）。
 *
 * ここに `idle` の分岐は無い（`handleNotice` の入口で落としてある）。知らせない契機を
 * ここまで通すと、印を立てたことが「もう知らせた」として次の知らせを消す。
 */
function shouldFlash(mode: AgentNotifyMode, event: NoticeKind, known: boolean): boolean {
  return event === 'done' ? mode === 'all' : !known
}
