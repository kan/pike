/**
 * Claude Code のサインインの期限（#604）。
 *
 * `claude auth status --json` の `loginExpiresAt` は、アクセストークンの期限ではなく、
 * サインインし直さずにトークンを更新し続けられる期限。**実際には最大で 3 日早く切れる**
 * ことがあるので、1 つの日時ではなく「最も早い日〜期限」の幅で扱う。
 *
 * **i18n を読まない**（Node のテストから確かめるため）。文言は `lib/usageFormat.ts` の
 * `loginExpiryLabel`。
 */

/** 期限より早く切れうる日数。 */
export const EARLY_EXPIRY_DAYS = 3
/** 最も早い日までの残りがこの日数以下なら、警告として目立たせる。 */
export const EXPIRY_WARN_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export interface LoginExpiry {
  /** CLI が返した期限。 */
  expiresAt: Date
  /** 最も早く切れうる日時（期限の 3 日前）。 */
  earliest: Date
  /** 最も早い日までの残り日数（切り上げ）。過ぎていれば 0。 */
  daysToEarliest: number
  /** 期限までの残り日数（切り上げ）。過ぎていれば 0。 */
  daysToExpiry: number
  /** 警告として目立たせるか（期限を過ぎていれば常に真）。 */
  soon: boolean
  /**
   * 期限を過ぎた。**消さずに知らせる**: 使用量は最長 1 時間ごとにしか取り直さないので、
   * ここで `null` にすると「要ログイン」が出るまでのあいだ何も知らせないことになる。
   */
  expired: boolean
}

/** 期限の値を表示の形に落とす。**読めない値は `null`**（期限を持たないログインと同じ扱い）。 */
export function loginExpiry(iso: string | null | undefined, nowMs: number): LoginExpiry | null {
  if (!iso) return null
  const expiresMs = Date.parse(iso)
  if (Number.isNaN(expiresMs)) return null
  const earliestMs = expiresMs - EARLY_EXPIRY_DAYS * DAY_MS
  const daysUntil = (ms: number) => Math.max(0, Math.ceil((ms - nowMs) / DAY_MS))
  return {
    expiresAt: new Date(expiresMs),
    earliest: new Date(earliestMs),
    daysToEarliest: daysUntil(earliestMs),
    daysToExpiry: daysUntil(expiresMs),
    soon: earliestMs - nowMs <= EXPIRY_WARN_DAYS * DAY_MS,
    expired: expiresMs <= nowMs,
  }
}
