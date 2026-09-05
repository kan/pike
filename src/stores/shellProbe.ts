/**
 * 「シェルごとに 1 回だけ聞いて覚える」の共通部（#275 の宿題 2）。
 *
 * 同じ形のラッチを 3 つのストアが別々に書いていた（`search` の rg のバックエンド、
 * `issues` の `gh`、`agents` のエージェント検出）。どれも問いは違うが、**構造は同じ**で、
 * しかも**同じ罠を 3 回踏み直せる**形だった。
 *
 * - 答えは**シェルの導入単位**で決まる（WSL プロジェクトが見るのは distro の中の PATH、
 *   Windows プロジェクトが見るのはホストのそれ）。だから 1 枠ではなく**キーごとの表**で
 *   持つ。1 枠だと、同じウィンドウで WSL のタブと PowerShell のタブを行き来するだけで
 *   毎回聞き直し、答えが「どのシェルのものか」を知らないまま入れ替わる
 * - **走っている問い合わせもキーで見張る**。真偽値のガードだと、A の probe（冷えた WSL では
 *   10 秒以上かかる）の最中に B へ切り替えたとき、B の呼び出しが A の Promise を待ったうえで
 *   **A の答えを B のキーで焼き込む**。以後 B は一度も probe されず、自己回復しない
 *   （`issues` が実際にこれで壊れていた）
 * - **同じキーへの重複した呼び出しは 1 本に畳む**。べき等のガードは答えが入ってからしか
 *   効かないので、これが無いと同じ tick に 2 回頼まれたときに 2 回走る（WSL では
 *   `wsl.exe` が 2 本立つ）
 *
 * 政策の違いは 2 つのオプションに落ちる。**それ以外は共通**にしてある。
 *
 * - `keep` … その答えを覚えてよいか。`issues` は「見つかった」だけ覚える（見つからなかった
 *   ほうを焼き付けると、`PROBE_TIMEOUT` に届いた 1 回でパネルが消え、更新ボタンにも手が
 *   届かなくなる）。省略すると全部覚える
 * - `ttl` … 同じキーを聞き直すまでの間隔。省略すると聞き直さない（シェルが変わるまで有効）
 */

import { type ShallowRef, shallowRef } from 'vue'
import { type ShellType, shellId } from '../types/tab'

export interface ShellProbeOptions<T> {
  /** 覚えてよい答えか。省略すると全部覚える。 */
  keep?: (answer: T) => boolean
  /** 同じキーを聞き直すまでの間隔（ms）。省略すると聞き直さない。 */
  ttl?: number
}

export interface ShellProbe<T> {
  /** そのシェルの答え。まだ無ければ `null`。 */
  answerFor(shell: ShellType | null | undefined): T | null
  /**
   * 必要なら聞く。**べき等**なので、タブが見えるたびに呼んでよい。
   *
   * `force` が飛ばすのは覚えている答えだけで、**走っている問い合わせには相乗りする**
   * （撃ち直すと同じシェルに 2 本立つ）。`root` と `force` はそのまま `probe` に渡る。
   */
  ask(shell: ShellType | null | undefined, root: string, force?: boolean): Promise<void>
}

/**
 * @param probe 実際に聞きに行く関数。`root` はコマンドを走らせる場所（要らない問いは
 *   無視してよい）、`force` は Rust 側にもキャッシュがある問いのための素通し。
 *   **失敗は呼び出し側で答えに落とす**（`search` の grep フォールバックのように、失敗
 *   そのものが答えであることがある）。投げた場合は何も覚えない。
 */
export function createShellProbe<T>(
  probe: (shell: ShellType, root: string, force: boolean) => Promise<T>,
  options: ShellProbeOptions<T> = {},
): ShellProbe<T> {
  // **`shallowRef` で持つ**（`createUsageStore` が `Ref<T | null>` に落としているのと同じ
  // 理由で、ジェネリックな答えは `ref` の深い展開と噛み合わない）。書くときは Map ごと
  // 入れ替えるので、浅い監視で足りる。
  const answers = shallowRef(new Map<string, { answer: T; at: number }>()) as ShallowRef<
    Map<string, { answer: T; at: number }>
  >
  const inFlight = new Map<string, Promise<void>>()

  function answerFor(shell: ShellType | null | undefined): T | null {
    if (!shell) return null
    return answers.value.get(shellId(shell))?.answer ?? null
  }

  function fresh(key: string): boolean {
    const known = answers.value.get(key)
    if (!known) return false
    return options.ttl === undefined || Date.now() - known.at < options.ttl
  }

  async function ask(shell: ShellType | null | undefined, root: string, force = false): Promise<void> {
    if (!shell) return
    const key = shellId(shell)
    const running = inFlight.get(key)
    if (running) return running
    if (!force && fresh(key)) return

    const run = (async () => {
      try {
        const answer = await probe(shell, root, force)
        const next = new Map(answers.value)
        if (options.keep?.(answer) === false) {
          // 覚えない答えは**消す**（前の答えを残すと、`gh` を消したのに見つかったままになる）。
          next.delete(key)
        } else {
          next.set(key, { answer, at: Date.now() })
        }
        // **Map をその場で書き換えないこと。** `shallowRef` は `.value` の再代入でしか
        // 通知しないので、破壊的に触ると読み手（`ghAvailable` など）が無効化されない。
        answers.value = next
      } catch {
        // 何も覚えない。次に呼ばれたときにまた聞く。
      }
    })()
    inFlight.set(key, run)
    // **後始末を本体の `finally` に書かないこと。** async の本体は最初の `await` まで同期で
    // 走るので、`probe` が（Promise の reject ではなく）**同期例外**を投げると、中に書いた
    // `finally` が `inFlight.set` より先に走る。すると決着済みの Promise が残り続け、以後
    // そのシェルは `if (running) return running` に弾かれて**二度と聞き直されない**。
    // 外から繋げばこの順序を気にする必要がない（`.finally` のコールバックは常に
    // マイクロタスクへ回るので、`set` より先には走らない）。
    void run.finally(() => inFlight.delete(key))
    return run
  }

  return { answerFor, ask }
}
