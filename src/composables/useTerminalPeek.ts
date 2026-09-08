/**
 * ターミナルの中身を外から覗く口（#319）。
 *
 * **バックグラウンドのプロジェクトのターミナルも生きている**（#264。`TabPane` は
 * `tabs`（全部）をマウントしたまま `v-show` で出し分ける）ので、切り替えなくても
 * 「今なにをしているか」は既に手元にある。足りないのは**外から読む口**だけで、
 * それがこのファイル。
 *
 * **`useOutlineSource` と同じ形にしないこと。** あちらは「今見えているエディタ 1 つ」を
 * 指す `shallowRef` で、その不変条件に別の消費者（#307 の選択文字列）が乗っている。
 * こちらは**全ターミナル**を引ける表なので、混ぜると両方の約束が壊れる。
 *
 * **Rust に溜めない。** PTY の出力を `pty_manager` がリングバッファに持つ形も書けるが、
 * 「Rust はステートレスに」（CLAUDE.md）に反するうえ、xterm が既に描画済みのものを
 * 持っているので同じ内容を二重に抱えることになる。
 */

/**
 * 直近の出力を上から順に、最大 `lines` 行返す。
 *
 * **色は落とす**（`translateToString` はプレーンテキスト）。色まで出すには 2 つ目の
 * xterm を起こすか、セルごとの属性を読んで HTML を組むことになり、「チラ見」に対して
 * 高すぎる。
 */
export type TerminalSnapshot = (lines: number) => string[]

/** タブ id → 覗く口。`TerminalTab` が mount / unmount で出し入れする。 */
const sources = new Map<string, TerminalSnapshot>()

/** タブ id → 最後に出力が届いた時刻（epoch ms）。 */
const lastOutputAt = new Map<string, number>()

export function registerTerminalPeek(tabId: string, snapshot: TerminalSnapshot): void {
  sources.set(tabId, snapshot)
}

export function unregisterTerminalPeek(tabId: string): void {
  sources.delete(tabId)
  lastOutputAt.delete(tabId)
}

/**
 * 出力が届いたことを記録する。**PTY の出力ごとに呼ばれる**ので、ここで重いことを
 * しないこと。
 *
 * **reactive にしない**（素の `Map`）。エージェントは 1 秒に何百回も出力するので、
 * ref にすると出力のたびに再描画が走る。読むのはホバー中のポーリングだけで足りる
 * （`hasActivity` が reactive なのは、ドットを出すという別の目的があるため）。
 */
export function markTerminalOutput(tabId: string): void {
  lastOutputAt.set(tabId, Date.now())
}

/** 直近の出力。覗く口が無ければ空（タブが閉じた直後など）。 */
export function peekTerminal(tabId: string, lines: number): string[] {
  return sources.get(tabId)?.(lines) ?? []
}

/** 最後に出力が届いた時刻。まだ一度も出ていなければ `null`。 */
export function terminalLastOutputAt(tabId: string): number | null {
  return lastOutputAt.get(tabId) ?? null
}
