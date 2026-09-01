import { computed } from 'vue'
import { projectColorValue, readableTextOn } from '../lib/projectColors'
import { useProjectStore } from '../stores/project'

/**
 * いま開いているプロジェクトのカラー（#121）を、面として塗るための組で返す（#298）。
 *
 * **導出をここ 1 つに置く理由。** 塗る場所が 2 つ（サイドバーのアイコン列とプロジェクト
 * バー）あり、しかも隣り合って 1 つの帯に見えるので、片方だけ「未設定のときどうするか」や
 * 「上に載る文字を何色にするか」がずれると、その継ぎ目で色が割れて必ず気付かれる。
 *
 * `fg` は `readableTextOn`（相対輝度で黒か白かを選ぶ）。プリセットは黄色から紫まであるので、
 * 白固定でも黒固定でも読めない色が出る。
 *
 * `bg` が `undefined` なのは「カラーを設定していない」で、そのときは呼び出し側が既定の
 * 面の色に落ちる。**ここで既定色を決めない**: アイコン列とプロジェクトバーでは素の下地が
 * 違う（`--bg-secondary` と `--tab-hover-bg`）ので、決めるならそれぞれの場所で決める。
 */
export function useProjectAccent() {
  const projectStore = useProjectStore()

  const bg = computed(() => projectColorValue(projectStore.currentProject?.color))
  const fg = computed(() => (bg.value ? readableTextOn(bg.value) : undefined))

  return { bg, fg }
}
