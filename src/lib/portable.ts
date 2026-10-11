/**
 * ポータブル版（#451）として動いているか。判定の正本は Rust（`src-tauri/src/portable.rs`）で、
 * ここはその答えの写し。
 *
 * **mount の前に 1 回だけ聞いて、あとは同期で答える**（`main.ts` の `bootstrap`）。
 * `lib/window.ts` の `elevated` のように「あとから ref に入る」形にしないのは、ストアが
 * 作られた時点で値が要るため: プロジェクトの base（`stores/settings.ts`）と同期先
 * （`stores/sync.ts`）は生成時に決まる。あとから入る形だと、起動直後だけインストール版と
 * して動き、同期が 1 回走りうる。
 *
 * 関数にしてあるのは、値が import のあとで入るため（定数を export すると、先に読んだ
 * モジュールが古い値を握る）。
 */
import { portableInfo } from './tauri'

let base: string | null = null

/** Rust に聞いて覚える。失敗したらインストール版として動く（聞けないのは Tauri の外だけ）。 */
export async function initPortable(): Promise<void> {
  try {
    base = (await portableInfo())?.base ?? null
  } catch {
    base = null
  }
}

export function isPortable(): boolean {
  return base !== null
}

/** プロジェクトの base（実行ファイルのあるフォルダ）。ポータブル版でなければ null。 */
export function portableBase(): string | null {
  return base
}
