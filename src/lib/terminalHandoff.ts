/**
 * ターミナルを別のウィンドウへ引き継ぐための受け渡し口（#469）。
 *
 * ウィンドウごとに JS が別なので、xterm のインスタンスは移せない。移せるのは Rust 側の
 * PTY だけで、移動先は新しい xterm を作って同じ pty id につなぎ直す。そのままだと移動先は
 * 空の画面から始まるので、**移動元の xterm が解釈し終えた画面**（スクロールバック・代替画面・
 * マウスなどのモード）を `@xterm/addon-serialize` で書き出して運ぶ。
 *
 * **#264 で不採用にした「Rust にバッファを持って再アタッチする」とは別物。** あちらは生の
 * バイト列を新しい xterm へ流し込む案で、フルスクリーンの TUI は途中から流しても画面が
 * 再構築されない。こちらが運ぶのは解釈済みの画面で、つないだあとにリサイズの nudge で
 * TUI 自身にも描き直させる（`TerminalTab.vue`）。
 *
 * ここに置くのは 3 つの表だけ（`useTerminalPeek` と同じ形）。段取りは
 * `stores/project.ts` の `moveProject` が持つ。
 */

/** 書き出した画面。`data` は同じ大きさの xterm に書けば元の画面になる。 */
export interface TerminalScreen {
  cols: number
  rows: number
  data: string
}

type ScreenExporter = () => Promise<TerminalScreen | null>

/** タブ id → 画面を書き出す口。`TerminalTab` が mount / unmount で出し入れする。 */
const exporters = new Map<string, ScreenExporter>()

export function registerTerminalExport(tabId: string, exporter: ScreenExporter): void {
  exporters.set(tabId, exporter)
}

export function unregisterTerminalExport(tabId: string): void {
  exporters.delete(tabId)
}

/** 画面を書き出す。口が無い（まだ mount していない）か、書き出せなければ null。 */
export async function exportTerminalScreen(tabId: string): Promise<TerminalScreen | null> {
  const exporter = exporters.get(tabId)
  if (!exporter) return null
  // **待ちに上限を置く。** 書き出しは xterm の書き込みが流れ切るのを待つが、そのあいだに
  // タブが閉じられると（終了の 1 秒後の自動クローズなど）その合図が来ない。待ち続けると、
  // 呼び出し側（`moveProject`）が出力を預からせたまま止まる。
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), EXPORT_TIMEOUT_MS))
  return Promise.race([exporter().catch(() => null), timeout])
}

const EXPORT_TIMEOUT_MS = 3000

/**
 * 別のウィンドウへ渡したターミナルのタブ（移動元の側）。**unmount で PTY を止めない印。**
 * `TerminalTab` は unmount のたびに自分の PTY を kill するので、印が無いと渡した先の
 * シェルが止まる。
 */
const handedOff = new Set<string>()

export function markTerminalHandedOff(tabId: string): void {
  handedOff.add(tabId)
}

/** 印を読んで消す。`TerminalTab` の unmount が 1 回だけ呼ぶ。 */
export function takeTerminalHandedOff(tabId: string): boolean {
  return handedOff.delete(tabId)
}

/**
 * 別のウィンドウから受け取ったターミナルのタブ（移動先の側）。タブ id → 運ばれてきた画面。
 * **載っていること自体が「シェルを起こさず、タブの `ptyId` につなぐ」の合図**で、画面は
 * 書き出せなかったとき null（つなぐだけで、空の画面から始まる）。
 *
 * タブの欄にしないのは、画面が数 MB になりうるため（タブは reactive で、セッションの
 * 書き出しの deep watch にも載る）。
 */
const incoming = new Map<string, TerminalScreen | null>()

export function stashIncomingTerminal(tabId: string, screen: TerminalScreen | null): void {
  incoming.set(tabId, screen)
}

/** 受け取ったターミナルなら画面（無ければ null）を、そうでなければ undefined を返して消す。 */
export function takeIncomingTerminal(tabId: string): TerminalScreen | null | undefined {
  const screen = incoming.get(tabId)
  incoming.delete(tabId)
  return screen
}
