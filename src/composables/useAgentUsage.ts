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
import { useAgentUsageStore } from '../stores/agentUsage'
import type { AgentUsage } from '../types/agentUsage'

export interface AgentUsageEntry {
  agent: AgentDef
  usage: AgentUsage | null
  /**
   * 画面に出す価値があるか。**アカウントか、利用率か、トークンか、種別固有の値の
   * どれかがある**こと。id しか無い応答（そのエージェントを使っていない）は出さない。
   */
  hasData: boolean
}

export function useAgentUsage() {
  const stores = AGENTS.map((agent) => ({ agent, store: useAgentUsageStore(agent.id) }))

  const entries = computed<AgentUsageEntry[]>(() =>
    stores.map(({ agent, store }) => {
      const usage = store.usage
      return {
        agent,
        usage,
        hasData: Boolean(
          usage &&
            (usage.account?.email ||
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

  return { entries, visible, headline, refreshing, refreshAll }
}
