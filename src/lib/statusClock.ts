/**
 * ステータスバーの日付と時刻の表記（`components/layout/StatusClock.vue`）。
 *
 * **日付と時刻は別々の設定で、どちらも `off` を値に持つ。** 「出すか」と「どう書くか」を
 * 真偽値と表記に割ると、出さないのに表記だけ選べる組み合わせができ、設定画面に「いま
 * 効かない項目」を畳む条件が要る（`stores/settings.ts` の `TERMINAL_PATH_LINK_MODES` と同じ形）。
 *
 * **表記は OS のロケールにも UI の言語にも従わせず、利用者が選ぶ。** 年月日の並びと
 * 12 / 24 時間は地域の好みで、言語とは別に決めたい（英語の UI で `2026/10/11` と書く等）。
 * 言語を見るのは曜日の名前だけ。
 *
 * **本体の表記は `Intl.DateTimeFormat` に整形させない**（曜日の名前を引くのにだけ使う）。整形器は
 * 作った時点のタイムゾーンを抱えるので、使い回すと起動後に OS のタイムゾーンを変えても
 * 古いままになる。`Date` の getter はその都度いまのタイムゾーンで答える。
 */

export const STATUS_DATE_FORMATS = ['off', 'iso', 'ymd', 'ymdWeekday', 'md', 'mdWeekday', 'mdy', 'dmy'] as const
export type StatusDateFormat = (typeof STATUS_DATE_FORMATS)[number]

export const STATUS_TIME_FORMATS = ['off', 'h24', 'h12'] as const
export type StatusTimeFormat = (typeof STATUS_TIME_FORMATS)[number]

export function sanitizeStatusDateFormat(v: unknown): StatusDateFormat {
  return STATUS_DATE_FORMATS.includes(v as StatusDateFormat) ? (v as StatusDateFormat) : 'off'
}

export function sanitizeStatusTimeFormat(v: unknown): StatusTimeFormat {
  return STATUS_TIME_FORMATS.includes(v as StatusTimeFormat) ? (v as StatusTimeFormat) : 'off'
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * 整形器を作る。**言語のタグが崩れていたら OS のロケールに落とす**: UI の言語の設定は
 * 検証されていない文字列で、`ja_JP` のようなタグが入ると `Intl` は例外を投げる。ここで
 * 落ちるとステータスバーごと描けなくなる。
 */
function dateTimeFormat(lang: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(lang, options)
  } catch {
    return new Intl.DateTimeFormat(undefined, options)
  }
}

// 曜日の名前は言語ごとに 7 つ作って覚える。**UTC に固定した整形器で引く**ので、上の
// タイムゾーンの問題は起きない（2023-01-01 は日曜）。
const weekdayNames = new Map<string, string[]>()
function weekdayName(lang: string, day: number): string {
  let names = weekdayNames.get(lang)
  if (!names) {
    const format = dateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' })
    names = Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2023, 0, 1 + i))))
    weekdayNames.set(lang, names)
  }
  return names[day]
}

/** 日付の表記。`off` は空文字。`lang` は曜日の名前にだけ使う。 */
export function formatStatusDate(format: StatusDateFormat, d: Date, lang: string): string {
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  const weekday = () => `(${weekdayName(lang, d.getDay())})`
  switch (format) {
    case 'off':
      return ''
    case 'iso':
      return `${y}-${pad2(m)}-${pad2(day)}`
    case 'ymd':
      return `${y}/${pad2(m)}/${pad2(day)}`
    case 'ymdWeekday':
      return `${y}/${pad2(m)}/${pad2(day)} ${weekday()}`
    case 'md':
      return `${m}/${day}`
    case 'mdWeekday':
      return `${m}/${day} ${weekday()}`
    case 'mdy':
      return `${pad2(m)}/${pad2(day)}/${y}`
    case 'dmy':
      return `${pad2(day)}/${pad2(m)}/${y}`
  }
}

/** 時刻の表記。`off` は空文字。秒は出さない（更新を 1 分に 1 回で済ませる）。 */
export function formatStatusTime(format: StatusTimeFormat, d: Date): string {
  const h = d.getHours()
  const min = pad2(d.getMinutes())
  switch (format) {
    case 'off':
      return ''
    case 'h24':
      return `${pad2(h)}:${min}`
    case 'h12':
      return `${h % 12 || 12}:${min} ${h < 12 ? 'AM' : 'PM'}`
  }
}

/**
 * ツールチップの日付。選んだ表記に関わらず、年と曜日まで言語の書き方で出す（本体は幅を
 * 取らない表記を選べるので、省いたぶんをここで読める）。**ここだけは `Intl` に整形させるので、
 * 整形器を使い回さず毎回作る**（先頭のタイムゾーンの話）。呼ぶのは 1 分に 1 回。
 */
export function formatStatusTooltip(d: Date, lang: string): string {
  return dateTimeFormat(lang, { dateStyle: 'full' }).format(d)
}

/** ステータスバーに出す 1 行（日付、時刻の順）。両方 `off` なら空文字。 */
export function formatStatusClock(date: StatusDateFormat, time: StatusTimeFormat, d: Date, lang: string): string {
  return [formatStatusDate(date, d, lang), formatStatusTime(time, d)].filter(Boolean).join(' ')
}
