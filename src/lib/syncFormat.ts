/**
 * 同期ファイルと、マージの単位（`lib/syncMerge.ts` の `SyncItems`）との行き来（#403）。
 * 同期の調停役が呼ぶのは `mergeSyncItems` / `resolveSyncItems` で、`merge3` を直に呼ばない
 * （親子と並び順の判定と、手元で追っていないプロジェクトの扱いをここで足している）。
 *
 * **ファイルの形は #164 のまま**（設定のキーを平らに並べ、`projects` と `groups` を足した
 * もの）。古い版の Pike は知らないキーをそのまま残して書き戻すので、形を変えなければ
 * 新旧の版が混在しても互いの書き込みで項目が消えない。
 *
 * 項目の識別子は JSON の配列。プロジェクトの id やグループ名に使える文字を当てにしない
 * ため、区切り文字で組み立てない。
 *
 * - `["setting", key]` … 設定 1 つ
 * - `["project", id]`（有無）と `["project", id, field]` … プロジェクト（`order` を除く）
 * - `["group", name]` … グループの有無
 * - `["order", "groups"]` / `["order", "projects", group]` … 並び順
 *
 * **並び順を要素の有無と分けて持つ**理由は `lib/syncMerge.ts` の doc。プロジェクトの
 * `order` をフィールドごとに比べないのも同じ理由で、別々に並べ替えたときに混ざった順に
 * なる（`SyncedProject.order` の doc の「半分だけマージした順には意味が無い」）。
 */

import type { PersistedSettings } from '../stores/settings'
import type { SyncedProject } from '../types/project'
import {
  appendMissing,
  asList,
  type MergeResult,
  merge3,
  resolve,
  type Side,
  type SyncConflict,
  type SyncItems,
  sameSharedOrder,
  stableKey,
} from './syncMerge'

/** 同期の対象の種類（#403）。種類ごとに同期するかを切り替えられる。 */
export type SyncCategory = 'settings' | 'projects' | 'bookmarks' | 'fonts'

export const SYNC_CATEGORIES: readonly SyncCategory[] = ['settings', 'projects', 'bookmarks', 'fonts']

/**
 * 何も選んでいないときの既定（#407）。**`fonts` だけ外してある**: フォント名は OS ごとに
 * 入っているものが違い（`Consolas` は macOS に無く、`Menlo` は Windows に無い）、文字サイズも
 * 画面の解像度で当たりが変わるので、そろえると嬉しいより困るほうが多い。同じ構成の
 * マシンどうしでそろえたい人は設定で入れる。
 *
 * **`SYNC_CATEGORIES` から導かないこと**（「既定で入れる種類」と「選べる種類」は別物で、
 * 片方から他方を導くと、次に既定オフの種類を足す人が気付けない）。
 */
export const DEFAULT_SYNC_CATEGORIES: readonly SyncCategory[] = ['settings', 'projects', 'bookmarks']

/** ファイルの最上位で、設定ではないキー。 */
const PROJECTS_KEY = 'projects'
const GROUPS_KEY = 'groups'
const RESERVED = new Set([PROJECTS_KEY, GROUPS_KEY])

/**
 * **他の値から導く、古い版のためだけのキー**。項目として比べない: `darkMode` は `themeMode` が
 * `system` のときマシンの OS のテーマで決まるので、比べるとマシンごとに違って毎回衝突する。
 * 書き出すときに呼び出し側が今の値で入れ直す（`toSyncFile` の `derived`）。
 * 型で `PersistedSettings` に結んであるので、キーを改名すればコンパイルエラーになる。
 */
const DERIVED_SETTING_KEYS = [
  'darkMode',
  'agentProfiles',
  'agentCommands',
] as const satisfies readonly (keyof PersistedSettings)[]
export type DerivedSettingKey = (typeof DERIVED_SETTING_KEYS)[number]
const DERIVED: ReadonlySet<string> = new Set(DERIVED_SETTING_KEYS)

/**
 * 設定のキーのうち、「設定」から切り出してある種類（#403 / #407）。**ここに並べていない
 * キーは全部「設定」**なので、種類を足すときに触るのはこの表の 1 エントリだけで済む
 * （`categoryOf` に分岐を足さない。同じキーを 2 つの種類に書いても型は止めないが、分岐の
 * 順序という暗黙の優先順位は無くなる）。
 *
 * `fonts` が名前とサイズを 1 つにまとめているのは、名前だけ同期しても、そのフォントが無い
 * マシンでは「サイズだけがずれた別のフォント」になるため。既定で同期しない理由は
 * `DEFAULT_SYNC_CATEGORIES`。
 */
const CATEGORY_SETTING_KEYS = {
  bookmarks: ['browserBookmarks', 'browserSiteRules'],
  fonts: ['fontFamily', 'fontSize', 'editorFontName', 'editorFontSize', 'uiFontFamily', 'uiFontSize'],
} as const satisfies Record<Exclude<SyncCategory, 'settings' | 'projects'>, readonly (keyof PersistedSettings)[]>

const SETTING_CATEGORY: ReadonlyMap<string, SyncCategory> = new Map(
  Object.entries(CATEGORY_SETTING_KEYS).flatMap(([category, keys]) =>
    keys.map((key) => [key, category as SyncCategory] as const),
  ),
)

export type ItemKey =
  | ['setting', string]
  | ['project', string]
  | ['project', string, string]
  | ['group', string]
  | ['order', 'groups']
  | ['order', 'projects', string]

export const itemKey = (k: ItemKey): string => JSON.stringify(k)

export const parseItemKey = (key: string): ItemKey => JSON.parse(key) as ItemKey

/** プロジェクトのフィールドなら、そのプロジェクトの有無の項目。 */
function parentOf(key: string): string | null {
  const k = parseItemKey(key)
  return k[0] === 'project' && k.length === 3 ? itemKey(['project', k[1]]) : null
}

/** `merge3` / `resolve` に渡す、項目の関係の判定。 */
const MERGE_OPTIONS = { parentOf, isOrder: (key: string) => parseItemKey(key)[0] === 'order' }

export function categoryOf(key: string): SyncCategory {
  const k = parseItemKey(key)
  if (k[0] !== 'setting') return 'projects'
  return SETTING_CATEGORY.get(k[1]) ?? 'settings'
}

/** 同期する種類だけを残す。 */
export function onlyCategories(items: SyncItems, enabled: ReadonlySet<SyncCategory>): SyncItems {
  return new Map([...items].filter(([key]) => enabled.has(categoryOf(key))))
}

/**
 * 書き出す項目を作る。同期する種類はマージの結果、**同期しない種類はリモートのまま残す**
 * （このマシンで切っていても、他のマシンは同期している）。
 */
export function withUnsyncedFromRemote(
  merged: SyncItems,
  remote: SyncItems,
  enabled: ReadonlySet<SyncCategory>,
): SyncItems {
  const out = onlyCategories(merged, enabled)
  for (const [key, v] of remote) if (!enabled.has(categoryOf(key))) out.set(key, v)
  return out
}

export interface SyncSource {
  /** 設定（`snapshot()` の形。導出のキーは入っていてもよい、読み飛ばす）。 */
  settings: Record<string, unknown>
  projects: SyncedProject[]
  groups: string[]
}

/** 並び順を持つプロジェクトを、グループごとに順に並べた id の一覧。 */
function projectOrders(projects: SyncedProject[]): Map<string, string[]> {
  const byGroup = new Map<string, SyncedProject[]>()
  for (const p of projects) {
    if (p.order === undefined) continue
    const g = p.group ?? ''
    const list = byGroup.get(g)
    if (list) list.push(p)
    else byGroup.set(g, [p])
  }
  return new Map(
    [...byGroup].map(([g, ps]) => [g, ps.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((p) => p.id)]),
  )
}

/** 手元の状態やファイルの中身を項目に分ける。 */
export function toItems(src: SyncSource): SyncItems {
  const items: SyncItems = new Map()
  for (const [k, v] of Object.entries(src.settings)) {
    if (RESERVED.has(k) || DERIVED.has(k) || v === undefined) continue
    items.set(itemKey(['setting', k]), v)
  }
  for (const p of src.projects) {
    items.set(itemKey(['project', p.id]), true)
    for (const [field, v] of Object.entries(p)) {
      if (field === 'id' || field === 'order' || v === undefined) continue
      items.set(itemKey(['project', p.id, field]), v)
    }
  }
  for (const [g, ids] of projectOrders(src.projects)) items.set(itemKey(['order', 'projects', g]), ids)
  for (const g of src.groups) items.set(itemKey(['group', g]), true)
  items.set(itemKey(['order', 'groups']), src.groups)
  return items
}

/** 同期ファイルの中身（パース済み）を `SyncSource` にする。 */
export function fromSyncFile(file: Record<string, unknown>): SyncSource {
  const settings: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(file)) if (!RESERVED.has(k)) settings[k] = v
  return {
    settings,
    projects: parseSyncedProjects(file[PROJECTS_KEY]),
    groups: parseSyncedGroups(file[GROUPS_KEY]),
  }
}

/** 文字コード順（ロケールに依らない。`localeCompare` はマシンごとに順が変わりうる）。 */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 項目を `SyncSource` に組み直す（有無の項目があるプロジェクトとグループだけを作る）。 */
export function fromItems(items: SyncItems): SyncSource {
  const settings: Record<string, unknown> = {}
  const projects = new Map<string, Record<string, unknown>>()
  const fields: [string, string, unknown][] = []
  const groups: string[] = []
  const projectOrder = new Map<string, unknown>()
  let groupOrder: unknown
  for (const [key, v] of items) {
    const k = parseItemKey(key)
    if (k[0] === 'setting') settings[k[1]] = v
    else if (k[0] === 'group') groups.push(k[1])
    else if (k[0] === 'order') {
      if (k[1] === 'groups') groupOrder = v
      else projectOrder.set(k[2], v)
    } else if (k.length === 2) projects.set(k[1], { id: k[1] })
    else fields.push([k[1], k[2], v])
  }
  for (const [id, field, v] of fields) {
    const p = projects.get(id)
    if (p) p[field] = v
  }
  // 並びはそのグループに今いるプロジェクトだけで数え直す（消えたもの・移ったものを飛ばす）。
  for (const [g, order] of projectOrder) {
    let i = 0
    for (const id of asList(order)) {
      const p = projects.get(id)
      if (p && ((p.group as string | undefined) ?? '') === g) p.order = i++
    }
  }
  const members = new Set(groups)
  return {
    settings,
    // 並びは id 順にそろえる（書き出すたびに順が入れ替わると、ファイルの差分が無駄に出る）。
    projects: [...projects.values()].sort((a, b) =>
      byCodeUnit(String(a.id), String(b.id)),
    ) as unknown as SyncedProject[],
    groups: appendMissing(
      asList(groupOrder).filter((g) => members.has(g)),
      groups,
    ),
  }
}

/**
 * 項目から同期ファイルの中身を作る。`derived` は導出のキーの今の値（古い版の Pike が読む）。
 */
export function toSyncFile(
  items: SyncItems,
  derived: Partial<Pick<PersistedSettings, DerivedSettingKey>> = {},
): Record<string, unknown> {
  const src = fromItems(items)
  return { ...src.settings, ...derived, [PROJECTS_KEY]: src.projects, [GROUPS_KEY]: src.groups }
}

// --- マージ ---

/**
 * `mergeSyncItems` の結果。`resolveSyncItems` / `nextBaseline` にそのまま渡す（マージに使った
 * baseline と手元を持ち回る。どちらも `mergeSyncItems` が調整したもの）。
 */
export interface SyncMerge extends MergeResult {
  base: SyncItems | null
  local: SyncItems
  remote: SyncItems
}

/**
 * 同期の 3-way マージ。
 *
 * **`deletedHere` は必須**（このマシンで消したと分かっているプロジェクトか。削除の記録）。
 * 手元に無いプロジェクトは 2 通りに分かれる。
 *
 * - **消したもの**（`deletedHere`）。baseline に無くても（初めての同期や、同期先を変えた
 *   直後）、baseline にリモートの値があったことにして削除として扱う。そうしないと
 *   「リモートにだけある」＝追加と読まれ、消したプロジェクトが全部戻ってくる
 * - **このマシンが追っていないもの**（基準のディレクトリの外で作れない、別のマシンが登録した
 *   もの）。手元に無いからと削除と読むと、同期するたびにファイルから消してしまう。baseline
 *   のまま据え置く（手元の項目に写す）
 */
export function mergeSyncItems(
  baseIn: SyncItems | null,
  local: SyncItems,
  remote: SyncItems,
  deletedHere: (projectId: string) => boolean,
): SyncMerge {
  let base = baseIn
  for (const [key, v] of remote) {
    const k = parseItemKey(key)
    if (k[0] !== 'project' || !deletedHere(k[1]) || baseIn?.has(itemKey(['project', k[1]]))) continue
    // 呼び出し側の baseline は書き換えない（写してから足す）。
    if (base === baseIn) base = new Map(baseIn ?? [])
    base?.set(key, v)
  }
  const localIds = new Set(
    [...local.keys()]
      .map(parseItemKey)
      .filter((k) => k[0] === 'project')
      .map((k) => k[1]),
  )
  const tracked = (id: string) => localIds.has(id) || deletedHere(id)
  const carried: SyncItems = new Map(local)
  for (const [key, v] of base ?? []) {
    const k = parseItemKey(key)
    if (k[0] === 'project' && !tracked(k[1]) && !carried.has(key)) carried.set(key, v)
  }
  // **この版の Pike が知らない設定のキーも「変えていない」**（新しい版が書いたキー）。手元に
  // 無いことを削除と読むと、古い版で同期するたびに新しい版の設定を消す。
  for (const key of new Set([...(base?.keys() ?? []), ...remote.keys()])) {
    if (parseItemKey(key)[0] !== 'setting' || carried.has(key)) continue
    carried.set(key, base?.has(key) ? base.get(key) : remote.get(key))
  }
  // **置き場所は作るときにだけ使う**（`CREATE_ONLY_FIELDS`）。既に共有されているプロジェクトでは
  // 手元の値の代わりに共有されている値を置き、比べる対象から外す。
  for (const [key] of local) {
    const k = parseItemKey(key)
    if (k[0] !== 'project' || k.length !== 3 || !CREATE_ONLY_FIELDS.has(k[2])) continue
    const shared = base?.has(key) ? base.get(key) : remote.get(key)
    if (shared !== undefined) carried.set(key, shared)
  }
  return { ...merge3(base, carried, remote, MERGE_OPTIONS), base, local: carried, remote }
}

/**
 * プロジェクトの置き場所（基準のディレクトリからの相対パスとプラットフォーム）。**作る
 * ときにだけ使い、あとから比べない**。マシンごとにディレクトリの配置が違うことがあり、
 * 比べると「どちらのマシンの配置か」の衝突が毎回出るうえ、どちらを選んでも手元のルートは
 * 動かないので、次の同期で手元の値が「変えた」ことになって交互に書き換わる。
 */
const CREATE_ONLY_FIELDS: ReadonlySet<string> = new Set(['platform', 'path'] satisfies (keyof SyncedProject)[])

/**
 * インポート（#403 の段階 5）。**取り込むファイルの値を手元に重ねたもの**をリモートとし、
 * 手元と違う項目を全部「選ぶ対象」（`conflicts`）として並べる。`resolveSyncItems` に
 * `fallback: 'local'` で渡せば、選んだものだけを取り込んだ手元になる。
 *
 * 3-way ではない（取り込むファイルとのあいだに共通の過去が無い）。そのうえで次の 3 つを守る。
 *
 * - **手元にだけあるものは消さない**。ファイルに無いことは「消した」ではなく「そのファイルが
 *   知らない」（古いバックアップを戻して、あとで足したプロジェクトが消えては困る）
 * - **手元に無いプロジェクトは有無の 1 行にまとめる**。フィールドは取り込むと決めたときに
 *   ファイルから一緒に持ってくる（`resolve` の親子の扱い）。フィールドを 1 つずつ選ばせると
 *   半分だけのプロジェクトができる
 * - **取り込んでも何も起きない行は並べない**。この版が知らない設定、既にあるプロジェクトの
 *   置き場所（作るときにしか使わない。`CREATE_ONLY_FIELDS`）、手元で作れないと分かっている
 *   プロジェクト（`ignoreProject`＝基準のディレクトリの外にある・消した記録がある・同じ
 *   リポジトリを別の id で持っている。反映の側が黙って飛ばす）
 * - **並び順は共通の要素の相対順だけで比べる**（`merge3` と同じ）。丸ごと比べると、
 *   プロジェクトが 1 つ多いだけで並びの行が出て、選ぶと手元にだけあるものが末尾へ動く
 */
export function importSyncItems(
  local: SyncItems,
  imported: SyncItems,
  ignoreProject: (id: string) => boolean = () => false,
): SyncMerge {
  const remote: SyncItems = new Map(local)
  const conflicts: SyncConflict[] = []
  for (const [key, v] of imported) {
    const k = parseItemKey(key)
    if (k[0] === 'setting' && !local.has(key)) continue
    const present = k[0] === 'project' && local.has(itemKey(['project', k[1]]))
    const field = k[0] === 'project' && k.length === 3
    if (k[0] === 'project' && !present && ignoreProject(k[1])) continue
    if (field && present && CREATE_ONLY_FIELDS.has(k[2])) continue
    remote.set(key, v)
    // 手元に無いプロジェクトのフィールドは、有無の行と一緒に持ってくる（行は出さない）。
    if (field && !present) continue
    if (k[0] === 'order' && sameSharedOrder(asList(local.get(key)), asList(v))) continue
    if (stableKey(local.get(key)) !== stableKey(v)) {
      conflicts.push({ key, base: undefined, local: local.get(key), remote: v })
    }
  }
  // `merged` は読むだけ（`resolve` が写してから書く）なので、手元をそのまま渡す。
  return { merged: local, conflicts, base: null, local, remote }
}

/** 衝突の選択を反映して最終的な項目を作る。選ばれていない衝突は `fallback` の側。 */
export function resolveSyncItems(m: SyncMerge, choices: ReadonlyMap<string, Side>, fallback?: Side): SyncItems {
  return resolve(m, m.local, m.remote, choices, { ...MERGE_OPTIONS, fallback })
}

/**
 * 次の baseline を作る。決着した項目は書き出す値（`written`）、**まだ選ばれていない衝突は
 * 前の baseline のまま**にする。こうすると、次の同期でも手元とリモートの両方が baseline から
 * 変わったままなので、同じ衝突がもう一度出る（保留が消えない）。
 */
export function nextBaseline(m: SyncMerge, written: SyncItems, choices: ReadonlyMap<string, Side>): SyncItems {
  const base = m.base
  const out: SyncItems = new Map(written)
  const pending = new Set(m.conflicts.filter((c) => !choices.has(c.key)).map((c) => c.key))
  if (pending.size === 0) return out
  const restore = (key: string) => {
    const v = base?.get(key)
    if (v === undefined) out.delete(key)
    else out.set(key, v)
  }
  for (const key of pending) restore(key)
  // 親の衝突は、子も前の baseline に戻す（どちらの子が残るかはまだ決まっていない）。
  const children = new Set([...out.keys(), ...(base?.keys() ?? [])].filter((key) => pending.has(parentOf(key) ?? '')))
  for (const key of children) restore(key)
  return out
}

/** 同期ファイルの `groups`（表示順のグループ名、#203）。 */
function parseSyncedGroups(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((g): g is string => typeof g === 'string' && !!g.trim())
}

/**
 * 同期ファイルの `projects`。**知らない platform のエントリも落とさない**（#164 のころは
 * 落としていて、書き戻すと他のマシンが書いたものを消していた）。そういうエントリは手元で
 * 作れないだけで、項目としては持ち回る（`mergeSyncItems` の「追っていない」もの）。
 */
function parseSyncedProjects(raw: unknown): SyncedProject[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is SyncedProject => {
    if (!e || typeof e !== 'object') return false
    const p = e as Partial<SyncedProject>
    return typeof p.id === 'string' && !!p.id && typeof p.name === 'string' && typeof p.path === 'string'
  })
}
