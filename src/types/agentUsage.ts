/**
 * エージェントの使用量（#275 / #263）。**種別ごとの型を持たない。**
 *
 * 正本は Rust の `src-tauri/src/agent_usage/mod.rs`（どのエージェントでも同じ形を返す）。
 * 4 つで取れるものが揃わないので、**`meters` も `total` も空でありうる**。埋まっている
 * ものだけ描く、というのが読む側の契約。
 */

/** 利用率の帯 1 本。ラベルは `kind` で引く（CLI の文言を文字列一致しない）。 */
export interface UsageMeter {
  kind: 'session' | 'weekAll' | 'other'
  /** CLI が印字したままのラベル。`kind` が `other` のときだけ表示に使う。 */
  label: string | null
  usedPercent: number
  resetsAt: string | null
}

/** トークンの内訳 1 行（合計、またはモデル別）。持たない欄は 0。 */
export interface TokenRow {
  /** モデル名など。合計の行では `null`。 */
  label: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  costUsd: number | null
}

/**
 * 種別固有の値のキー。**閉じた集合**で、表示名はフロントが持つ
 * （`lib/usageFormat.ts` の `AGENT_FACT_LABELS`）。Rust に i18n キーを置かないための分担。
 */
export type AgentFactKey = 'config-dir' | 'session-count' | 'last-activity' | 'premium-requests' | 'auth-mode'

export interface UsageFact {
  key: AgentFactKey
  value: string
}

export interface AgentAccount {
  email: string | null
  /** メールアドレスを持たないアカウントの表示名（理由は Rust 側の宣言の隣）。 */
  name: string | null
  plan: string | null
  organization: string | null
}

export interface AgentUsage {
  /** `lib/agents.ts` の表と同じ id。**返ってきたものが誰のものかを値が持つ。** */
  id: string
  /** いま動いているか（`createUsageStore` の契約）。 */
  active: boolean
  account: AgentAccount | null
  meters: UsageMeter[]
  total: TokenRow | null
  rows: TokenRow[]
  facts: UsageFact[]
  /** データを取った時刻（epoch 秒）。 */
  fetchedAt: number | null
}
