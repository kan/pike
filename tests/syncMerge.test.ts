// 同期の 3-way マージ（#403）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  fromItems,
  itemKey,
  mergeSyncItems,
  parseItemKey,
  resolveSyncItems,
  type SyncSource,
  toItems,
  toSyncFile,
  withUnsyncedFromRemote,
} from '../src/lib/syncFormat.ts'
import { merge3, resolve, type SyncItems, stableKey } from '../src/lib/syncMerge.ts'
import type { SyncedProject } from '../src/types/project.ts'

const s = (k: string) => itemKey(['setting', k])
const p = (id: string) => itemKey(['project', id])
const pf = (id: string, f: string) => itemKey(['project', id, f])
const items = (o: Record<string, unknown>): SyncItems => new Map(Object.entries(o))

const proj = (id: string, extra: Partial<SyncedProject> = {}): SyncedProject => ({
  id,
  name: id,
  platform: 'windows',
  path: id,
  ...extra,
})
const src = (o: Partial<SyncSource>): SyncSource => ({ settings: {}, projects: [], groups: [], ...o })
/** 全プロジェクトを手元で追っている（手元に無ければ消したものとして扱う）。 */
const tracked = () => true
const merge = (base: SyncSource, local: SyncSource, remote: SyncSource) =>
  mergeSyncItems(toItems(base), toItems(local), toItems(remote), tracked)

describe('merge3', () => {
  test('片方だけが変えた項目はその値、両方が変えた項目は衝突', () => {
    const base = items({ [s('a')]: 1, [s('b')]: 1, [s('c')]: 1 })
    const local = items({ [s('a')]: 2, [s('b')]: 1, [s('c')]: 3 })
    const remote = items({ [s('a')]: 1, [s('b')]: 5, [s('c')]: 4 })
    const r = merge3(base, local, remote)
    assert.equal(r.merged.get(s('a')), 2)
    assert.equal(r.merged.get(s('b')), 5)
    assert.deepEqual(
      r.conflicts.map((c) => c.key),
      [s('c')],
    )
  })

  test('両方が同じ値に変えたら衝突しない', () => {
    const r = merge3(items({ [s('a')]: 1 }), items({ [s('a')]: 2 }), items({ [s('a')]: 2 }))
    assert.equal(r.conflicts.length, 0)
    assert.equal(r.merged.get(s('a')), 2)
  })

  test('オブジェクトはキーの順を問わず比べる', () => {
    assert.equal(stableKey({ a: 1, b: [{ x: 1, y: 2 }] }), stableKey({ b: [{ y: 2, x: 1 }], a: 1 }))
  })

  test('baseline が無ければ、食い違う項目は衝突、片方にしか無い項目は採る', () => {
    const r = merge3(null, items({ [s('a')]: 1, [s('b')]: 1 }), items({ [s('a')]: 2, [s('c')]: 3 }))
    assert.deepEqual(
      r.conflicts.map((c) => c.key),
      [s('a')],
    )
    assert.equal(r.merged.get(s('b')), 1)
    assert.equal(r.merged.get(s('c')), 3)
  })
})

describe('resolve', () => {
  test('選ばなかった衝突は fallback の側', () => {
    const base = items({ [s('a')]: 1, [s('b')]: 1 })
    const local = items({ [s('a')]: 2, [s('b')]: 2 })
    const remote = items({ [s('a')]: 3, [s('b')]: 3 })
    const r = merge3(base, local, remote)
    const out = resolve(r, local, remote, new Map([[s('a'), 'remote']]))
    assert.equal(out.get(s('a')), 3)
    assert.equal(out.get(s('b')), 2)
    const allRemote = resolve(r, local, remote, new Map(), { fallback: 'remote' })
    assert.equal(allRemote.get(s('b')), 3)
  })

  test('「無い」を選べば項目が消える', () => {
    const r = merge3(items({ [s('a')]: 1 }), items({}), items({ [s('a')]: 2 }))
    assert.equal(resolve(r, items({}), items({ [s('a')]: 2 }), new Map([[s('a'), 'local']])).has(s('a')), false)
  })
})

describe('プロジェクト', () => {
  test('別々のマシンでプロジェクトの別のフィールドを変えても衝突しない', () => {
    const m = merge(
      src({ projects: [proj('x', { color: 'red' })] }),
      src({ projects: [proj('x', { name: 'X', color: 'red' })] }),
      src({ projects: [proj('x', { color: 'blue' })] }),
    )
    assert.equal(m.conflicts.length, 0)
    assert.equal(m.merged.get(pf('x', 'name')), 'X')
    assert.equal(m.merged.get(pf('x', 'color')), 'blue')
  })

  test('片方が消し、もう片方が触っていなければ消える（削除が伝わる）', () => {
    const m = merge(src({ projects: [proj('x')] }), src({}), src({ projects: [proj('x')] }))
    assert.equal(m.conflicts.length, 0)
    assert.equal(m.merged.has(p('x')), false)
    assert.equal(m.merged.has(pf('x', 'name')), false)
  })

  test('片方が消し、もう片方がフィールドを変えたら、プロジェクト単位の衝突にまとめる', () => {
    const m = merge(src({ projects: [proj('x')] }), src({}), src({ projects: [proj('x', { color: 'red' })] }))
    assert.deepEqual(
      m.conflicts.map((c) => c.key),
      [p('x')],
    )
    // 残すと決めたら、残した側のフィールドがそろう。
    const kept = resolveSyncItems(m, new Map([[p('x'), 'remote']]))
    assert.equal(kept.get(pf('x', 'color')), 'red')
    assert.equal(kept.get(pf('x', 'name')), 'x')
    // 消すと決めたら、フィールドも残らない。
    const dropped = resolveSyncItems(m, new Map([[p('x'), 'local']]))
    assert.equal(
      [...dropped.keys()].some((k) => {
        const key = parseItemKey(k)
        return key[0] === 'project' && key[1] === 'x'
      }),
      false,
    )
  })

  test('残した側がフィールドを空にしたのも変更として数える（削除と衝突する）', () => {
    const m = merge(src({ projects: [proj('x', { color: 'red' })] }), src({}), src({ projects: [proj('x')] }))
    assert.deepEqual(
      m.conflicts.map((c) => c.key),
      [p('x')],
    )
  })

  test('片方で足したプロジェクトは残る', () => {
    const m = merge(src({}), src({}), src({ projects: [proj('y', { group: 'G' })], groups: ['G'] }))
    assert.equal(m.conflicts.length, 0)
    assert.equal(m.merged.get(pf('y', 'group')), 'G')
  })

  test('手元で追っていないプロジェクトは消さない', () => {
    const base = toItems(src({ projects: [proj('x')] }))
    const remote = toItems(src({ projects: [proj('x')] }))
    // このマシンは x を解決できない（手元の一覧に無い）。追っていないので据え置く。
    assert.equal(mergeSyncItems(base, toItems(src({})), remote, () => false).merged.get(p('x')), true)
    // 手元で消したと分かっているものは、消したものとして扱う。
    assert.equal(mergeSyncItems(base, toItems(src({})), remote, () => true).merged.has(p('x')), false)
  })
})

describe('並び順', () => {
  const out = (m: ReturnType<typeof merge>) => fromItems(resolveSyncItems(m, new Map()))

  test('別々のマシンでグループを足しても衝突せず、両方残る', () => {
    const m = merge(src({ groups: ['A'] }), src({ groups: ['A', 'B'] }), src({ groups: ['A', 'C'] }))
    assert.equal(m.conflicts.length, 0)
    assert.deepEqual(out(m).groups, ['A', 'B', 'C'])
  })

  test('片方だけが並べ替えたら、その順（足されたものは後ろ）', () => {
    const m = merge(src({ groups: ['A', 'B'] }), src({ groups: ['B', 'A'] }), src({ groups: ['A', 'B', 'C'] }))
    assert.equal(m.conflicts.length, 0)
    assert.deepEqual(out(m).groups, ['B', 'A', 'C'])
  })

  test('両方が違う順に並べ替えたら衝突', () => {
    const m = merge(
      src({ groups: ['A', 'B', 'C'] }),
      src({ groups: ['C', 'B', 'A'] }),
      src({ groups: ['B', 'A', 'C'] }),
    )
    assert.deepEqual(
      m.conflicts.map((c) => c.key),
      [itemKey(['order', 'groups'])],
    )
  })

  test('消したグループは並びからも消える', () => {
    const m = merge(src({ groups: ['A', 'B'] }), src({ groups: ['A'] }), src({ groups: ['B', 'A'] }))
    assert.equal(m.conflicts.length, 0)
    assert.deepEqual(out(m).groups, ['A'])
  })

  test('プロジェクトの並びは、グループごとに 1 本で比べる（混ざった順にならない）', () => {
    const three = (a: number, b: number, c: number) => [
      proj('a', { order: a }),
      proj('b', { order: b }),
      proj('c', { order: c }),
    ]
    const m = merge(
      src({ projects: three(0, 1, 2) }),
      src({ projects: three(2, 0, 1) }),
      src({ projects: three(1, 2, 0) }),
    )
    const key = itemKey(['order', 'projects', ''])
    assert.deepEqual(
      m.conflicts.map((c) => c.key),
      [key],
    )
    const kept = fromItems(resolveSyncItems(m, new Map([[key, 'remote']])))
    assert.deepEqual(
      kept.projects.map((x) => [x.id, x.order]),
      [
        ['a', 1],
        ['b', 2],
        ['c', 0],
      ],
    )
  })
})

describe('ファイルの形', () => {
  test('導出のキー（darkMode）は比べない', () => {
    const a = toItems(src({ settings: { themeMode: 'system', darkMode: true } }))
    const b = toItems(src({ settings: { themeMode: 'system', darkMode: false } }))
    assert.equal(merge3(a, a, b).conflicts.length, 0)
  })

  test('ファイルに戻すと元の形になり、導出のキーは今の値で入る', () => {
    const file = toSyncFile(
      toItems(
        src({
          settings: { fontSize: 14, unknownFromNewerPike: 'keep' },
          projects: [proj('b', { color: 'red' }), proj('a')],
          groups: ['G'],
        }),
      ),
      { darkMode: false },
    )
    assert.deepEqual(file, {
      fontSize: 14,
      unknownFromNewerPike: 'keep',
      darkMode: false,
      projects: [proj('a'), proj('b', { color: 'red' })],
      groups: ['G'],
    })
  })

  test('同期しない種類はリモートのまま書き戻す（手元にしか無い値も出さない）', () => {
    const remote = toItems(src({ settings: { fontSize: 12 } }))
    const merged = toItems(src({ settings: { fontSize: 14, browserBookmarks: ['local'] } }))
    const out = withUnsyncedFromRemote(merged, remote, new Set(['settings', 'projects']))
    assert.equal(out.get(s('fontSize')), 14)
    assert.equal(out.has(s('browserBookmarks')), false)
  })
})
