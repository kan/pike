/**
 * プロジェクト id を鍵に持つ localStorage の項目（マシンごと。同期しない）。
 *
 * **id を鍵にする項目を足すときは、鍵をここから作る。** id の付け替え（#463。
 * `moveProjectStorage`）が移す対象はこの表だけなので、各ストアが鍵を自前の文字列で組むと、
 * 付け替えたプロジェクトでその項目だけが黙って初期値に戻る。
 */

/** 鍵が `<接頭辞><id>` の項目。 */
export const PROJECT_KEY_PREFIX = {
  /** 最近開いたファイル（`stores/project.ts`、#271）。 */
  recentFiles: 'pike:recent-files:',
  /** ファイルツリーで展開しているディレクトリ（`stores/fileTree.ts`）。 */
  treeExpanded: 'pike:fileTree:expanded:',
  /** タスクパネルで畳んだグループ（`stores/tasks.ts`）。 */
  tasksCollapsed: 'pike:tasks-collapsed:',
  /** 作業領域の分割の比率（`TabPane.vue`、#308）。 */
  splitRatio: 'pike:split-ratio:',
} as const

/** 値が id の配列の項目。 */
export const PROJECT_ID_LIST_KEY = {
  /** golangci-lint を有効にしたプロジェクト（`stores/diagnostics.ts`、#213）。 */
  golangci: 'pike:diagnostics-golangci',
} as const

/**
 * id の配列の中の `from` を `to` に置き換える（`to` が既に居れば重ねない）。保存した値
 * （`moveProjectStorage`）と、ストアが持つその写しの両方がこれを通す。
 */
export function replaceProjectId(ids: readonly string[], from: string, to: string): string[] {
  return [...new Set(ids.map((id) => (id === from ? to : id)))]
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * id を `from` から `to` へ付け替えたときに、上の項目を移す。**移す先に既に値があれば
 * 上書きしない**（同期で作られたあと使われていた id へ寄せる場合。使っていた側を残す）。
 * 古い鍵は常に消す。保存に失敗しても投げない（どれも失っても作り直せる見た目の状態）。
 */
export function moveProjectStorage(storage: KeyValueStore, from: string, to: string): void {
  if (from === to) return
  try {
    for (const prefix of Object.values(PROJECT_KEY_PREFIX)) {
      const value = storage.getItem(prefix + from)
      if (value === null) continue
      if (storage.getItem(prefix + to) === null) storage.setItem(prefix + to, value)
      storage.removeItem(prefix + from)
    }
    for (const key of Object.values(PROJECT_ID_LIST_KEY)) {
      const raw = storage.getItem(key)
      if (raw === null) continue
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed) || !parsed.includes(from)) continue
      const ids = parsed.filter((id): id is string => typeof id === 'string')
      storage.setItem(key, JSON.stringify(replaceProjectId(ids, from, to)))
    }
  } catch {
    // best-effort
  }
}
