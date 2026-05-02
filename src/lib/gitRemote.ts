// origin URL から既知のホスティングサービスを検出し、コミットページの URL を組み立てる。
// 未知のホストは null を返し、UI 側で「リモートで開く」メニューを非表示にする。

type Provider = 'github' | 'gitlab' | 'bitbucket' | 'codeberg'

const PROVIDERS: Record<string, { provider: Provider; label: string }> = {
  'github.com': { provider: 'github', label: 'GitHub' },
  'gitlab.com': { provider: 'gitlab', label: 'GitLab' },
  'bitbucket.org': { provider: 'bitbucket', label: 'Bitbucket' },
  'codeberg.org': { provider: 'codeberg', label: 'Codeberg' },
}

interface ParsedRemote {
  provider: Provider
  label: string
  host: string
  owner: string
  repo: string
}

function parseRemote(url: string | null): ParsedRemote | null {
  if (!url) return null
  let host: string
  let path: string

  // SCP 形式: git@host:owner/repo(.git)
  const scp = url.match(/^[\w.-]+@([^:]+):(.+?)(?:\.git)?\/?$/)
  if (scp) {
    host = scp[1]
    path = scp[2]
  } else {
    const normalized = url.trim()
    if (!/^[a-z]+:\/\//i.test(normalized)) return null
    try {
      const u = new URL(normalized)
      host = u.host
      path = u.pathname.replace(/^\//, '').replace(/\.git\/?$/, '')
    } catch {
      return null
    }
  }

  const meta = PROVIDERS[host]
  if (!meta) return null

  // owner/repo 形式想定 (GitLab はグループ多段あり)
  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const repo = segments.pop() as string
  const owner = segments.join('/')
  return { ...meta, host, owner, repo: repo.replace(/\.git$/, '') }
}

export interface CommitLink {
  url: string
  label: string
}

export function buildCommitLink(remoteUrl: string | null, hash: string): CommitLink | null {
  const parsed = parseRemote(remoteUrl)
  if (!parsed) return null
  const base = `https://${parsed.host}/${parsed.owner}/${parsed.repo}`
  let url: string
  switch (parsed.provider) {
    case 'github':
    case 'codeberg':
      url = `${base}/commit/${hash}`
      break
    case 'gitlab':
      url = `${base}/-/commit/${hash}`
      break
    case 'bitbucket':
      url = `${base}/commits/${hash}`
      break
  }
  return { url, label: parsed.label }
}
