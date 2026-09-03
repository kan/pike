import type { IssueSummary } from '../types/issues'

/**
 * 木を平らに並べた 1 行（#278）。**描く側は深さだけ受け取る**ので、入れ子の
 * `v-for` を書かずに済む（ファイルツリーと同じ形）。
 */
export interface IssueTreeRow {
  issue: IssueSummary
  /** 0 がトップレベル。字下げに使う。 */
  depth: number
  /** 畳める子を持つか（畳んでいるあいだも chevron を出すため、`collapsed` とは独立）。 */
  hasChildren: boolean
}

export interface IssueTreeOptions {
  /** 絞り込みに当てる述語。 */
  matches: (issue: IssueSummary) => boolean
  /** 畳んである親の番号。 */
  collapsed: ReadonlySet<number>
}

/**
 * 親のリンクを正規化した索引。**輪の扱いはここだけが知っている。**
 *
 * `parent` は外部（`gh`）から来る値なので、輪になっていないという保証が無い。各所に
 * ガードを撒くと「無限ループはしないが issue が数件消える」というもっと気付きにくい
 * 壊れ方が残るので、**輪に参加する辺をここで切って**、以降は普通の森として扱う。
 *
 * 親として認めないのは 3 つ: `null`、自分自身、一覧に居ない番号。**一覧に居ない親を
 * 認めない**のが要点で、親が closed だったり取得件数の枠外だったりするのは普通に起きる。
 * そこで子を隠すと「絞り込んでいないのに見えない issue」ができるので、トップレベルへ出す。
 */
export function indexIssues(issues: IssueSummary[]): {
  byNumber: Map<number, IssueSummary>
  /** 実効の親（輪に参加していれば `null`＝トップレベル扱い）。 */
  parentOf: (issue: IssueSummary) => number | null
} {
  const byNumber = new Map(issues.map((i) => [i.number, i]))
  const rawParent = (issue: IssueSummary): number | null =>
    issue.parent !== null && issue.parent !== issue.number && byNumber.has(issue.parent) ? issue.parent : null

  // 「祖先を辿ると根に着くか」をメモしながら求める。着かない＝どこかで輪に入っている。
  // 1 本の鎖を辿るあいだに通った番号は答えが同じなので、まとめて記録する。
  const endless = new Map<number, boolean>()
  const isEndless = (start: IssueSummary): boolean => {
    const chain: number[] = []
    const onPath = new Set<number>()
    let current: IssueSummary | undefined = start
    let answer = false
    while (current) {
      const memo = endless.get(current.number)
      if (memo !== undefined) {
        answer = memo
        break
      }
      if (onPath.has(current.number)) {
        answer = true
        break
      }
      onPath.add(current.number)
      chain.push(current.number)
      const parent = rawParent(current)
      current = parent === null ? undefined : byNumber.get(parent)
    }
    for (const n of chain) endless.set(n, answer)
    return answer
  }

  return { byNumber, parentOf: (issue) => (isEndless(issue) ? null : rawParent(issue)) }
}

/**
 * `parent` だけで親子を組み、表示順に平らへ落とす（#278）。
 *
 * **`subIssues` は使わない。** あちらは子の情報を重複して返すうえ、**一覧に載っていない子
 * （closed や取得件数の枠外）も返す**ので、一覧の件数と木の件数が食い違う。`parent` を
 * 上向きに辿るだけなら、出てくるのは必ず取ってきた一覧の中のものになる。
 *
 * **絞り込みでは一致した issue の祖先を残す**（親が消えると、子がどこにぶら下がっていたか
 * 読めなくなる）。逆に、一致した親の一致しない子は落とす。
 *
 * 並びは入力の順（更新の新しい順）を保つ。親の位置に子が引き寄せられるぶんフラットとは
 * 変わるが、それは木にするということそのもの。
 */
export function buildIssueTree(issues: IssueSummary[], opts: IssueTreeOptions): IssueTreeRow[] {
  const { byNumber, parentOf } = indexIssues(issues)

  // 残すもの＝一致したもの ∪ その祖先。`parentOf` が輪を切ってあるので、この遡りは必ず終わる。
  const keep = new Set<number>()
  for (const issue of issues) {
    if (!opts.matches(issue)) continue
    keep.add(issue.number)
    let parent = parentOf(issue)
    while (parent !== null) {
      keep.add(parent)
      const next = byNumber.get(parent)
      parent = next ? parentOf(next) : null
    }
  }

  // 残したものだけで親子を張る。`keep` は親方向に閉じている（祖先も入れてある）ので、
  // 子が残っていれば親も必ず残っている。
  const roots: IssueSummary[] = []
  const children = new Map<number, IssueSummary[]>()
  for (const issue of issues) {
    if (!keep.has(issue.number)) continue
    const parent = parentOf(issue)
    if (parent === null) {
      roots.push(issue)
      continue
    }
    const siblings = children.get(parent)
    if (siblings) siblings.push(issue)
    else children.set(parent, [issue])
  }

  const rows: IssueTreeRow[] = []
  const walk = (list: IssueSummary[], depth: number) => {
    for (const issue of list) {
      const kids = children.get(issue.number) ?? []
      rows.push({ issue, depth, hasChildren: kids.length > 0 })
      if (kids.length > 0 && !opts.collapsed.has(issue.number)) walk(kids, depth + 1)
    }
  }
  walk(roots, 0)
  return rows
}

/**
 * 子を持つ親の番号（全展開 / 全畳みの対象）。**絞り込みと畳み具合には依存しない**ので、
 * 木を組むのとは別に求める。輪の扱いは `indexIssues` と共有しているため、木のどこにも
 * 出てこない番号がここから返ることはない。
 */
export function issueParentNumbers(issues: IssueSummary[]): number[] {
  const { parentOf } = indexIssues(issues)
  const parents = new Set<number>()
  for (const issue of issues) {
    const parent = parentOf(issue)
    if (parent !== null) parents.add(parent)
  }
  return [...parents]
}
