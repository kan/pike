export function formatLineRange(range: { start: number; end: number }): string {
  return range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`
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
