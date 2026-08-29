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
