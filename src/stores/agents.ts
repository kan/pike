/**
 * このマシンで使えるコーディングエージェント（#275 / #267）。
 *
 * **答えはシェルの導入単位で決まる**（WSL プロジェクトが見るのは distro の中の PATH、
 * Windows プロジェクトが見るのはホストのそれ）ので、シェルごとに覚えてウィンドウ内の
 * 全ターミナルタブで共有する。**タブごとに持たないこと**: ターミナルは新規タブだけでなく
 * タスク実行・`docker compose up`・git の続行でも開くので、タブごとに聞くと IPC がその数
 * だけ飛ぶ。
 *
 * ラッチの仕組み（キーごとの表・走っている問い合わせの合流・キーが変わったときの扱い）は
 * `stores/shellProbe.ts` が持つ。ここに残るのは**何を聞くか**と、**今どのシェルのタブを
 * 見ているか**だけ。
 *
 * TTL の役割は Rust と分かれている: 向こう（`PROBE_TTL`）は**プロセスを起こさない**ため、
 * こちら（`ASK_TTL`）は**IPC を投げない**ため。空の答えを永久にラッチすると、エージェントを
 * 入れても向こうの TTL に到達する機会そのものが消える。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { AGENTS, type AgentLauncher, isLauncherVisible } from '../lib/agents'
import { agentDetect } from '../lib/tauri'
import type { ShellType } from '../types/tab'
import { useSettingsStore } from './settings'
import { createShellProbe } from './shellProbe'

/** 同じシェルを聞き直すまでの間隔。Rust 側の `PROBE_TTL` と同じ長さ。 */
const ASK_TTL = 300_000

export const useAgentStore = defineStore('agents', () => {
  const settings = useSettingsStore()
  const probe = createShellProbe<string[]>(
    (shell, root) =>
      agentDetect(
        shell,
        root,
        AGENTS.map((a) => a.bin),
      ).catch(() => [] as string[]),
    { ttl: ASK_TTL },
  )
  /** いま見ているタブのシェル。`launchers` はこのシェルの答えを読む。 */
  const currentShell = ref<ShellType | null>(null)

  /** 表にあるエージェントのうち、今のシェルで見つかった `bin`。 */
  const detectedBins = computed<string[]>(() => probe.answerFor(currentShell.value) ?? [])

  /**
   * 起動メニューに出す行。**設定の並び順**（`agentLaunchers`）で、隠したものを除き、
   * この環境で使えるものだけ（表の行は今のシェルで見つかったもの、カスタム行は空でないもの）。
   *
   * **先頭が既定**（ボタン本体が走らせるもの）。順序と既定を別々に持たないので、
   * 「並べ替えたのに既定が変わらない」という食い違いが起きない。
   */
  const launchers = computed<AgentLauncher[]>(() => {
    const detected = new Set(detectedBins.value)
    return settings.agentLaunchers.filter((l) => isLauncherVisible(l, detected))
  })

  /**
   * 使えるエージェントを調べ、そのシェルを「今見ているもの」にする。
   *
   * **べき等**（`shellProbe` の規約）。TTL 内の答えがあれば IPC も飛ばさないので、タブが
   * 見えるたびに呼んでよい。
   *
   * **`root` は空でもよい。** POSIX 側の probe は使わず、Windows 側でも cwd にしか
   * 使わない（Rust 側が空なら現在地に落とす）。グローバルモードのウィンドウは
   * プロジェクトを持たないので、ここで弾くと起動ボタンが一生出ない。
   */
  async function detect(shell: ShellType | undefined, root: string): Promise<void> {
    if (!shell) return
    currentShell.value = shell
    await probe.ask(shell, root)
  }

  return { detectedBins, launchers, detect }
})
