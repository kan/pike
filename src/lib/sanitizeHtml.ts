/**
 * DOMPurify に渡す URI スキームの許可。**3 つのプレビュー（Markdown / rst / issue /
 * マニュアル）が共有する。**
 *
 * DOMPurify の既定は `ftp` / `tel` / `callto` / `sms` / `cid` / `xmpp` も通すので、
 * `marked` が作った `[連絡先](ftp://…)` のようなリンクがそのまま残る。ところが Pike が
 * 開けるのは http(s) と `mailto:` だけ（`lib/openUrl.ts` の `isExternalLink`）なので、
 * **押せるのに何も起きないリンク**ができていた。開けないスキームはリンクにしない。
 *
 * `javascript:` と `file:` は既定でも落ちる。ここで絞るのはその手前の話で、
 * セキュリティの境界を緩める変更ではない。
 *
 * 後半の `[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$)` は DOMPurify の既定から引き継いだ部分で、
 * **スキームを持たない URI**（相対パス・`#anchor`）を通す。プレビューのローカルリンクと
 * 見出しへのジャンプがここに乗っているので、落とさないこと。
 */
export const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
