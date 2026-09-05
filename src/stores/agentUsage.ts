/**
 * エージェントごとの使用量ストア（#275 / #263）。
 *
 * **表 1 行につきストア 1 つ。** 以前は `claudeUsage` / `claudeRate` / `codexUsage` の
 * 3 本が手書きで並んでいて、エージェントを増やすたびにファイルが増える形だった。ポーリングの
 * 基盤（`createUsageStore`）はそのまま使い、fetcher が `agentUsageGet(id, …)` を呼ぶだけにする。
 *
 * **Claude の usage と rate が 1 本になった。** 向こうで 1 回にまとめたので、こちらから
 * `sessionActive` を渡す配線も要らなくなった（レートの重さは Rust 側のキャッシュが吸う）。
 *
 * **参照ルートへの追従は全部同じ。** 以前レートだけ外していたのは、worktree を切り替える
 * たびに 90 秒かかる CLI の結果を捨てないためだったが、まとめた今は取り直しても Rust の
 * キャッシュが返すので捨てて困らない（`createUsageStore` の `rootScoped` はそれで消えた）。
 */

import { AGENTS, type AgentId } from '../lib/agents'
import { agentUsageGet } from '../lib/tauri'
import type { AgentUsage } from '../types/agentUsage'
import { createUsageStore } from './usageStore'

/**
 * id → ストア。**表から作る**ので、行を足せばストアも増える。
 *
 * `createUsageStore` は Pinia の store 定義を返す（呼ぶとインスタンスになる）ので、
 * ここで作れるのは定義まで。読む側は `useAgentUsage()` を通す。
 */
const STORES = new Map(
  AGENTS.map((agent) => [
    agent.id,
    createUsageStore<AgentUsage>(`agentUsage:${agent.id}`, (shell, projectRoot, force) =>
      agentUsageGet(agent.id, shell, projectRoot, force),
    ),
  ]),
)

export function useAgentUsageStore(id: AgentId) {
  const store = STORES.get(id)
  if (!store) throw new Error(`unknown agent id: ${id}`)
  return store()
}
