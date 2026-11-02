// origin の URL の分解と正規化。**Vue にもストアにも依存しない純粋な関数だけを置く**（同期の
// マージとテストが読む）。ホスティングサービスの表と URL の組み立ては `forge.ts`（#541）。

/**
 * origin URL を host と repo パス（前後のスラッシュと `.git` を落としたもの）に割る。
 * ホストは問わない: サービスの判定はこの上の層（`forge.ts` の `parseForge`）の仕事で、
 * `normalizeRemoteUrl` は自前ホストにも答える必要がある。null は「remote URL に見えない」。
 *
 * `scheme` は URL の形の remote のスキーム（`https` / `ssh` など。SCP 形式なら無い）。web の URL を
 * 推すのに使う（http(s) の remote ならそのポートで web も配っている、SSH のポートは web と別）。
 */
export function splitRemote(url: string | null | undefined): { host: string; path: string; scheme?: string } | null {
  const raw = url?.trim()
  if (!raw) return null
  let host: string
  let path: string
  let scheme: string | undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      host = u.host
      path = u.pathname
      scheme = u.protocol.replace(/:$/, '').toLowerCase()
    } catch {
      return null
    }
  } else {
    // SCP 形式: [user@]host:owner/repo(.git)。スキーム判定より後に見ること
    // （先に見ると `https` をホストとして拾う）。1 文字ホストは Windows の
    // ドライブレター（`C:\src\foo`。ローカルクローンの origin に現れる）なので除く
    const scp = raw.match(/^(?:[^@/]+@)?([^/:]{2,}):(.+)$/)
    if (!scp) return null
    host = scp[1]
    path = scp[2]
  }
  const repo = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!host || !repo) return null
  return scheme ? { host, path: repo, scheme } : { host, path: repo }
}

/**
 * 同じリポジトリの origin URL が同じ文字列になるキー（`host/owner/repo`）。
 * `git@github.com:kan/pike.git` と `https://github.com/kan/pike` が一致する。
 * remote URL に見えないときは null。
 *
 * 小文字化するのは、これが「同じリポジトリか」を判定するためのキーだから。
 * パスの大小だけが違う 2 つのリポジトリをここで区別する意味はない。
 */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  const split = splitRemote(url)
  return split && `${split.host}/${split.path}`.toLowerCase()
}

/**
 * `current` を `wanted` に差し替えてよいか（#403）: **同じリポジトリの書き方違いだけ**。
 * 別のリポジトリ（fork と upstream など）を指していたら差し替えない。確認なしに差し替えると、
 * 次の push が別のリポジトリへ飛ぶ。同期で origin をそろえる 2 か所（同期の反映と、
 * プロジェクトを開いたときの記録）がこの判定を共有する。
 */
export function isRespelling(current: string | null | undefined, wanted: string | null | undefined): boolean {
  if (!current || !wanted || current === wanted) return false
  const key = normalizeRemoteUrl(current)
  return key !== null && key === normalizeRemoteUrl(wanted)
}
