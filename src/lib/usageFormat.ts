/**
 * Shared presentation for rate-limit windows (#226).
 *
 * The status bar's dropdown and the agent status panel show the same numbers, so
 * the labelling and the "how alarming is this percentage" rule live here rather
 * than in whichever component happened to need them first.
 */
import { locale, t } from '../i18n'
import type { ClaudeRateWindow } from '../types/claudeUsage'

/** One rate-limit bar. Claude and Codex report quotas differently; both normalize to this. */
export interface Meter {
  label: string
  percent: number
  /** Reset time as the source printed it; shown under the bar when present. */
  resetsAt?: string | null
}

/**
 * Window name for display. The CLI's own wording is only used for windows we
 * don't classify — `kind` is decided in Rust next to the parser, so nothing here
 * string-matches CLI text.
 */
export function rateWindowLabel(w: Pick<ClaudeRateWindow, 'kind' | 'label'>): string {
  if (w.kind === 'session') return t('statusBar.rate5h')
  if (w.kind === 'weekAll') return t('statusBar.rateWeekly')
  return w.label
}

const RESET_MONTHS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
}

/**
 * The CLI prints resets as "Jul 2, 2:39pm (Asia/Tokyo)". Japanese gets the date
 * part rewritten to 7/2; everything else (and any format we don't recognise) is
 * passed through untouched.
 */
export function localizedResetLabel(resetsAt: string): string {
  if (locale.value !== 'ja') return resetsAt
  return resetsAt.replace(
    /([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?,?/,
    (match, mon: string, day: string, year?: string) => {
      const m = RESET_MONTHS[mon]
      if (!m) return match
      return year ? `${year}/${m}/${day}` : `${m}/${day}`
    },
  )
}

/** Color emphasis for a usage percentage: yellow past 80%, red past 90%. */
export function rateLevelClass(pct: number): string {
  if (pct > 90) return 'rate-danger'
  if (pct > 80) return 'rate-warn'
  return ''
}

/** Clock time of the last successful fetch, for "取得 14:03". */
export function fetchedAtLabel(fetchedAt: number | undefined): string {
  if (!fetchedAt) return ''
  const time = new Date(fetchedAt * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
  return t('statusBar.ccRateFetchedAt', { time })
}
