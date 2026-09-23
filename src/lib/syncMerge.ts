/**
 * 設定の同期の 3-way マージ（#403）。**種別を知らない純粋な計算**で、同期ファイルの形との
 * 行き来は `lib/syncFormat.ts`、いつ誰が呼ぶかは同期の調停役が持つ。
 *
 * 同期の衝突の根本は「前回同期した時点の内容（baseline）を持っていないので、手元と
 * リモートが食い違ったときに、どちらが変えたのかを判定できない」ことだった（#403 の設計）。
 * ここでは項目ごとに baseline・手元・リモートの 3 つを比べる。
 *
 * - 手元だけが変えた → 手元の値
 * - リモートだけが変えた → リモートの値
 * - 両方が同じ値に変えた → その値
 * - 両方が別の値に変えた → **衝突**（自動では決めない）
 *
 * 「無い」も値の 1 つとして扱う（`undefined`）。追加と削除はそこから導ける: baseline に
 * 無く片方にだけあれば追加、baseline にあって片方から消えていれば削除。**削除の記録
 * （tombstone）は持たない**。baseline との差で分かるため。
 *
 * 項目の関係を 2 つ知っている（どちらも判定の関数を `MergeOptions` で受ける）。
 *
 * - **親子**（プロジェクトの有無と、その名前や色）。フィールドごとに比べるので、別々の
 *   マシンで名前と色を変えても衝突しない。ただし片方が消して、もう片方がフィールドを
 *   変えたときは、フィールドの衝突ではなく**親の衝突（消すか残すか）**にまとめる。
 *   フィールドだけを選ばせると、半分だけ消えたプロジェクトができる
 * - **並び順**（文字列の一覧）。一覧を 1 つの値として比べると、別々のマシンで要素を 1 つずつ
 *   足しただけで衝突し、どちらを選んでも片方が消える。そこで **3 者に共通する要素の相対順
 *   だけ**で比べ、足された要素は後ろへ付け直す（手元の順、次にリモートの順）。消えた要素を
 *   並びから落とすのは呼び出し側（要素の有無は別の項目が持つ）
 */

/** 項目の識別子 → 値。値は JSON で表せるもの（比べるときも JSON で比べる）。 */
export type SyncItems = Map<string, unknown>

export interface SyncConflict {
  key: string
  /** `undefined` は「無い」。並び順の衝突では、共通の要素に絞った一覧。 */
  base: unknown
  local: unknown
  remote: unknown
}

export interface MergeResult {
  /** 衝突していない項目をマージした結果（衝突した項目は含まない）。 */
  merged: SyncItems
  conflicts: SyncConflict[]
}

export type Side = 'local' | 'remote'

export interface MergeOptions {
  /** 子の項目なら親の識別子、そうでなければ null。 */
  parentOf?: (key: string) => string | null
  /** 並び順の項目か（値は文字列の一覧）。 */
  isOrder?: (key: string) => boolean
}

/**
 * 値を比べられる文字列にする。**キーの順を揃える**（`{a,b}` と `{b,a}` を別物と見なすと、
 * 読み直しただけで衝突が出る）。`undefined`（無い）は別の印にする。
 */
export function stableKey(v: unknown): string {
  if (v === undefined) return '\u0000undefined'
  return JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x as Record<string, unknown>)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  )
}

const same = (a: unknown, b: unknown) => stableKey(a) === stableKey(b)

export const asList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])

/** `head` のあとに、まだ入っていない `candidates` を出てきた順に足す。 */
export function appendMissing(head: readonly string[], candidates: readonly string[]): string[] {
  const seen = new Set(head)
  const out = [...head]
  for (const x of candidates) {
    if (!seen.has(x)) {
      seen.add(x)
      out.push(x)
    }
  }
  return out
}

/** 2 つの並びが、共通の要素の相対順で同じか（`merge3` と同じく、片方にしか無い要素は数えない）。 */
export function sameSharedOrder(a: readonly string[], b: readonly string[]): boolean {
  const inA = new Set(a)
  const inB = new Set(b)
  const sa = a.filter((x) => inB.has(x))
  const sb = b.filter((x) => inA.has(x))
  return sa.length === sb.length && sa.every((x, i) => x === sb[i])
}

const allKeys = (...maps: (SyncItems | null)[]) => new Set(maps.flatMap((m) => (m ? [...m.keys()] : [])))

/** 並び順の項目を、3 者に共通する要素だけに絞る（相対順だけを比べるため）。 */
function narrowOrders(keys: Set<string>, isOrder: (key: string) => boolean, sides: (SyncItems | null)[]) {
  const present = sides.filter((m): m is SyncItems => m !== null)
  const narrowed = sides.map((m) => (m ? new Map(m) : null))
  for (const key of keys) {
    if (!isOrder(key)) continue
    const sets = present.map((m) => new Set(asList(m.get(key))))
    const keep = (x: string) => sets.every((s) => s.has(x))
    for (const m of narrowed) if (m?.has(key)) m.set(key, asList(m.get(key)).filter(keep))
  }
  return narrowed
}

/** 絞った並びに、絞る前に居た要素を後ろへ付け直す。 */
function expandOrders(items: SyncItems, local: SyncItems, remote: SyncItems, opts: MergeOptions, skip?: Set<string>) {
  const isOrder = opts.isOrder
  if (!isOrder) return
  for (const key of allKeys(items, local, remote)) {
    // 衝突している並びは、決着まで結果に入れない。
    if (!isOrder(key) || skip?.has(key)) continue
    items.set(key, appendMissing(asList(items.get(key)), [...asList(local.get(key)), ...asList(remote.get(key))]))
  }
}

/**
 * 3-way マージ。`base` が null（まだ一度も同期していない）なら空として比べる。そのとき
 * 両方にあって値が違う項目は衝突になる（どちらも「追加した」ことになるため）。
 */
export function merge3(
  base: SyncItems | null,
  local: SyncItems,
  remote: SyncItems,
  opts: MergeOptions = {},
): MergeResult {
  const keys = allKeys(base, local, remote)
  const [nb, nl, nr] = opts.isOrder ? narrowOrders(keys, opts.isOrder, [base, local, remote]) : [base, local, remote]
  const b = nb ?? new Map<string, unknown>()
  const l = nl ?? local
  const r = nr ?? remote
  const merged: SyncItems = new Map()
  const conflicts = new Map<string, SyncConflict>()
  for (const key of keys) {
    const bv = b.get(key)
    const lv = l.get(key)
    const rv = r.get(key)
    const [bk, lk, rk] = [stableKey(bv), stableKey(lv), stableKey(rv)]
    let value: unknown
    if (lk === rk) value = lv
    else if (lk === bk) value = rv
    else if (rk === bk) value = lv
    else {
      conflicts.set(key, { key, base: bv, local: lv, remote: rv })
      continue
    }
    if (value !== undefined) merged.set(key, value)
  }
  if (opts.parentOf) liftToParents(keys, b, l, r, merged, conflicts, opts.parentOf)
  expandOrders(merged, local, remote, opts, new Set(conflicts.keys()))
  return { merged, conflicts: [...conflicts.values()] }
}

/**
 * 親が消える側に決まったのに、子がもう片方で変わっていたら、親の衝突にまとめる。
 * 子の衝突も親の衝突に吸収する（親を残すと決まったら、子は選んだ側から持ってくる）。
 */
function liftToParents(
  keys: Set<string>,
  base: SyncItems,
  local: SyncItems,
  remote: SyncItems,
  merged: SyncItems,
  conflicts: Map<string, SyncConflict>,
  parentOf: (key: string) => string | null,
) {
  // **消した側の子も「変わった（無くなった）」ことになる**ので、数えるのは親を残した側の
  // 変更だけ。そうしないと、片方が消しただけ（もう片方は触っていない）で衝突になる。
  // 残した側がフィールドを空にした（キーを消した）のも変更として数える。
  const editedBy = (side: SyncItems, parent: string, key: string) =>
    side.has(parent) && !same(side.get(key), base.get(key))
  const children: [string, string][] = []
  const lifted = new Set<string>()
  for (const key of keys) {
    const parent = parentOf(key)
    if (parent === null) continue
    children.push([key, parent])
    // 親が消える側に決まった（`merged` にも衝突にも無い）のに、残した側が子を変えていた。
    if (
      !merged.has(parent) &&
      !conflicts.has(parent) &&
      (editedBy(local, parent, key) || editedBy(remote, parent, key))
    ) {
      lifted.add(parent)
    }
  }
  for (const parent of lifted) {
    conflicts.set(parent, { key: parent, base: base.get(parent), local: local.get(parent), remote: remote.get(parent) })
  }
  // 親が衝突している、または消えた子は結果から外す。
  for (const [key, parent] of children) {
    if (conflicts.has(parent) || !merged.has(parent)) {
      merged.delete(key)
      conflicts.delete(key)
    }
  }
}

/**
 * 衝突の選択を反映して、最終的な項目を作る。選ばれていない衝突は `fallback` の側で
 * 決める（省略すれば手元）。`local` / `remote` は `merge3` に渡したものをそのまま渡す。
 *
 * **親の衝突を決めたら、その子は選んだ側からそのまま持ってくる。** 「残す」と決めたなら
 * 残した側のフィールドが正しく、「消す」と決めたなら子も要らない。
 */
export function resolve(
  result: MergeResult,
  local: SyncItems,
  remote: SyncItems,
  choices: ReadonlyMap<string, Side>,
  opts: MergeOptions & { fallback?: Side } = {},
): SyncItems {
  const out: SyncItems = new Map(result.merged)
  const pick = (side: Side) => (side === 'local' ? local : remote)
  const chosen = new Map<string, Side>()
  for (const c of result.conflicts) {
    const side = choices.get(c.key) ?? opts.fallback ?? 'local'
    const v = pick(side).get(c.key)
    if (v === undefined) out.delete(c.key)
    else out.set(c.key, v)
    chosen.set(c.key, side)
  }
  const parentOf = opts.parentOf
  if (parentOf && chosen.size > 0) {
    for (const side of ['local', 'remote'] as const) {
      for (const [key, v] of pick(side)) {
        const parent = parentOf(key)
        if (parent !== null && chosen.get(parent) === side) out.set(key, v)
      }
    }
    // 親が無くなった子は落とす。
    for (const key of out.keys()) {
      const parent = parentOf(key)
      if (parent !== null && !out.has(parent)) out.delete(key)
    }
  }
  expandOrders(out, local, remote, opts)
  return out
}
