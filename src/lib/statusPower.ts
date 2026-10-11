/**
 * ステータスバーの電源の表示（`components/layout/StatusPower.vue`、#467）。ここは
 * 「どう見せるか」の純粋な計算だけで、値を取るのは `composables/usePowerStatus.ts`。
 *
 * **出典は webview の Battery Status API（`navigator.getBattery`）で、Rust を通さない。**
 * 変化はイベントで届くのでポーリングが要らず、OS ごとのコードも依存の追加も無い。
 * 代償は WKWebView に無いことで、macOS では項目ごと出さない（`powerStatusSupported`）。
 */

/**
 * この webview で電源の状態を取れるか。設定画面の項目が読む（取れないのに項目だけ出ると
 * 「オンにしたのに何も出ない」になる）。
 */
export const powerStatusSupported = typeof navigator !== 'undefined' && 'getBattery' in navigator

/** `BatteryManager` のうち読むぶんだけ（TS の DOM の型定義に入っていない）。 */
export interface BatteryLike {
  charging: boolean
  /** 0〜1。 */
  level: number
}

/**
 * アイコンの絵柄。`plug` は電源につないでいるとき、残りはバッテリーで動いているときの
 * 残量の帯。
 */
export type PowerIcon = 'plug' | 'full' | 'medium' | 'low' | 'empty'
/** 色。警告するのはバッテリーで動いているあいだだけ（つないでいれば減っていかない）。 */
export type PowerTone = 'normal' | 'warn' | 'danger'

export interface PowerView {
  /**
   * 電源につないでいるか。**「充電中」とは言わない**: API の `charging` は、Chromium の
   * Windows の実装では AC につながっているかを返す。充電の上限（80% で止める等）を
   * 設定した機械は、つないだまま充電していない状態が普通にあり、区別できない。
   */
  plugged: boolean
  /** 0〜100 の整数。 */
  percent: number
  /**
   * 残量を数字で出すか。つないで 100% のときは出さない。**バッテリーを持たない機械も
   * ここに入る**（API はどちらも `charging: true` / `level: 1` で返し、区別できない）。
   */
  showPercent: boolean
  icon: PowerIcon
  tone: PowerTone
}

/** 色を変える境目（%、その値以下）。Windows の「バッテリー残量の低下」の既定に近い値。 */
export const POWER_WARN_PERCENT = 20
export const POWER_DANGER_PERCENT = 10

function batteryIcon(percent: number): PowerIcon {
  if (percent >= 70) return 'full'
  if (percent >= 35) return 'medium'
  if (percent > POWER_DANGER_PERCENT) return 'low'
  return 'empty'
}

/**
 * **残量が数として読めないときは null**（何も出さない）。適当な値へ倒すと、分かって
 * いないのに「100%」のような確信のある表示になる。
 */
export function powerView({ charging, level }: BatteryLike): PowerView | null {
  if (!Number.isFinite(level)) return null
  const percent = Math.round(Math.min(1, Math.max(0, level)) * 100)
  if (charging) return { plugged: true, percent, showPercent: percent < 100, icon: 'plug', tone: 'normal' }
  const tone = percent <= POWER_DANGER_PERCENT ? 'danger' : percent <= POWER_WARN_PERCENT ? 'warn' : 'normal'
  return { plugged: false, percent, showPercent: true, icon: batteryIcon(percent), tone }
}
