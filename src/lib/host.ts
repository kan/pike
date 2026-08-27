/**
 * このアプリが動いているホスト OS と、そこから決まる既定値。シェルの既定・
 * プロジェクトのプラットフォーム・OS 統合機能の出し分けが全部ここを見る。
 *
 * **判定に `@tauri-apps/plugin-os` を足さない**（依存を増やさない方針）。IPC も使わない:
 * `defaultShellProfiles` や `shellLabel` のように**同期で**答えが要る場所から呼ばれるので、
 * 非同期の初期化にすると「起動直後の数フレームだけ Windows 用の一覧が出る」形になる。
 *
 * WebView の User-Agent は WebView2（Windows）でも WKWebView（macOS）でも OS を含み、
 * この用途には十分に安定している。判定を外したときの影響は「既定のシェル候補がずれる」
 * だけで、ユーザーが設定で選び直せる（安全側に倒れる）。
 *
 * **公開するのは `isWindowsHost` 1 つだけ。** macOS と Linux を区別する問いがまだ無いので、
 * 3 値の enum も `isUnixHost`（`!isWindowsHost` の別名）も置かない。否定の綴りが 2 通り
 * あると、次に書く人がどちらを使うか決められなくなる。区別が要る問いが出た時点で足す。
 */

import type { ShellType } from '../types/tab'
import type { ProjectPlatform } from './projectPaths'

export const isWindowsHost = /Windows/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent)

/**
 * このホストで既定にするシェル（Rust の `ShellConfig::host_default` と対）。
 *
 * **`types/tab.ts` ではなくここに置く。** あちらは値 import を持たない方針
 * （`.claude/rules/frontend.md`）で、この関数は `isWindowsHost`＝`navigator` を読む。
 */
export function hostDefaultShell(): ShellType {
  return isWindowsHost ? { kind: 'powershell' } : { kind: 'unix' }
}

/**
 * このホストで新規プロジェクトの既定にするプラットフォーム。Windows は従来どおり
 * WSL、macOS / Linux はローカル。フォームの初期値とリセット先が全部ここを通る。
 */
export function defaultProjectPlatform(): ProjectPlatform {
  return isWindowsHost ? 'wsl' : 'unix'
}
