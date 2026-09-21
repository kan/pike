import { computed, type Ref, ref } from 'vue'
import type { AgentDef, AgentId, AgentLauncher } from '../lib/agents'
import { launcherAgent, launcherLines } from '../lib/agents'
import { agentSessionsList } from '../lib/tauri'
import type { AgentSession } from '../types/agentSession'
import type { ShellType } from '../types/tab'

/**
 * エージェントの起動メニュー（#375）。**出し方の規則を 1 か所に置く**もので、
 * ターミナルに重ねる起動ボタン（`TerminalTab.vue`）とタブバーの ▾（`TabBar.vue`）が
 * 共有する。
 *
 * 規則は 3 つ。
 *
 * - **第 1 階層は既定の起動行だけ**（`agentLaunchers` の先頭。#275）
 * - 残りは「他のエージェント」のサブメニュー
 * - **再開できる過去セッションは、その行のサブメニュー**（#267）。どのエージェントの
 *   履歴かはメニュー上の位置が言う
 *
 * **セッションの取得の作法もここが持つ。** ディスクを読み（WSL では `\\wsl.localhost`
 * 越し）、opencode ではプロセスを起こすので、取り方を間違えるとポインタが行き来する
 * たびに `bash -lic` と node が上がる。2 か所に書き写すと片方だけ直すことになる。
 */
export interface AgentMenuOptions {
  /** この時点で出す起動行。シェルが決まっていなければ空。 */
  launchers: () => AgentLauncher[]
  /**
   * 再開一覧を引く場所。決められなければ null（そのときは一覧を出さない）。
   * `epoch` はメニューを開いている世代で、1 回開いているあいだは同じ答えを使ってよい。
   */
  where: (epoch: number) => Promise<{ shell: ShellType; root: string } | null>
  /** 行を選んだ。 */
  run: (command: string, label: string) => void
}

export function useAgentMenu(opts: AgentMenuOptions) {
  const all = computed(() => opts.launchers())
  /** 既定の起動行。ボタン本体とメニューの第 1 階層はこれ。 */
  const defaultLauncher = computed(() => all.value[0] ?? null)
  /** 既定の行が出すコマンド（エージェントなら素の起動と「続きから」、カスタムなら 1 行）。 */
  const defaultLines = computed(() => (defaultLauncher.value ? launcherLines(defaultLauncher.value) : []))
  /** 既定の行が起動するエージェント（第 1 階層の再開一覧はこれ）。 */
  const defaultAgent = computed(() => launcherAgent(defaultLauncher.value))

  /**
   * 「他のエージェント」の各行。**導出はここで 1 回**（テンプレートで `launcherAgent(o)` を
   * 呼ぶと、行ごと・セッション行ごとに `commandMentionsAgent` の正規表現が走る）。
   */
  const otherRows = computed(() =>
    all.value.slice(1).map((l) => ({ lines: launcherLines(l), agent: launcherAgent(l) })),
  )

  /**
   * 再開できる過去セッション（#220 / #267）。**エージェントごとに、そのサブメニューを
   * 開いたときだけ読む。**
   */
  const sessions = ref<Record<string, AgentSession[]>>({})
  /**
   * いま読んでいるエージェント。**1 枠ではなく集合で持つ**: サブメニューを次々にホバーすると
   * 取得が重なるので、1 枠だと A の完了が B のスピナーを消す。取得中かの判定（二重に
   * 起こさない印）もこれが兼ねる。
   */
  const sessionsLoading = ref<AgentId[]>([])
  /**
   * 開いている再開一覧。**鍵はメニュー上の位置**（`default` / `other:<i>`）で、エージェントの
   * id ではない: 既定が `claude` でカスタム行に `claude --model opus` を置いている構成だと、
   * id を鍵にすると片方にホバーしただけで両方のサブメニューが開く。
   */
  const sessionsOpenAt = ref<string | null>(null)
  /** 「他のエージェント」を開いているか。 */
  const subOpen = ref(false)
  /** メニューを開いている世代。**飛んでいる取得を捨てるための印**（`close` が一覧を捨てる）。 */
  let epoch = 0

  /** そのエージェントの一覧を、まだ読んでいなければ読む。 */
  async function openSessions(agent: AgentDef) {
    // **取得済み・取得中なら何もしない。** 印を最初の `await` より前に立てるのが要点で、
    // 無いとポインタが行き来するたびに `agent_sessions` が飛ぶ（opencode は結果を
    // キャッシュしないので、そのたびに `bash -lic` と node のプロセスが上がる）。
    if (sessions.value[agent.id] || sessionsLoading.value.includes(agent.id)) return
    const mine = epoch
    sessionsLoading.value = [...sessionsLoading.value, agent.id]
    try {
      const where = await opts.where(mine)
      if (!where) return
      const list = await agentSessionsList(agent.id, where.shell, where.root).catch(() => [])
      if (mine !== epoch) return
      sessions.value = { ...sessions.value, [agent.id]: list }
    } finally {
      // 閉じたあとに戻ってきたぶんは触らない（`close` が既に空にしている）。
      if (mine === epoch) {
        sessionsLoading.value = sessionsLoading.value.filter((id) => id !== agent.id)
      }
    }
  }

  /** 再開一覧の 1 か所ぶんの束縛（`at` はメニュー上の位置）。 */
  function sessionsMenuBind(agent: AgentDef, at: string) {
    return {
      agent,
      sessions: sessions.value[agent.id] ?? [],
      loading: sessionsLoading.value.includes(agent.id),
      open: sessionsOpenAt.value === at,
      onEnter: () => {
        sessionsOpenAt.value = at
        void openSessions(agent)
      },
      onLeave: () => {
        sessionsOpenAt.value = null
      },
      onPick: (command: string) => opts.run(command, agent.label),
    }
  }

  /**
   * メニューを閉じた。**取った一覧は捨てる。** 次に開くまでに新しいセッションができて
   * いるのが普通なので、残すと古い並びを見せることになる（読むのはメニューを開いた
   * ときだけなので、開き直すコストは元から払っている）。飛んでいる取得は世代で捨てる。
   */
  function close() {
    subOpen.value = false
    sessionsOpenAt.value = null
    sessions.value = {}
    sessionsLoading.value = []
    epoch += 1
  }

  return { defaultLauncher, defaultLines, defaultAgent, otherRows, subOpen, sessionsMenuBind, close }
}

export type AgentMenu = ReturnType<typeof useAgentMenu>
/** テンプレートから読む「他のエージェント」の 1 行ぶん。 */
export type AgentMenuRow = AgentMenu['otherRows'] extends Ref<infer T> ? T : never
