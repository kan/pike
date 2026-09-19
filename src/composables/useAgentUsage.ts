/**
 * UI が要る形にした使用量（#226 / #263）。
 *
 * StatusBar のドロップダウンとエージェント状態タブは、同じ数字を 2 つの詳しさで出す。
 * **導出はここ 1 箇所**で、2 つのコンポーネントに同じ computed を置いていたころは
 * 「アカウント有り」の判定が既に食い違っていた。
 *
 * **種別を知らない。** 返すのは `entries`（レジストリ順のリスト）だけで、読む側は回すだけ。
 * 以前は `claudeUsage` / `claudeRate` / `codexMeters` … と種別ごとの computed が並んでいて、
 * エージェントを増やすたびに 2 つの画面を書き足すことになっていた。
 */
import { computed } from 'vue'
import { AGENTS, type AgentDef } from '../lib/agents'
import { hostDefaultShell } from '../lib/host'
import { useAgentUsageStore } from '../stores/agentUsage'
import { useTabStore } from '../stores/tabs'
import type { AgentUsage } from '../types/agentUsage'
import { terminalPlace } from './useAppActions'

export interface AgentUsageEntry {
  agent: AgentDef
  usage: AgentUsage | null
  /**
   * 画面に出す価値があるか。**アカウントか、利用率か、トークンか、種別固有の値の
   * どれかがある**こと。id しか無い応答（そのエージェントを使っていない）は出さない。
   */
  hasData: boolean
  /**
   * ログインの知らせとボタンを出すか（#381）。ログインを求められていて、かつログインの
   * コマンドを表が持っていること。**読む側はこれだけを見る**（条件を画面ごとに書かない）。
   */
  needsLogin: boolean
}

export function useAgentUsage() {
  const stores = AGENTS.map((agent) => ({ agent, store: useAgentUsageStore(agent.id) }))
  const tabStore = useTabStore()

  const entries = computed<AgentUsageEntry[]>(() =>
    stores.map(({ agent, store }) => {
      const usage = store.usage
      return {
        agent,
        usage,
        needsLogin: Boolean(usage?.loginRequired && agent.login),
        hasData: Boolean(
          usage &&
            (usage.loginRequired ||
              usage.account?.email ||
              usage.account?.name ||
              usage.account?.plan ||
              usage.meters.length > 0 ||
              usage.facts.length > 0 ||
              (usage.total && usage.total.input + usage.total.output > 0)),
        ),
      }
    }),
  )

  /** 何か出せるものがあるエージェントだけ。2 つの画面はどちらもこれを回す。 */
  const visible = computed(() => entries.value.filter((e) => e.hasData))

  /**
   * StatusBar が「25% / 5%」に詰め込む 2 つ。**1 つのエージェントから揃って取る**:
   * 並んだ数字にどちらの枠か書く余地が無いので、混ぜない。**利用率を出せる最初の
   * エージェント**（レジストリ順）が両方の枠を出す。
   *
   * **選ぶ条件は描く条件と同じにする。** StatusBar が出すのは `session` と `weekAll` の
   * 2 つだけなので、`meters.length > 0` で選ぶと、枠が全部 `other` に落ちたエージェント
   * （CLI の文言が変わって `window_kind` が分類できなかった、モデル別の枠しか無い等）が
   * 先に当たって**帯を 1 本も出さないまま**確定し、次のエージェントに落ちない。
   */
  const headline = computed<AgentUsageEntry | null>(
    () => visible.value.find((e) => e.usage?.meters.some((m) => m.kind === 'session' || m.kind === 'weekAll')) ?? null,
  )

  const refreshing = computed(() => stores.some(({ store }) => store.refreshing))

  function refreshAll() {
    for (const { store } of stores) void store.refreshUsage(true)
  }

  /** ログインを求めているエージェント（#381）。StatusBar の知らせはこれを見る。 */
  const needsLogin = computed(() => visible.value.filter((e) => e.needsLogin))

  /**
   * ログインし直すターミナルを開く（#381）。**シェルと cwd は新規ターミナルと同じ決め方**
   * （`terminalPlace`）: 利用者が `claude` を包む起動ラッパー（`CLAUDE_CONFIG_DIR` を
   * repo ごとに被せる等）を使っていても、手で打つのと同じアカウントに入る。
   * 終わったら使用量を取り直して、知らせを下ろす。
   */
  function login(agent: AgentDef) {
    const command = agent.login
    if (!command) return
    const place = terminalPlace()
    const store = stores.find((s) => s.agent.id === agent.id)?.store
    tabStore.runCommandTab(command, place.cwd, place.shell ?? hostDefaultShell(), {
      title: command,
      keepOnError: true,
      onExit: () => void store?.refreshUsage(true),
    })
  }

  return { entries, visible, headline, refreshing, refreshAll, needsLogin, login }
}
