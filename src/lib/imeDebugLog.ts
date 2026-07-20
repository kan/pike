// 一時的な調査用ログ（TODO「謎のバックスペース」）。
//
// SKK で入力した文字がときどき 1 文字消える件を切り分けるため、ターミナルの
// 入力イベントを溜めて Rust 側でファイルに追記する。判別したいのは 2 つ:
//
//   1. 消えた文字に対応する onData がそもそも出ていない（dedup が食べた）
//   2. onData は出ているが、別途 \x7f / \x08 が送られている（本当に BS）
//
// **原因が判明したら、このファイルと `lib/tauri.ts` のラッパー、
// TerminalTab.vue の imeLog 呼び出しをまとめて削除する。**
//
// ターミナルに打った内容がそのまま平文でログに残る点に注意。

import { imeDebugEnabled, imeDebugLog } from './tauri'

/** 1 回の invoke にまとめる間隔。打鍵ごとに IPC を飛ばさないための緩衝。 */
const FLUSH_MS = 250

let pending: string[] = []
let timer: ReturnType<typeof setTimeout> | null = null
const started = Date.now()

// 既定では完全に無効。app data ディレクトリに `ime-debug.on` を置いた環境だけ
// 記録する（Rust 側 ime_debug.rs を参照）。判定が返るまでのわずかな間に来た
// イベントは捨てずに溜めておき、有効なら最初の flush でまとめて出す。
let enabled: boolean | null = null
imeDebugEnabled()
  .then((on) => {
    enabled = on
    if (!on) pending = []
  })
  .catch(() => {
    enabled = false
    pending = []
  })

/** UTF-8 バイト列の 16 進表現。制御文字（\x7f 等）を目視で拾うために使う。 */
function toHex(s: string): string {
  const bytes = new TextEncoder().encode(s)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')
}

/** 改行・制御文字をそのまま行に混ぜないための可視化。 */
function toPrintable(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? `<${code.toString(16).padStart(2, '0')}>` : ch
  }
  return out
}

function flush() {
  timer = null
  // 判定待ちなら次の周期に持ち越す（起動直後のイベントを落とさない）。
  if (enabled === null) {
    timer = setTimeout(flush, FLUSH_MS)
    return
  }
  if (!enabled || pending.length === 0) {
    pending = []
    return
  }
  const lines = pending
  pending = []
  imeDebugLog(lines).catch(() => {})
}

/**
 * 1 イベントを記録する。`kind` はイベント種別、`data` は関係する文字列
 * （無いイベントでは空）、`extra` は状態フラグなどの補足。
 */
export function imeLog(kind: string, data = '', extra = ''): void {
  if (enabled === false) return
  const t = Date.now() - started
  const body = data ? ` "${toPrintable(data)}" [${toHex(data)}]` : ''
  pending.push(`${t}\t${kind}${body}${extra ? `\t${extra}` : ''}`)
  if (timer == null) timer = setTimeout(flush, FLUSH_MS)
}

/** セッションの区切りを入れる（起動ごとにどこからかを分かりやすくする）。 */
export function imeLogSessionStart(tabId: string): void {
  imeLog('--- session', '', `tab=${tabId} at=${new Date().toISOString()}`)
}
