/**
 * 行番号の範囲の綴り（`42` / `10-20`）。**「1 行か範囲か」の分岐はここ 1 つ**にして、
 * 表示用の `L`（{@link formatLineRange}）と参照用の `:`（`paths.ts` の `fileLineRef`）は
 * 呼び出し側が前に付ける。分けていないと、桁を足したくなったときに直す場所が 3 つになる。
 */
export function lineRangeSuffix(range: { start: number; end: number }): string {
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`
}

export function formatLineRange(range: { start: number; end: number }): string {
  return `L${lineRangeSuffix(range)}`
}

/**
 * Convert a `#rrggbb` (or `#rgb`) hex color to an `rgba(r,g,b,a)` string with the
 * given alpha. Used for window transparency (issue #162): the terminal/editor
 * backgrounds are translucent so the desktop shows through. Returns the input
 * unchanged when it is not a hex color (e.g. already an rgb()/named color).
 */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return hex
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const r = Number.parseInt(h.slice(0, 2), 16)
  const g = Number.parseInt(h.slice(2, 4), 16)
  const b = Number.parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** バイト数を画面に出す綴り（`1.5 MB` / `820 KB`）。MB 未満は KB で、小数を持たない。 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

interface TokenPricing {
  inputPerM: number
  outputPerM: number
}

const OPENAI_PRICING: Record<string, TokenPricing> = {
  o3: { inputPerM: 10, outputPerM: 40 },
  'o4-mini': { inputPerM: 1.1, outputPerM: 4.4 },
  'o3-mini': { inputPerM: 1.1, outputPerM: 4.4 },
  'gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
  'gpt-4.1': { inputPerM: 2, outputPerM: 8 },
  'gpt-4.1-mini': { inputPerM: 0.4, outputPerM: 1.6 },
  'gpt-4.1-nano': { inputPerM: 0.1, outputPerM: 0.4 },
}

export function estimateOpenAICost(model: string, inputTokens: number, outputTokens: number): number | null {
  const key = Object.keys(OPENAI_PRICING).find((k) => model.startsWith(k))
  if (!key) return null
  const p = OPENAI_PRICING[key]
  return (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000
}

/**
 * ブラウザのタブで開ける URL か（http(s) として読めるか）。**前方一致の正規表現で代えない**:
 * 大小の扱いが割れるうえ、`https://` で始まるだけの読めない文字列を通してしまう。
 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 2 つの URL が同じページを指すか（オリジンとパスが同じ。`?` 以降と `#` 以降は見ない、#412）。
 * 読めない URL は同じとみなさない。使いどころはブラウザのタブの閲覧履歴（`BrowserTab.vue` の
 * `applyUrl`）。
 */
export function isSamePage(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname
  } catch {
    return false
  }
}

/**
 * URL を画面に出すときのホスト（ポート付き、#368）。読めない URL は素のまま返す。
 * ブラウザのタブの既定の名前とブラウザパネルのホスト欄が同じものを出すための 1 か所。
 * 承認の鍵に使う `lib/openUrl.ts` の `httpHost`（ポートを見ない・小文字化する）とは用途が違う。
 */
export function displayHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}
