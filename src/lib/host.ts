/**
 * このアプリが動いているホスト OS。シェルの既定・プロジェクトのプラットフォーム・
 * OS 統合機能の出し分けが全部ここを見る。
 *
 * **判定に `@tauri-apps/plugin-os` を足さない**（依存を増やさない方針）。IPC も使わない:
 * `defaultShellProfiles` や `shellLabel` のように**同期で**答えが要る場所から呼ばれるので、
 * 非同期の初期化にすると「起動直後の数フレームだけ Windows 用の一覧が出る」形になる。
 *
 * WebView の User-Agent は WebView2（Windows）でも WKWebView（macOS）でも OS を含み、
 * この用途には十分に安定している。判定を外したときの影響は「既定のシェル候補がずれる」
 * だけで、ユーザーが設定で選び直せる（安全側に倒れる）。
 */

export type HostPlatform = 'windows' | 'macos' | 'linux'

function detect(): HostPlatform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  return 'linux'
}

export const hostPlatform: HostPlatform = detect()

/** Windows ホストか。WSL・cmd・PowerShell・ジャンプリスト等が意味を持つのはこのときだけ。 */
export const isWindowsHost = hostPlatform === 'windows'

/** macOS / Linux ホストか（＝ローカルの POSIX シェルを使う）。 */
export const isUnixHost = !isWindowsHost
