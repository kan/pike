/**
 * 分割表示のスクロール同期で、どちらのペインが相手を動かしてよいかを決める（#465）。
 *
 * 片方の scroll を相手へ写すと、書かれた相手も scroll を出す。これを利用者のスクロールとして
 * 写し返すと、操作中のペインが 1 フレーム前の位置へ書き戻される。往復のたびに位置が丸められ、
 * CodeMirror は見えた行を測り直して高さを変えるので、書き戻しは元の位置に戻らず、スクロールが
 * 引き戻される。
 *
 * **「書いた直後の 1 フレームだけ無視する」形にしないこと。** scroll のハンドラの中で張った
 * `requestAnimationFrame` は同じフレームのうちに走り、相手の scroll が届くのは次のフレームなので、
 * 無視が 1 回も効かない（Edge で実測。60 回のホイールで 86px 引き戻された）。
 *
 * 跳ね返りは 2 つの条件で見分ける。どちらかに当たれば写さない。
 *
 * - **書いた位置のままで届いた scroll**（`wrote` で覚えた位置と一致）。時間に依らないので、
 *   メインスレッドが塞がって遅れて届いた跳ね返りも、下の `release` のあとに届いた跳ね返りも
 *   落とせる。その位置は相手から写したものなので、写し返さなくても 2 つのペインは合っている
 * - **追従中のペインの scroll**。写した相手を `FOLLOW_HOLD_MS` のあいだ追従中として覚える。
 *   書いたあとに CodeMirror が高さを測り直して自分で位置をずらすと、位置が一致しない scroll が
 *   出るので、上の条件だけでは足りない。追従は写すたびに延び、スムーズスクロールのあいだは続く
 *
 * **利用者が追従中のペインを直接動かしたら、追従をその場で解く**（`release`）。待つだけに
 * すると、持ち替えた直後の scroll が捨てられ、そこで止まると 2 つのペインがずれたまま残る。
 */

export type SyncPane = 'editor' | 'preview'

/** 最後に写してから、相手の scroll を跳ね返りとみなす時間（ms）。 */
export const FOLLOW_HOLD_MS = 150

export function createScrollFollow(now: () => number = () => performance.now()) {
  let follower: SyncPane | null = null
  let until = 0
  const written: Record<SyncPane, number | null> = { editor: null, preview: null }
  return {
    /**
     * 位置 `top` にいる `from` の scroll を相手へ写してよいか。写してよければ、相手を追従中に
     * する。写したら、相手に実際に入った位置を `wrote` で知らせる。
     */
    claim(from: SyncPane, top: number): boolean {
      const expected = written[from]
      // 設定した値は端末のピクセルへ丸められるので、1px 未満の差は同じ位置として扱う。
      // 覚えた位置は 1 回で使い切る（残すと、あとで利用者が同じ位置へ動かした scroll まで落とす）。
      written[from] = null
      if (expected !== null && Math.abs(top - expected) < 1) return false
      if (follower === from && now() < until) return false
      follower = from === 'editor' ? 'preview' : 'editor'
      until = now() + FOLLOW_HOLD_MS
      return true
    },
    /** 同期が `pane` を位置 `top` へ動かした（代入したあとに読み直した値を渡す）。 */
    wrote(pane: SyncPane, top: number) {
      written[pane] = top
    },
    /** 利用者が `pane` を直接動かし始めた（ホイール・スクロールバー・キー・タッチ）。 */
    release(pane: SyncPane) {
      if (follower === pane) follower = null
    },
  }
}
