/**
 * このマシンで使えるコーディングエージェント（#275 / #267）。
 *
 * **答えはシェルの導入単位で決まる**（WSL プロジェクトが見るのは distro の中の PATH、
 * Windows プロジェクトが見るのはホストのそれ）ので、シェルごとに覚えてウィンドウ内の
 * 全ターミナルタブで共有する。**タブごとに持たないこと**: ターミナルは新規タブだけでなく
 * タスク実行・`docker compose up`・git の続行でも開くので、タブごとに聞くと IPC がその数
 * だけ飛ぶ。
 *
 * **1 枠ではなくシェルごとの表にする。** 1 枠だと、同じウィンドウで WSL のタブと
 * PowerShell のタブを行き来するだけで（どちらも検出済みでも）毎回聞き直し、`available` が
 * 「どのシェルの答えか」を知らないまま入れ替わる。表にしておけば、プロジェクトを
 * 切り替えたときに捨てる必要も無い（シェルが変われば別のキーを引くだけ）。
 *
 * TTL の役割は Rust と分かれている: 向こう（`DETECT_TTL`）は**プロセスを起こさない**ため、
 * こちら（`ASK_TTL`）は**IPC を投げない**ため。空の答えを永久にラッチすると、エージェントを
 * 入れても向こうの TTL に到達する機会そのものが消える。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { AGENTS, type AgentDef, agentById } from '../lib/agents'
import { agentDetect } from '../lib/tauri'
import { type ShellType, shellId } from '../types/tab'
import { useSettingsStore } from './settings'

/** 同じシェルを聞き直すまでの間隔。Rust 側の `DETECT_TTL` と同じ長さ。 */
const ASK_TTL = 300_000

interface Answer {
  bins: string[]
  at: number
}

export const useAgentStore = defineStore('agents', () => {
  const settings = useSettingsStore()
  /** シェルの id → 見つかった `bin` 名。 */
  const answers = ref<Record<string, Answer>>({})
  /** いま見ているタブのシェル。`available` はこのキーの答えを読む。 */
  const currentShell = ref<string | null>(null)
  /** 走っている検出（キーごと）。同じシェルへの重複した問い合わせを 1 本に畳む。 */
  const inFlight = new Map<string, Promise<void>>()

  /** 表にあるエージェントのうち、今のシェルで見つかった `bin`。 */
  const detectedBins = computed<string[]>(() =>
    currentShell.value ? (answers.value[currentShell.value]?.bins ?? []) : [],
  )

  /**
   * 起動メニューに出すエージェント。**設定の並び順**（`agentProfiles`）で、隠したものを
   * 除き、今のシェルで見つかったものだけ。
   *
   * **先頭が既定**（ボタン本体が走らせるもの）。順序と既定を別々に持たないので、
   * 「並べ替えたのに既定が変わらない」という食い違いが起きない。
   */
  const available = computed<AgentDef[]>(() => {
    const detected = new Set(detectedBins.value)
    return settings.agentProfiles
      .filter((p) => !p.hidden)
      .flatMap((p) => agentById(p.id) ?? [])
      .filter((a) => detected.has(a.bin))
  })

  /**
   * 使えるエージェントを調べ、そのシェルを「今見ているもの」にする。
   *
   * **べき等**（`stores/search.ts` の `detectedShell` と同じ規約）。TTL 内の答えがあれば
   * IPC も飛ばさないので、タブが見えるたびに呼んでよい。
   *
   * **`root` は空でもよい。** POSIX 側の probe は使わず、Windows 側でも cwd にしか
   * 使わない（Rust 側が空なら現在地に落とす）。グローバルモードのウィンドウは
   * プロジェクトを持たないので、ここで弾くと起動ボタンが一生出ない。
   */
  async function detect(shell: ShellType | undefined, root: string): Promise<void> {
    if (!shell) return
    const key = shellId(shell)
    currentShell.value = key
    const known = answers.value[key]
    if (known && Date.now() - known.at < ASK_TTL) return
    const running = inFlight.get(key)
    if (running) return running
    const promise = (async () => {
      const bins = await agentDetect(
        shell,
        root,
        AGENTS.map((a) => a.bin),
      ).catch(() => [] as string[])
      answers.value[key] = { bins, at: Date.now() }
    })()
    inFlight.set(key, promise)
    try {
      await promise
    } finally {
      inFlight.delete(key)
    }
  }

  return { detectedBins, available, detect }
})
