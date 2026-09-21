/**
 * localStorage helpers.
 *
 * Centralize the try/catch + JSON encoding patterns that were duplicated
 * across stores and components.
 */

/** Load a JSON-encoded value from localStorage, returning fallback on missing/parse error. */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Save a value as JSON to localStorage. Errors are swallowed (best-effort). */
export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // best-effort
  }
}

/**
 * 「最近使ったもの」の先頭に足して保存する（新しい配列を返す）。
 *
 * 中身は「同じものを除いて先頭に置き、`max` 件で切る」だけだが、**呼ぶ側が 2 つ以上ある**
 * （最近開いたファイルとディレクトリ、#271）。片方で重複の見方を変えたときにもう片方が
 * 置いていかれるので、`loadJson` / `saveJson` の隣に置いてある。
 */
export function pushRecent(list: readonly string[], value: string, key: string, max: number): string[] {
  const next = [value, ...list.filter((v) => v !== value)].slice(0, max)
  saveJson(key, next)
  return next
}

/**
 * 「このキーについては一度聞いた」の記録を読む（hook の登録 #299 / #265、inotify-tools #385）。
 *
 * 中身は文字列の配列だが、**素の `loadJson` で済ませないこと**: 手で編集された、あるいは
 * 版の違う Pike が書いた値がそのまま `includes` に渡ると、型の嘘が UI の判断まで届く。
 */
export function loadAskedKeys(key: string): string[] {
  const list = loadJson<unknown>(key, [])
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
}

/**
 * 「聞いた」を記録する。**書く直前に読み直す**のが、これを共有している理由。
 *
 * `localStorage` はウィンドウ間で共有なので、ダイアログを開く前に読んだ配列をそのまま
 * 書き戻すと、答えを待っているあいだに別のウィンドウが足したキーを消す。#385 で 3 つ目の
 * 写しを書いたときに実際にここが落ちたので、`pushRecent` と同じく `loadJson` / `saveJson`
 * の隣へ出した。`Set` で畳むのは、同じキーを 2 度足しうる経路があるため。
 */
export function rememberAskedKey(key: string, value: string): void {
  saveJson(key, [...new Set([...loadAskedKeys(key), value])])
}
