import { defineStore } from 'pinia'
import { ref } from 'vue'
import { t } from '../i18n'
import { type VuePreviewAvailability, vuePreviewAvailable } from '../lib/tauri'
import { vuePreviewInstallCommand } from '../lib/vuePreview'
import { type ShellType, shellId } from '../types/tab'
import { createShellProbe } from './shellProbe'
import { useTabStore } from './tabs'

/**
 * `vue-preview` の検出（#397）。見つかったシェルでは .vue のエディタに Preview を出し、
 * 確かに無いシェルでは Preview の欄に入れ方の案内とボタンを出す。
 *
 * **「見つからない」も `ASK_TTL` のあいだ覚える**（`gh` と違う）。検出は .vue のタブを開く
 * たびに撃つので、覚えないと入れていない大半の人が .vue を開くたびに `wsl.exe` を 1 本
 * 起こす。期限が来たら聞き直すので、vue-preview を入れれば 1 分以内に開いたタブから出てくる。
 * 見つかったほうは Rust もプロセスに 1 つ覚えているので、聞き直しても外部プロセスは起きない。
 */
const ASK_TTL = 60_000

export const useVuePreviewStore = defineStore('vuePreview', () => {
  const probe = createShellProbe<VuePreviewAvailability>(
    (shell, root, force) => vuePreviewAvailable(shell, root, force),
    { ttl: ASK_TTL },
  )
  /**
   * 入れている最中のシェル（`shellId`。答えと同じキーにそろえる）。ボタンを押せなくして、
   * 二重に走らせない。
   */
  const installing = ref(new Set<string>())

  function available(shell: ShellType | null | undefined): boolean {
    return probe.answerFor(shell) === 'found'
  }

  /**
   * 確かに無い（シェルが「コマンドが見つからない」と答えた）。時間切れなどの `unknown` と
   * 聞いている途中は含めない: そこで入れ方を勧めると、入っている人に上書きさせる。
   */
  function missing(shell: ShellType | null | undefined): boolean {
    return probe.answerFor(shell) === 'missing'
  }

  function isInstalling(shell: ShellType | null | undefined): boolean {
    return !!shell && installing.value.has(shellId(shell))
  }

  /**
   * `shell` のターミナルのタブで入れる（ripgrep の `installRipgrep` と同じ形）。終わったら
   * 覚えた答えを捨てて探し直すので、入った時点で開いているタブに Preview が出る。
   */
  function install(shell: ShellType, root: string): void {
    const key = shellId(shell)
    if (installing.value.has(key)) return
    installing.value.add(key)
    useTabStore().runCommandTab(vuePreviewInstallCommand(shell), root, shell, {
      title: t('vuePreview.installTitle'),
      keepOnError: true,
      onExit: (code) => {
        installing.value.delete(key)
        if (code === 0) void probe.ask(shell, root, true)
      },
    })
  }

  return { available, missing, isInstalling, install, detect: probe.ask }
})
