/**
 * `.gitignore` の文法まわりの純粋な計算（#309）。
 *
 * IPC・確認・再読込は呼び出し側（`GitPanel.vue` の `ctxAddToGitignore`）の担当で、ここには
 * 「git がその 1 行をどう読むか」だけを置く。`diffExpand.ts` と `DiffTab.vue` の分け方と同じで、
 * この分け方だとエスケープの規則をテストできるし、別のパネルから同じ項目を出す日にも写さずに済む。
 */

/**
 * ルート相対パスから、`.gitignore` に書く 1 行を作る。
 *
 * - **先頭に `/` を付けてルートに固定する。** git は「`/` を途中に含まないパターン」を
 *   ベース名として全階層に当てるので、付けないとルート直下の `notes.txt` を足したときに
 *   `docs/notes.txt` まで無視される。ついでに先頭が `/` になるぶん、`#5.patch` が
 *   コメント行に、`!keep.txt` が否定パターンに化ける事故も起きない
 * - **glob のメタ文字はエスケープする。** `foo[1].png` のような実在する名前をそのまま書くと
 *   文字クラスとして解釈され、当のファイルに当たらない。末尾の空白も git が捨てるので、
 *   最後の 1 つだけ escape する（それより手前は末尾でなくなるので残る）
 */
export function gitignoreEntry(path: string): string {
  return `/${path.replace(/[\\[\]*?]/g, '\\$&').replace(/ $/, '\\ ')}`
}

/**
 * その行が既にあるか。**比べるのは書くのと同じ文字列**（`gitignoreEntry` を通したもの）で、
 * 生のパスと比べると、エスケープした行を書いたあとに押し直したとき「無い」と見て二重に足す。
 *
 * 読んだ行から落としてよいのは**行末の `\r` だけ**。`trim()` にすると `gitignoreEntry` が
 * 意図的に書いた末尾のエスケープ済み空白（`\ `）まで消えて、末尾に空白を持つ名前のファイルが
 * 毎回追記される。行頭の空白も git は意味のある文字として扱うので落とさない。
 */
export function hasGitignoreEntry(content: string, entry: string): boolean {
  return content.split('\n').some((line) => line.replace(/\r$/, '') === entry)
}

/**
 * 1 行を足した内容を返す。既存の改行スタイルに合わせ、末尾に改行が無ければ足してから書く。
 * 空のファイル（`allowMissing` で作る新規もこれ）は LF になる。
 */
export function appendGitignoreLine(content: string, entry: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const head = content === '' || content.endsWith('\n') ? content : content + eol
  return `${head}${entry}${eol}`
}
