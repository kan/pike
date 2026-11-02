// ホスティングサービスの表（#541）。origin の URL からサービスを引き、リポジトリ・コミット・
// ファイルの行の URL を組み立てる。未知のホストは null を返し、UI 側で関連メニュー / ボタンを出さない。
//
// **サービスの差はこの表に閉じ込める。** 呼び出し側に `kind === 'github'` を書かず、表の欄
// （`issues` / `newIssue` / `icon` …）を読む。サービスを足すときは `FORGES` に 1 行足す。
//
// origin の URL の分解と正規化は `gitRemote.ts`（同期も使う、Vue に依存しない純粋な関数）。
// こちらはアイコン（Vue のコンポーネント）を持つので分けてある。
import { Archive, GitBranch, Github, Gitlab } from 'lucide-vue-next'
import { type Component, shallowRef } from 'vue'
import type { IssueForge } from '../types/issues'
import { splitRemote } from './gitRemote'

/**
 * サービスの種類。**Codeberg は `gitea`**（Forgejo で、URL の形は Gitea と同じ）。表示名は
 * ホストの側（`KNOWN_HOSTS` の `label`）で「Codeberg」のまま出す。`bitbucket-dc` は自前の
 * Bitbucket（Data Center / Server）で、URL の形が Cloud と違う。
 */
export const FORGE_KINDS = ['github', 'gitlab', 'bitbucket', 'bitbucket-dc', 'gitea'] as const
export type ForgeKind = (typeof FORGE_KINDS)[number]

export function isForgeKind(v: unknown): v is ForgeKind {
  return (FORGE_KINDS as readonly unknown[]).includes(v)
}

type LineRange = { start: number; end: number }

/** `buildFileLink` に渡す、どのファイルのどの行か（#540）。 */
export interface FileLinkTarget {
  /** リモートにあるコミットの完全な SHA。`branch` があるときは `origin/<branch>` のもの。 */
  commit: string
  /** ブランチ名で開くとき（HEAD が未 push）。無ければ `commit` の permalink。 */
  branch?: string
  /** リポジトリのトップからのパス（`/` 区切り）。 */
  path: string
  range: LineRange | null
  /** Markdown のファイル。レンダリングされると行のアンカーが効かないので、ソースの表示を頼む。 */
  markdown: boolean
}

interface ForgeDef {
  label: string
  /** ステータスバーのリポジトリのリンクのアイコン。 */
  icon: Component
  /**
   * リポジトリのページ。`segments` は remote のパス（`.git` を落として `/` で割ったもの）。
   * 組めなければ null。無ければ `<web>/<segments>`（GitHub の `owner/repo`、GitLab の多段のグループ）。
   */
  repo?(web: string, segments: string[]): string | null
  commit(base: string, sha: string): string
  file(base: string, target: FileLinkTarget): string
  /**
   * 新しい issue を作るページ。「+」は issue パネルのヘッダにあるので、**使われるのは `issues` も
   * 持つサービスだけ**（`stores/issues.ts` の `newIssueUrl`）。無いサービスでは「+」を出さない。
   */
  newIssue?(base: string): string
  /** issue / PR のパネルに使うサービス。無ければパネルを出さない。 */
  issues?: IssueForge
}

/** パスとブランチ名はセグメントごとに符号化する（`#` や空白を含む名前がある。`/` は残す）。 */
function encodeSegments(s: string): string {
  return s.split('/').map(encodeURIComponent).join('/')
}

/** 行のアンカー。`multi` は範囲の終わりの付け方（`L10-L30` / `L10-30` / `lines-10:30`）。 */
function lineAnchor(range: LineRange | null, prefix: string, multi: (end: number) => string): string {
  if (!range) return ''
  return `#${prefix}${range.start}${range.end !== range.start ? multi(range.end) : ''}`
}

/**
 * サービスごとの URL の形。ファイルの行（#540）の出典は issue #540 の表（Git Web Links の handler の
 * テストケース）。
 *
 * - Markdown のソース表示は GitHub と GitLab が `?plain=1`、Gitea が `?display=source`。
 *   **Bitbucket には無い**ので付けない（レンダリングされ、行へ飛ばないことがある）
 * - **Bitbucket はブランチ名に `/` があると `src/` の直後に置けない**ので、パスには SHA を置き、
 *   ブランチは `?at=` で渡す
 */
const FORGES: Record<ForgeKind, ForgeDef> = {
  github: {
    label: 'GitHub',
    icon: Github,
    commit: (base, sha) => `${base}/commit/${sha}`,
    file: (base, t) =>
      `${base}/blob/${encodeSegments(t.branch ?? t.commit)}/${encodeSegments(t.path)}` +
      (t.markdown ? '?plain=1' : '') +
      lineAnchor(t.range, 'L', (end) => `-L${end}`),
    newIssue: (base) => `${base}/issues/new`,
    issues: 'github',
  },
  gitlab: {
    label: 'GitLab',
    icon: Gitlab,
    commit: (base, sha) => `${base}/-/commit/${sha}`,
    file: (base, t) =>
      `${base}/-/blob/${encodeSegments(t.branch ?? t.commit)}/${encodeSegments(t.path)}` +
      (t.markdown ? '?plain=1' : '') +
      lineAnchor(t.range, 'L', (end) => `-${end}`),
  },
  bitbucket: {
    label: 'Bitbucket',
    icon: Archive,
    commit: (base, sha) => `${base}/commits/${sha}`,
    file: (base, t) => {
      const path = encodeSegments(t.path)
      const head = t.branch?.includes('/')
        ? `${base}/src/${t.commit}/${path}?at=${encodeURIComponent(t.branch)}`
        : `${base}/src/${encodeSegments(t.branch ?? t.commit)}/${path}`
      return head + lineAnchor(t.range, 'lines-', (end) => `:${end}`)
    },
  },
  /**
   * 自前の Bitbucket（Data Center / Server）。形は Git Web Links の `bitbucket-server.json`。
   * remote は `ssh://git@host:7999/<project>/<repo>.git` か `https://host/<context>/scm/<project>/<repo>.git`
   * なので、**末尾の 2 つ**を project と repo にする（コンテキストパスは設定の `webBase` に書く）。
   * 個人の repo は project が `~<user>` で、ページは `/users/<user>/repos/<repo>`。
   */
  'bitbucket-dc': {
    label: 'Bitbucket Data Center',
    icon: Archive,
    repo: (web, segments) => {
      const [project, repo] = segments.slice(-2)
      if (!project || !repo) return null
      return project.startsWith('~')
        ? `${web}/users/${encodeURIComponent(project.slice(1))}/repos/${encodeURIComponent(repo)}`
        : `${web}/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}`
    },
    commit: (base, sha) => `${base}/commits/${sha}`,
    // ref は `/` ごと符号化する（ブランチは `refs/heads/<name>`）。
    file: (base, t) =>
      `${base}/browse/${encodeSegments(t.path)}?at=${encodeURIComponent(t.branch ? `refs/heads/${t.branch}` : t.commit)}` +
      lineAnchor(t.range, '', (end) => `-${end}`),
  },
  gitea: {
    label: 'Gitea',
    // lucide に専用のアイコンが無いので、汎用の Git のアイコンで代用する。
    icon: GitBranch,
    commit: (base, sha) => `${base}/commit/${sha}`,
    file: (base, t) =>
      (t.branch
        ? `${base}/src/branch/${encodeSegments(t.branch)}/${encodeSegments(t.path)}`
        : `${base}/src/commit/${t.commit}/${encodeSegments(t.path)}`) +
      (t.markdown ? '?display=source' : '') +
      lineAnchor(t.range, 'L', (end) => `-L${end}`),
  },
}

/** 公開されているホスト。`label` はサービスの表示名と違うときだけ書く。設定の対応付けが先に効く。 */
const KNOWN_HOSTS: Record<string, { kind: ForgeKind; label?: string }> = {
  'github.com': { kind: 'github' },
  'gitlab.com': { kind: 'gitlab' },
  'bitbucket.org': { kind: 'bitbucket' },
  'codeberg.org': { kind: 'gitea', label: 'Codeberg' },
}

/** origin が指すサービスとリポジトリ。 */
export interface Forge {
  kind: ForgeKind
  /** 表示名（ホストで上書きされていればそちら）。 */
  label: string
  /** リポジトリのページ（`https://<host>/<owner>/<repo>`。web の頭は設定の `webBase` で変わる）。 */
  baseUrl: string
  icon: Component
  issues: IssueForge | null
  newIssueUrl: string | null
}

/**
 * 自前ホストの対応付け（#541 段階 2。設定の `forgeHosts`、同期の対象）。**ホスト名から推測しない**
 * （名前に `gitlab` が入っていても GitLab とはみなさない）ので、公開ホスト以外はここに書いたものだけ。
 */
export interface ForgeHost {
  /** remote の URL に現れるホスト（SSH の Host 別名もそのまま書ける）。小文字。 */
  host: string
  /**
   * サービスの種類。**`string` のまま持つ**: 新しい版の Pike が足した種類を古い版が消すと、
   * 同期でほかのマシンの設定まで消える。引くときに `isForgeKind` で見て、知らなければ無視する。
   */
  kind: string
  /** web の URL の頭（既定は `https://<ホスト名>`）。Host 別名、ポート、コンテキストパスのとき書く。 */
  webBase?: string
  /** 表示名（「{名前} で開く」）。無ければ種類の名前。 */
  name?: string
}

/**
 * `webBase` を `<scheme>://<host>[:port][/path]`（末尾の `/` なし）に揃える。http(s) の URL でなければ
 * `undefined`（設定画面はそれを見て、受け付けなかったことを知らせる）。
 */
export function normalizeWebBase(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  try {
    const u = new URL(v.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
}

/**
 * ホストの欄の値を、remote のホストと比べられる形にする。remote の URL や `git@host` を貼られても
 * 当たるよう、スキーム・`user@`・パスを落として小文字にする。空白を含むものは空にする（捨てる）。
 */
export function normalizeForgeHost(v: string): string {
  const host = v
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .replace(/\/.*$/, '')
    // SCP 形式（`host:owner/repo`）の `:` 以降を落とす。ポート（`host:7999`）は残す。
    .replace(/:(?!\d+$).*$/, '')
  return /\s/.test(host) ? '' : host
}

/**
 * 設定の値を検証する（読み込み・同期・設定画面が通る）。ホストは `normalizeForgeHost` で揃えて
 * 重複を落とす（先の行が残る）。**知らない種類は残す**（`ForgeHost.kind` の doc）。
 */
export function sanitizeForgeHosts(v: unknown): ForgeHost[] {
  if (!Array.isArray(v)) return []
  const out: ForgeHost[] = []
  const seen = new Set<string>()
  for (const e of v) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const host = typeof r.host === 'string' ? normalizeForgeHost(r.host) : ''
    const kind = typeof r.kind === 'string' ? r.kind.trim() : ''
    if (!host || !kind || seen.has(host)) continue
    seen.add(host)
    const webBase = normalizeWebBase(r.webBase)
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined
    out.push({ host, kind, ...(webBase && { webBase }), ...(name && { name }) })
  }
  return out
}

/**
 * 今の対応付け。**設定ストアが流し込む**（`setForgeHosts`。`lib/fileType.ts` の SQL の方言と同じ形）。
 * このモジュールはストアから import されるので、ここからストアを読むと循環する。`shallowRef` なので、
 * `parseForge` を呼ぶ computed は対応付けが変わると組み直される。
 */
const forgeHosts = shallowRef<readonly ForgeHost[]>([])

/**
 * **中身が同じなら差し替えない。** 設定は 1 つ変わるたびに丸ごと読み直され（他のウィンドウからの
 * 配信も同じ）、`sanitizeForgeHosts` は毎回新しい配列を返すので、そのままでは関係の無い設定の変更で
 * `parseForge` を読む computed が全部組み直される。
 */
export function setForgeHosts(hosts: readonly ForgeHost[]): void {
  if (sameForgeHosts(hosts, forgeHosts.value)) return
  forgeHosts.value = hosts
}

/**
 * 2 つの一覧が同じか。どちらも `sanitizeForgeHosts` を通ったもの（欄の並びが揃っている）を比べる。
 * 設定画面の「変わらなければ書かない」と `setForgeHosts` が共有する。
 */
export function sameForgeHosts(a: readonly ForgeHost[], b: readonly ForgeHost[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 種類の表示名（設定画面の選択肢）。知らない種類（新しい版の Pike が書いたもの）はそのまま返す。 */
export function forgeKindLabel(kind: string): string {
  return isForgeKind(kind) ? FORGES[kind].label : kind
}

/**
 * web の URL を書かなかったときの既定。**http(s) の remote なら、そのスキームとポートのまま**
 * （同じサーバーが web も配っている）。SSH の remote（と SCP 形式）は `https://<ポートを落としたホスト>`
 * （SSH のポートは web と別）。設定画面のヒントは remote を知らないので、後者を出す。
 */
export function defaultWebBase(host: string, scheme?: string): string {
  const h = host.toLowerCase()
  if (scheme === 'https' || scheme === 'http') return `${scheme}://${h}`
  return `https://${h.replace(/:\d+$/, '')}`
}

/**
 * ホストを引く。**設定の対応付けが先**、無ければ公開ホスト。remote のホストはポート付き
 * （`host:7999`）で来ることがあるので、**ポート付きの完全一致を先に**、無ければポート無しで引く。
 */
function lookupHost(host: string, scheme?: string): { kind: ForgeKind; label?: string; web: string } | null {
  const h = host.toLowerCase()
  const bare = h.replace(/:\d+$/, '')
  const mapped = forgeHosts.value.find((e) => e.host === h) ?? forgeHosts.value.find((e) => e.host === bare)
  if (mapped && isForgeKind(mapped.kind)) {
    return { kind: mapped.kind, label: mapped.name, web: mapped.webBase ?? defaultWebBase(h, scheme) }
  }
  // 公開ホストの web はポートを持たない（`ssh://git@github.com:22/...` のような remote でも引く）。
  const known = KNOWN_HOSTS[bare]
  return known ? { ...known, web: `https://${bare}` } : null
}

/** origin の URL からサービスを引く。**唯一の入口**で、URL を組む関数もパネルの可否もここを通る。 */
export function parseForge(url: string | null): Forge | null {
  const split = splitRemote(url)
  if (!split) return null
  const found = lookupHost(split.host, split.scheme)
  if (!found) return null

  // owner/repo 形式想定 (GitLab はグループ多段あり)。`.git` は splitRemote が落とし済み
  const segments = split.path.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const def = FORGES[found.kind]
  const baseUrl = def.repo ? def.repo(found.web, segments) : `${found.web}/${segments.join('/')}`
  if (!baseUrl) return null
  return {
    kind: found.kind,
    label: found.label ?? def.label,
    baseUrl,
    icon: def.icon,
    issues: def.issues ?? null,
    newIssueUrl: def.newIssue?.(baseUrl) ?? null,
  }
}

export interface RemoteLink {
  url: string
  label: string
}

/** URL を組む共通の形。サービスを引けなければ null（呼び出し側は項目を出さない）。 */
function linkOf(remoteUrl: string | null, url: (forge: Forge, def: ForgeDef) => string): RemoteLink | null {
  const forge = parseForge(remoteUrl)
  return forge && { url: url(forge, FORGES[forge.kind]), label: forge.label }
}

export function buildCommitLink(remoteUrl: string | null, hash: string): RemoteLink | null {
  return linkOf(remoteUrl, (f, def) => def.commit(f.baseUrl, hash))
}

/** ファイルの行を指す URL（#540）。形は `FORGES` の `file`。 */
export function buildFileLink(remoteUrl: string | null, target: FileLinkTarget): RemoteLink | null {
  return linkOf(remoteUrl, (f, def) => def.file(f.baseUrl, target))
}
