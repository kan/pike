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
import { appendMissing, asList, type MergeResult, merge3, resolve, type Side, type SyncItems } from './syncMerge'

/** 同期の対象の種類（#403）。種類ごとに同期するかを切り替えられる。 */
export type SyncCategory = 'settings' | 'projects' | 'bookmarks'

export const SYNC_CATEGORIES: readonly SyncCategory[] = ['settings', 'projects', 'bookmarks']

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

/** 「ブックマークとサイトのルール」に属する設定のキー。残りの設定は「設定」。 */
const BOOKMARK_SETTING_KEYS: ReadonlySet<string> = new Set([
  'browserBookmarks',
  'browserSiteRules',
] satisfies (keyof PersistedSettings)[])

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
  if (k[0] === 'setting') return BOOKMARK_SETTING_KEYS.has(k[1]) ? 'bookmarks' : 'settings'
  return 'projects'
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

/** 同期ファイルの中身（パース済み）を `SyncSource` にする。形の検査は呼び出し側が済ませる。 */
export function fromSyncFile(file: Record<string, unknown>): SyncSource {
  const settings: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(file)) if (!RESERVED.has(k)) settings[k] = v
  return {
    settings,
    projects: Array.isArray(file[PROJECTS_KEY]) ? (file[PROJECTS_KEY] as SyncedProject[]) : [],
    groups: asList(file[GROUPS_KEY]),
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

/** `mergeSyncItems` の結果。`resolveSyncItems` にそのまま渡す（マージに使った手元を持ち回る）。 */
export interface SyncMerge extends MergeResult {
  local: SyncItems
  remote: SyncItems
}

/**
 * 同期の 3-way マージ。
 *
 * **`tracked` は必須**: このマシンが追っていないプロジェクト（基準のディレクトリの外で解決
 * できない、別のマシンが登録したもの）を手元に無いからと削除と読むと、同期するたびにファイル
 * から消してしまう。追っていない id は baseline のまま据え置く（手元の項目に写す）。追って
 * いるのは、手元にあるプロジェクトと、手元で消したと分かっているもの（非表示の記録）。
 */
export function mergeSyncItems(
  base: SyncItems | null,
  local: SyncItems,
  remote: SyncItems,
  tracked: (projectId: string) => boolean,
): SyncMerge {
  const carried: SyncItems = new Map(local)
  for (const [key, v] of base ?? []) {
    const k = parseItemKey(key)
    if (k[0] === 'project' && !tracked(k[1]) && !carried.has(key)) carried.set(key, v)
  }
  return { ...merge3(base, carried, remote, MERGE_OPTIONS), local: carried, remote }
}

/** 衝突の選択を反映して最終的な項目を作る。選ばれていない衝突は `fallback` の側。 */
export function resolveSyncItems(m: SyncMerge, choices: ReadonlyMap<string, Side>, fallback?: Side): SyncItems {
  return resolve(m, m.local, m.remote, choices, { ...MERGE_OPTIONS, fallback })
}
