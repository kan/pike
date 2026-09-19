/**
 * ドラッグでの並べ替えの共有部。プロジェクト一覧（#203）とサイドバーのアイコン列（#364）が使う。
 */

/** ポインタが要素の上下どちらの半分にいるか（縦に並ぶ一覧のドロップ位置）。 */
export function sideOf(e: DragEvent): 'top' | 'bottom' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom'
}

/**
 * `ids` から `moved` を抜き、`target` の上か下へ入れ直した配列を返す。**先に抜く**ので、
 * 上から下へ動かすときの添字の補正が要らない。`target` が無ければ末尾へ置く。
 */
export function insertAt<T>(ids: readonly T[], moved: T, target: T, side: 'top' | 'bottom'): T[] {
  const rest = ids.filter((id) => id !== moved)
  const at = rest.indexOf(target)
  if (at === -1) return [...rest, moved]
  rest.splice(side === 'bottom' ? at + 1 : at, 0, moved)
  return rest
}

/**
 * 鍵で要素を指して並べ替えた配列を返す（`insertAt` を鍵で呼ぶ形）。**変わらなければ元の配列を
 * そのまま返す**ので、呼び出し側は `!==` で比べて、変わったときだけ代入できる（ストアの値に
 * 代入すると、保存・同期・broadcast が走る）。どちらかの鍵が無ければ何もしない。
 */
export function moveByKey<T, K>(list: T[], keyOf: (item: T) => K, moved: K, target: K, side: 'top' | 'bottom'): T[] {
  const m = list.find((i) => keyOf(i) === moved)
  const tg = list.find((i) => keyOf(i) === target)
  if (!m || !tg || m === tg) return list
  const next = insertAt(list, m, tg, side)
  return next.every((i, n) => i === list[n]) ? list : next
}
