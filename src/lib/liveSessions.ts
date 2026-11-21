/**
 * 今動いている Claude Code のセッションの一覧（#625）の、ストアを読まない計算。並べ方と、
 * セッションの居る場所からプロジェクトや worktree を引く規則をここに置く
 * （`tests/liveSessions.test.ts`）。
 */

import type { LiveSession, LiveSessionList, LiveStatus } from '../types/liveSession'
import { installKey, type ShellType, shellToPlatform } from '../types/tab'
import { type AgentId, agentById } from './agents'
import { basename, stripTrailingSep } from './paths'
import { isSameOrUnder, type ProjectPlatform, rootKey } from './projectPaths'

/**
 * グループの並び。**返答待ちが先頭**: 利用者が手を出さないと進まないものから見せる。次が
 * 稼働中（見守るもの）、アイドル（今は何もしていないもの）、最後が最近（Codex の、動いているか
 * 分からないもの）。
 */
const LIVE_STATUS_ORDER: readonly LiveStatus[] = ['waiting', 'busy', 'idle', 'recent']

/** 状態の表示名（i18n のキー）。パネルとタブが共有する。 */
export function liveStatusKey(status: LiveStatus): string {
  return `liveSessions.${status}`
}

/**
 * 状態ごとに分ける。空のグループは返さない。グループの中は**状態が変わった時刻の新しい順**
 * （返答待ちになったばかりのものが上に来る）。**並びの正本はここ**（Rust は並べない）。
 */
export function groupLiveSessions<T extends LiveSession>(
  sessions: readonly T[],
): { status: LiveStatus; sessions: T[] }[] {
  return LIVE_STATUS_ORDER.flatMap((status) => {
    const list = sessions.filter((s) => s.status === status).sort((a, b) => (b.statusSince ?? 0) - (a.statusSince ?? 0))
    return list.length > 0 ? [{ status, sessions: list }] : []
  })
}

/**
 * `path` を含む（同じか、その下にある）もののうち、**root がいちばん深いもの**。`repo` と
 * その下の `repo/packages/web` の両方が当たるなら後者。プロジェクトを引くのにも、worktree を
 * 引くのにも使う（`repo` の中に作った worktree は `repo` の下にもある）。
 */
export function deepestContaining<T>(
  items: readonly T[],
  path: string,
  rootOf: (item: T) => string,
  platformOf: (item: T) => ProjectPlatform,
): T | null {
  let best: T | null = null
  for (const item of items) {
    if (!isSameOrUnder(rootOf(item), path, platformOf(item))) continue
    if (!best || rootKey(rootOf(item)).length > rootKey(rootOf(best)).length) best = item
  }
  return best
}

/**
 * セッションの環境を見分ける鍵（#633）。`installKey` と同じ区分で、**WSL の distro の名前だけ大小を
 * 区別しない**（`wsl -d ubuntu` も `Ubuntu` に当たる。Rust の `environments` も大小を無視して畳むので、
 * 一覧・タブ・プロジェクトで綴りが違いうる）。パスの比較は変えない（Linux のパスは大小を区別する）。
 * 一覧の環境を比べるところは全部これを通す（`projectForCwd`・`liveSessionTabKey`・`liveListKey`・
 * 見出しの環境の数）。
 */
export function livePlaceKey(shell: ShellType): string {
  return shell.kind === 'wsl' ? `wsl:${shell.distro.toLowerCase()}` : installKey(shell)
}

/**
 * セッションの居るディレクトリ（`cwd`）を含む登録済みのプロジェクト（いちばん深いもの）。
 *
 * **同じ環境（`livePlaceKey`）のプロジェクトだけを見る**: `shell` は一覧を読んだアカウントの
 * シェルで、WSL のセッションの `/home/...` を Windows のプロジェクトと、別の distro の同じ
 * パスと取り違えない。
 */
export function projectForCwd<P extends { root: string; shell: ShellType }>(
  cwd: string,
  shell: ShellType,
  projects: readonly P[],
): P | null {
  const place = livePlaceKey(shell)
  return deepestContaining(
    projects.filter((p) => livePlaceKey(p.shell) === place),
    cwd,
    (p) => p.root,
    (p) => shellToPlatform(p.shell),
  )
}

/** 一覧に出す名前。題が無ければ Claude Code の付けた名前、それも無ければディレクトリ名。 */
export function liveSessionLabel(s: Pick<LiveSession, 'title' | 'name' | 'cwd'>): string {
  return s.title || s.name || basename(stripTrailingSep(s.cwd)) || s.cwd
}

/**
 * アカウントの見出し（#633）。「Claude Code · alice@example.com」のように、エージェントの名前と
 * アカウント（メールアドレス、無ければ設定ディレクトリの名前）を並べる。`withPlace` のときは
 * 環境（`WSL: Ubuntu` / `Windows`）も足す（一覧が 2 つ以上の環境にまたがるときだけ要る）。
 */
export function liveListTitle(
  list: Pick<LiveSessionList, 'agent' | 'shell' | 'account' | 'configDir'>,
  withPlace: boolean,
): string {
  const who = list.account ?? basename(stripTrailingSep(list.configDir))
  const place = withPlace ? livePlaceLabel(list.shell) : null
  return [agentById(list.agent)?.label ?? list.agent, who, place].filter(Boolean).join(' · ')
}

/** 環境の短い名前。固有名詞なので i18n に出さない（`shellProfileLabel` と同じ扱い）。 */
export function livePlaceLabel(shell: ShellType): string {
  if (shell.kind === 'wsl') return `WSL: ${shell.distro}`
  return shell.kind === 'unix' ? 'Local' : 'Windows'
}

/**
 * 行の描画の鍵。**セッション id だけでは重なる**: `claude --resume` で同じ会話を 2 つ目のプロセスが
 * 開くと、同じ id の記録が 2 つ並ぶ。pid は Codex に無いので、id と組にする。
 */
export function liveRowKey(row: Pick<LiveSession, 'pid' | 'sessionId'>): string {
  return `${row.pid ?? ''}:${row.sessionId}`
}

/**
 * セッションとターミナルのタブを突き合わせる鍵（#633）。**エージェント・環境・セッション id の組**:
 * 一覧はアカウントと環境をまたぐので、id だけだと、同じ会話を写した別の環境の行がそのタブを指す。
 * **Claude の設定ディレクトリは入れない**（タブはそれを知らない。mod の報告にも保存にも無い）。
 * 同じ環境の同じエージェントで id が重なるのは、記録のディレクトリごと写したときだけ。
 */
export function liveSessionTabKey(agent: AgentId, shell: ShellType, sessionId: string): string {
  return `${agent}\n${livePlaceKey(shell)}\n${sessionId}`
}

/** 一覧を見分ける鍵（エージェント・環境・設定ディレクトリ）。描画の `key` と行の持ち主に使う。 */
export function liveListKey(list: Pick<LiveSessionList, 'agent' | 'shell' | 'configDir'>): string {
  return `${list.agent}\n${livePlaceKey(list.shell)}\n${list.configDir}`
}

/** パネルで折り畳んだアカウント（`liveListKey` の並び）の置き場（#633。マシンの中だけで同期しない）。 */
export const LIVE_COLLAPSED_KEY = 'pike:live-sessions-collapsed'
/** 詳細のタブで選んでいるアカウント（`liveListKey`。`null` は「すべて」）の置き場（#633）。 */
export const LIVE_TAB_ACCOUNT_KEY = 'pike:live-sessions-account'
/** 覚えておく折り畳みの数。使わなくなったアカウントの鍵が溜まり続けないよう、古いものから捨てる。 */
const MAX_COLLAPSED = 50

/** 保存した値を鍵の並びとして読む（手で編集された値や版の違う Pike が書いた値は捨てる）。 */
export function asKeyList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * 折り畳みの並びで `key` を畳んだ（`collapse`）／開いた新しい並び。**切り替えではなく、なりたい状態を
 * 渡す**: 呼ぶ側は保存先を読み直してから渡すので、別のウィンドウが先に畳んでいると、切り替えでは
 * 押した本人の見ている向きと逆になる。畳んだものは末尾に足し、`MAX_COLLAPSED` を超えたら先頭
 * （いちばん前に畳んだもの）から捨てる。
 */
export function withCollapsedKey(keys: readonly string[], key: string, collapse: boolean): string[] {
  const rest = keys.filter((k) => k !== key)
  return collapse ? [...rest, key].slice(-MAX_COLLAPSED) : rest
}

/**
 * 詳細のタブに出すアカウント。`selected` が今の一覧に無ければ（そのアカウントのセッションが終わった）
 * 「すべて」として扱う。**保存した値は消さない**（またセッションが動き出せば、そのアカウントに戻る）。
 */
export function selectedSections<T extends { key: string }>(sections: readonly T[], selected: string | null): T[] {
  const one = selected ? sections.find((s) => s.key === selected) : undefined
  return one ? [one] : [...sections]
}

/**
 * 押したときにどこへ移るかの説明（i18n のキー）。行き先の決め方は `stores/liveSessions.ts` の
 * `jump` が正本で、ここはその 3 段をそのまま言う。
 */
export function liveSessionJumpKey(row: { tabId: string | null; project: unknown }): string {
  if (row.tabId) return 'liveSessions.jumpTab'
  return row.project ? 'liveSessions.jumpProject' : 'liveSessions.jumpDir'
}
