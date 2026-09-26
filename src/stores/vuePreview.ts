import { defineStore } from 'pinia'
import { vuePreviewAvailable } from '../lib/tauri'
import type { ShellType } from '../types/tab'
import { createShellProbe } from './shellProbe'

/**
 * `vue-preview` の検出（#397）。見つかったシェルでだけ、.vue のエディタに Preview を出す
 * （`gh` の issue パネルと同じ「入っていれば使える」形）。
 *
 * **「見つからない」も `ASK_TTL` のあいだ覚える**（`gh` と違う）。検出は .vue のタブを開く
 * たびに撃つので、覚えないと入れていない大半の人が .vue を開くたびに `wsl.exe` を 1 本
 * 起こす。期限が来たら聞き直すので、vue-preview を入れれば 1 分以内に開いたタブから出てくる。
 * 見つかったほうは Rust もプロセスに 1 つ覚えているので、聞き直しても外部プロセスは起きない。
 */
const ASK_TTL = 60_000

export const useVuePreviewStore = defineStore('vuePreview', () => {
  const probe = createShellProbe<boolean>((shell, root, force) => vuePreviewAvailable(shell, root, force), {
    ttl: ASK_TTL,
  })

  function available(shell: ShellType | null | undefined): boolean {
    return probe.answerFor(shell) === true
  }

  return { available, detect: probe.ask }
})
