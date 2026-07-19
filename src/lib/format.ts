export function formatLineRange(range: { start: number; end: number }): string {
  return range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`
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
