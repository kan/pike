// origin URL から既知のホスティングサービスを検出し、コミット / リポジトリ TOP の URL を組み立てる。
// 未知のホストは null を返し、UI 側で関連メニュー / ボタンを非表示にする。

export type Provider = 'github' | 'gitlab' | 'bitbucket' | 'codeberg'

const PROVIDERS: Record<string, { provider: Provider; label: string }> = {
  'github.com': { provider: 'github', label: 'GitHub' },
  'gitlab.com': { provider: 'gitlab', label: 'GitLab' },
  'bitbucket.org': { provider: 'bitbucket', label: 'Bitbucket' },
  'codeberg.org': { provider: 'codeberg', label: 'Codeberg' },
}

interface ParsedRemote {
  provider: Provider
  label: string
  baseUrl: string
}

/**
 * origin URL を host と repo パス（前後のスラッシュと `.git` を落としたもの）に割る。
 * ホストは問わない: プロバイダの判定はこの上の層の仕事で、`normalizeRemoteUrl` は
 * 自前ホストにも答える必要がある。null は「remote URL に見えない」。
 */
function splitRemote(url: string | null | undefined): { host: string; path: string } | null {
  const raw = url?.trim()
  if (!raw) return null
  let host: string
  let path: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      host = u.host
      path = u.pathname
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
  return { host, path: repo }
}

function parseRemote(url: string | null): ParsedRemote | null {
  const split = splitRemote(url)
  if (!split) return null
  const { host, path } = split

  const meta = PROVIDERS[host]
  if (!meta) return null

  // owner/repo 形式想定 (GitLab はグループ多段あり)。`.git` は splitRemote が落とし済み
  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const repo = segments.pop() as string
  const owner = segments.join('/')
  return { ...meta, baseUrl: `https://${host}/${owner}/${repo}` }
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

export interface RemoteLink {
  url: string
  label: string
  provider: Provider
}

export function buildCommitLink(remoteUrl: string | null, hash: string): RemoteLink | null {
  const parsed = parseRemote(remoteUrl)
  if (!parsed) return null
  let url: string
  switch (parsed.provider) {
    case 'github':
    case 'codeberg':
      url = `${parsed.baseUrl}/commit/${hash}`
      break
    case 'gitlab':
      url = `${parsed.baseUrl}/-/commit/${hash}`
      break
    case 'bitbucket':
      url = `${parsed.baseUrl}/commits/${hash}`
      break
  }
  return { url, label: parsed.label, provider: parsed.provider }
}

export function buildRepoLink(remoteUrl: string | null): RemoteLink | null {
  const parsed = parseRemote(remoteUrl)
  if (!parsed) return null
  return { url: parsed.baseUrl, label: parsed.label, provider: parsed.provider }
}
