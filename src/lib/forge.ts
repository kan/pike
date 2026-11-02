// ホスティングサービスの表（#541）。origin の URL からサービスを引き、リポジトリ・コミット・
// ファイルの行の URL を組み立てる。未知のホストは null を返し、UI 側で関連メニュー / ボタンを出さない。
//
// **サービスの差はこの表に閉じ込める。** 呼び出し側に `kind === 'github'` を書かず、表の欄
// （`issues` / `newIssue` / `icon` …）を読む。サービスを足すときは `FORGES` に 1 行足す。
//
// origin の URL の分解と正規化は `gitRemote.ts`（同期も使う、Vue に依存しない純粋な関数）。
// こちらはアイコン（Vue のコンポーネント）を持つので分けてある。
import { Archive, GitBranch, Github, Gitlab } from 'lucide-vue-next'
import type { Component } from 'vue'
import type { IssueForge } from '../types/issues'
import { splitRemote } from './gitRemote'

/**
 * サービスの種類。**Codeberg は `gitea`**（Forgejo で、URL の形は Gitea と同じ）。表示名は
 * ホストの側（`KNOWN_HOSTS` の `label`）で「Codeberg」のまま出す。
 */
export type ForgeKind = 'github' | 'gitlab' | 'bitbucket' | 'gitea'

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

/** 公開されているホスト。`label` はサービスの表示名と違うときだけ書く。 */
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
  /** リポジトリのページ（`https://<host>/<owner>/<repo>`）。 */
  baseUrl: string
  icon: Component
  issues: IssueForge | null
  newIssueUrl: string | null
}

/** origin の URL からサービスを引く。**唯一の入口**で、URL を組む関数もパネルの可否もここを通る。 */
export function parseForge(url: string | null): Forge | null {
  const split = splitRemote(url)
  if (!split) return null
  const { host, path } = split

  const known = KNOWN_HOSTS[host]
  if (!known) return null

  // owner/repo 形式想定 (GitLab はグループ多段あり)。`.git` は splitRemote が落とし済み
  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const def = FORGES[known.kind]
  const baseUrl = `https://${host}/${segments.join('/')}`
  return {
    kind: known.kind,
    label: known.label ?? def.label,
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
