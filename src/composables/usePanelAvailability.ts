import { useIssuesStore } from '../stores/issues'
import type { SidebarPanel } from '../types/tab'

/**
 * **パネル一般の語彙で「今このプロジェクトで使えるか」を聞く口**（#278）。答えの出典は
 * 各パネルのストア（issue なら `issuesStore.visible`）で、ここはそこへの橋渡し。
 *
 * **入口が 4 つあるので、アイコン列の行に述語を置けない。** パネルは
 * (1) アイコン列、(2) `localStorage` の `pike:activePanel` からの復元、
 * (3) パレットの `> …`、(4) `useAppActions` の `panel*` アクション、で到達しうる。
 * アイコンだけを隠すと、残り 3 つから「使えません」しか出ないパネルが開けてしまう
 * （`useAppActions` が動作の実体を 1 本にしているのと同じ構図）。
 *
 * **`lib/shortcuts.ts` には置けない。** あちらは `stores/project.ts` から import される
 * ので、ストアを読むと循環する。だから composable がこの判定の層になる。
 *
 * 既定は「使える」。条件を持つのは今のところ issue パネルだけで、条件を持たないパネルを
 * ここに並べても意味が無い（`.claude/rules/editor.md` の「パネルを開く行に `needsProject`
 * を付けない」は、プロジェクトの有無の話なのでこれとは別）。
 */
export function usePanelAvailability(): { isPanelAvailable: (panel: SidebarPanel) => boolean } {
  const issuesStore = useIssuesStore()

  function isPanelAvailable(panel: SidebarPanel): boolean {
    // issue（#278）は **origin が GitHub で、かつ `gh` があるときだけ**。片方だけで出すと、
    // 押しても必ず失敗する入口が並ぶ。
    if (panel === 'issues') return issuesStore.visible
    return true
  }

  return { isPanelAvailable }
}
