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
