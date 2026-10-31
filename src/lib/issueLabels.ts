/**
 * issue パネルで隠すラベル（#531）。設定の `issueHiddenLabels` の検証（設定画面のタグの欄も
 * 足したあとの一覧をこれに通す）と、一覧で隠すかの判定。**純粋な計算だけ**を置く（ストアと
 * 設定画面の両方が使い、`tests/issueLabels.test.ts` が見る）。
 *
 * **ラベル名は大小を無視して比べる。** GitHub はラベル名の大小違いを同じラベルとして扱う
 * （`On-Hold` と `on-hold` を両方は作れない）ので、設定の書き方の揺れで隠れないことが無いようにする。
 * 保存するのは書かれたままの綴りで、比べるときだけ小文字にそろえる。
 */

/** 外から来た値（localStorage / 同期ファイル）を検証する。空白を除き、大小を無視して重複を落とす。 */
export function sanitizeLabelList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of v) {
    if (typeof x !== 'string') continue
    const name = x.trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** 隠すラベルを 1 つでも持つか。`hidden` は小文字にそろえた集合（`hiddenLabelSet`）。 */
export function hasHiddenLabel(labels: readonly { name: string }[], hidden: ReadonlySet<string>): boolean {
  return hidden.size > 0 && labels.some((l) => hidden.has(l.name.toLowerCase()))
}

/** 判定に使う集合。比べるたびに小文字へ直さないよう、設定が変わったときに 1 度だけ作る。 */
export function hiddenLabelSet(labels: readonly string[]): ReadonlySet<string> {
  return new Set(labels.map((l) => l.toLowerCase()))
}
