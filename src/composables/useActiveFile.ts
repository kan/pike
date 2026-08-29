import { computed } from 'vue'
import { joinPath, normalizeSep, pathSep, toRelativePath } from '../lib/paths'
import { useProjectStore } from '../stores/project'
import { useTabStore } from '../stores/tabs'

/**
 * いま見ているファイル（#274）。ファイルツリーと Git パネルが、開いているファイルを
 * その場で示すのに使う。
 *
 * **タブの種類で持ち方が違う**ので、ここで 1 つの形に揃える。エディタ / プレビュー /
 * PDF は絶対パスを持つが、diff と履歴は**ルート相対**（`DiffTab` の `openWorkingCopy`
 * が `activeRoot` と繋いでいるのと同じ）。
 *
 * **比較の形は 2 つとも先に作る。** 判定は行ごとに呼ばれるので（ツリーは仮想化して
 * いない）、そこで文字列を組み立てると 1 行につき数個のアロケーションが走る。git は
 * 常に `/` 区切りのルート相対を返し、ファイルツリーは区切り込みの絶対パスを持つので、
 * どちらとも `===` で比べられるように両方持っておく。
 *
 * **ストアではなく composable なのは、タブとプロジェクトの両方を読むため。**
 * `stores/tabs.ts` からプロジェクトストアを import すると `project → tabs → project`
 * の循環になる（あちらは既にタブストアを読んでいる）。
 */
export function useActiveFile() {
  const tabStore = useTabStore()
  const projectStore = useProjectStore()

  /** いま見ているファイルの絶対パス。ファイルを持たないタブでは null。 */
  const activeFilePath = computed<string | null>(() => {
    const tab = tabStore.activeTab
    if (!tab) return null
    const sep = pathSep(projectStore.shellForIO)
    switch (tab.kind) {
      case 'editor':
      case 'preview':
      case 'pdf':
        return tab.path ? normalizeSep(tab.path, sep) : null
      case 'diff':
      case 'history':
        return projectStore.activeRoot ? joinPath(projectStore.activeRoot, tab.filePath, sep) : null
      default:
        return null
    }
  })

  /** 同じものをルート相対・`/` 区切りで（git が返す形）。 */
  const activeFileRel = computed<string | null>(() => {
    const abs = activeFilePath.value
    if (!abs || !projectStore.activeRoot) return null
    return normalizeSep(toRelativePath(abs, projectStore.activeRoot), '/')
  })

  /** `path` が今見ているファイルか。絶対パスでもルート相対（`/` 区切り）でも渡せる。 */
  function isActiveFile(path: string): boolean {
    return path !== '' && (path === activeFilePath.value || path === activeFileRel.value)
  }

  return { activeFilePath, isActiveFile }
}
