/**
 * 差分の行を折り返すか（履歴タブとコミットタブ、#453）。既定は設定の `diffWordWrap` で、
 * タブごとに上書きできる（上書きは覚えない。開き直すと設定の値に戻る）。
 *
 * **「自動」は折り返す側に倒す。** diff タブの「自動」は行の長さを測って決めるが
 * （`DiffTab.vue` の `autoWrapped`）、あれは左右の欄を連動して横にずらす仕組みと対に
 * なっている。こちらの 2 つは 1 枚の表をそのまま描くだけなので、測る代わりに、長い行が
 * 必ず読めるほうを既定にする。
 *
 * diff タブはこれを使わない（上の理由で、判断の材料が違う）。
 */

import { computed, ref } from 'vue'
import { useSettingsStore } from '../stores/settings'

export function useDiffWrap() {
  const settings = useSettingsStore()
  const override = ref<boolean | null>(null)
  const wrapOn = computed(() => override.value ?? settings.diffWordWrap !== 'off')
  function toggleWrap() {
    override.value = !wrapOn.value
  }
  return { wrapOn, toggleWrap }
}
