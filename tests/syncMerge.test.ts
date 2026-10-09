// 同期の 3-way マージ（#403）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isRespelling, normalizeRemoteUrl } from '../src/lib/gitRemote.ts'
import {
  categoryOf,
  DEFAULT_SYNC_CATEGORIES,
  foreignProjectIds,
  fromItems,
  fromSyncFile,
  importSyncItems,
  itemKey,
  mergeSyncItems,
  nextBaseline,
  parseItemKey,
  rejoinCandidates,
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
/** `deleted` はこのマシンで消したと分かっているプロジェクト（非表示の記録）。 */
const merge = (base: SyncSource | null, local: SyncSource, remote: SyncSource, deleted: string[] = []) =>
  mergeSyncItems(base && toItems(base), toItems(local), toItems(remote), (id) => deleted.includes(id))

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
    const m = merge(src({ projects: [proj('x')] }), src({}), src({ projects: [proj('x')] }), ['x'])
    assert.equal(m.conflicts.length, 0)
    assert.equal(m.merged.has(p('x')), false)
    assert.equal(m.merged.has(pf('x', 'name')), false)
  })

  test('片方が消し、もう片方がフィールドを変えたら、プロジェクト単位の衝突にまとめる', () => {
    const m = merge(src({ projects: [proj('x')] }), src({}), src({ projects: [proj('x', { color: 'red' })] }), ['x'])
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
    const m = merge(src({ projects: [proj('x', { color: 'red' })] }), src({}), src({ projects: [proj('x')] }), ['x'])
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
    const both = src({ projects: [proj('x')] })
    // このマシンは x を解決できない（手元の一覧に無い）。追っていないので据え置く。
    assert.equal(merge(both, src({}), both).merged.get(p('x')), true)
    // 手元で消したと分かっているものは、消したものとして扱う。
    assert.equal(merge(both, src({}), both, ['x']).merged.has(p('x')), false)
  })

  test('初めての同期でも、手元で消したものは戻ってこない', () => {
    const m = merge(null, src({}), src({ projects: [proj('x'), proj('y')] }), ['x'])
    assert.equal(m.conflicts.length, 0)
    assert.equal(m.merged.has(p('x')), false)
    assert.equal(m.merged.get(p('y')), true)
  })

  test('置き場所（path）はマシンごとに違っても比べない', () => {
    const m = merge(
      src({ projects: [proj('x', { path: 'src/x' })] }),
      src({ projects: [proj('x', { path: 'work/x' })] }),
      src({ projects: [proj('x', { path: 'src/x' })] }),
    )
    assert.equal(m.conflicts.length, 0)
    assert.equal(m.merged.get(pf('x', 'path')), 'src/x')
  })
})

describe('同じ id が別のプロジェクトを指すとき（#463）', () => {
  const onWindows = (platform: string) => platform === 'wsl' || platform === 'windows'
  // 共有のエントリは WSL 側（別のマシンが名前を付けた）、手元の同じ id は Windows 側。
  const shared = src({ projects: [proj('dotfiles', { platform: 'wsl', name: 'dotfiles_wsl' })] })
  const here = src({ projects: [proj('dotfiles', { platform: 'windows', name: 'dotfiles' }), proj('other')] })
  const foreign = (base: SyncSource | null, held: { id: string; platform?: string }[], remote: SyncSource) =>
    foreignProjectIds(held, base && toItems(base), toItems(remote), onWindows)

  test('プラットフォームが食い違う id だけを挙げる（baseline に無ければリモートで見る）', () => {
    assert.deepEqual([...foreign(shared, here.projects, shared)], ['dotfiles'])
    assert.deepEqual([...foreign(null, here.projects, shared)], ['dotfiles'])
    // 共有されていないもの、プラットフォームが合っているものは挙げない。
    assert.deepEqual([...foreign(null, here.projects, src({}))], [])
    assert.deepEqual([...foreign(shared, shared.projects, shared)], [])
  })

  test('このホストが持てないプラットフォームのエントリは食い違いではない（#407 で落として作ったもの）', () => {
    const fromWindows = src({ projects: [proj('x', { platform: 'windows' })] })
    const held = [proj('x', { platform: 'unix' })]
    assert.deepEqual([...foreignProjectIds(held, null, toItems(fromWindows), (p) => p === 'unix')], [])
  })

  test('プラットフォームの無い古い削除の記録は数えない', () => {
    assert.deepEqual([...foreign(shared, [{ id: 'dotfiles' }], shared)], [])
    assert.deepEqual([...foreign(shared, [{ id: 'dotfiles', platform: 'windows' }], shared)], ['dotfiles'])
  })

  test('手元から外してマージすると、共有のエントリは据え置かれ、手元の名前も出て行かない', () => {
    const ids = foreign(shared, here.projects, shared)
    const local = src({ projects: here.projects.filter((x) => !ids.has(x.id)) })
    const m = merge(shared, local, shared)
    assert.equal(m.conflicts.length, 0)
    assert.equal(m.merged.get(pf('dotfiles', 'name')), 'dotfiles_wsl')
    assert.equal(m.merged.get(pf('dotfiles', 'platform')), 'wsl')
    assert.equal(m.merged.get(p('other')), true)
  })

  test('追っていないプロジェクトは、共有の並びでの位置も据え置く', () => {
    const order = (ids: string[]) => src({ projects: ids.map((id, i) => proj(id, { order: i })) })
    const both = order(['a', 'x', 'b'])
    const m = merge(both, order(['a', 'b']), both)
    assert.equal(m.conflicts.length, 0)
    assert.deepEqual(m.merged.get(itemKey(['order', 'projects', ''])), ['a', 'x', 'b'])
  })
})

describe('設定', () => {
  test('この版が知らない設定のキーは消さない（新しい版が書いたもの）', () => {
    const remote = src({ settings: { fontSize: 12, fromNewerPike: 1 } })
    const m = merge(remote, src({ settings: { fontSize: 14 } }), remote)
    assert.equal(m.conflicts.length, 0)
    assert.equal(m.merged.get(s('fontSize')), 14)
    assert.equal(m.merged.get(s('fromNewerPike')), 1)
  })
})

describe('Jira の列の色（#419）', () => {
  const colors = (c: Record<string, string>) => src({ settings: { browserJiraColumnColors: c } })

  test('別々のマシンで別の列に色を付けても衝突せず、両方残る', () => {
    const m = merge(colors({}), colors({ 実施予定: 'green' }), colors({ 要件確認: 'red' }))
    assert.equal(m.conflicts.length, 0)
    assert.deepEqual(toSyncFile(m.merged).browserJiraColumnColors, { 実施予定: 'green', 要件確認: 'red' })
  })

  test('表を丸ごと持つ古い baseline からでも、別の列なら衝突しない', () => {
    const oldBase = items({ [s('browserJiraColumnColors')]: {} })
    const m = mergeSyncItems(oldBase, toItems(colors({ a: 'green' })), toItems(colors({ b: 'red' })), () => false)
    assert.equal(m.conflicts.length, 0)
    assert.deepEqual(toSyncFile(m.merged).browserJiraColumnColors, { a: 'green', b: 'red' })
  })

  test('消した列は伝わり、同じ列を別の色にしたらその列だけが衝突', () => {
    const base = colors({ a: 'green', b: 'red' })
    const m = merge(base, colors({ b: 'blue' }), colors({ a: 'green', b: 'teal' }))
    assert.deepEqual(
      m.conflicts.map((c) => c.key),
      [itemKey(['setting', 'browserJiraColumnColors', 'b'])],
    )
    assert.equal(m.merged.has(itemKey(['setting', 'browserJiraColumnColors', 'a'])), false)
  })
})

describe('nextBaseline', () => {
  test('選んでいない衝突は前の baseline に据え置く（次の同期でも同じ衝突が出る）', () => {
    const base = src({ settings: { a: 1, b: 1 } })
    const local = src({ settings: { a: 2, b: 2 } })
    const remote = src({ settings: { a: 3, b: 1 } })
    const m = merge(base, local, remote)
    const written = resolveSyncItems(m, new Map(), 'remote')
    const next = nextBaseline(m, written, new Map())
    assert.equal(next.get(s('a')), 1)
    assert.equal(next.get(s('b')), 2)
    // 選んだ衝突は決着した値になる。
    const chosen = new Map([[s('a'), 'local' as const]])
    assert.equal(nextBaseline(m, resolveSyncItems(m, chosen, 'remote'), chosen).get(s('a')), 2)
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
    const remote = toItems(src({ settings: { colorSchemeName: 'Nord' } }))
    const merged = toItems(src({ settings: { colorSchemeName: 'Dracula', browserBookmarks: ['local'] } }))
    const out = withUnsyncedFromRemote(merged, remote, new Set(['settings', 'projects']))
    assert.equal(out.get(s('colorSchemeName')), 'Dracula')
    assert.equal(out.has(s('browserBookmarks')), false)
  })

  test('フォントは種類が分かれ、既定には入らない（#407）', () => {
    for (const key of ['fontFamily', 'fontSize', 'editorFontName', 'editorFontSize', 'uiFontFamily', 'uiFontSize']) {
      assert.equal(categoryOf(s(key)), 'fonts', key)
    }
    assert.equal(categoryOf(s('colorSchemeName')), 'settings')
    assert.equal(DEFAULT_SYNC_CATEGORIES.includes('fonts'), false)
    // 既定のままなら、手元のフォントはリモートの値のまま書き戻る（＝出て行かない）。
    const remote = toItems(src({ settings: { fontSize: 12 } }))
    const merged = toItems(src({ settings: { fontSize: 14 } }))
    const out = withUnsyncedFromRemote(merged, remote, new Set(DEFAULT_SYNC_CATEGORIES))
    assert.equal(out.get(s('fontSize')), 12)
  })
})

describe('importSyncItems', () => {
  const local = src({ settings: { fontSize: 13, theme: 'dark' }, projects: [proj('a', { color: 'red' })] })
  const file = src({
    settings: { fontSize: 16, theme: 'dark', futureKey: 1 },
    projects: [proj('a', { color: 'blue', path: 'moved' }), proj('b', { color: 'green' })],
  })
  const m = importSyncItems(toItems(local), toItems(file))
  const keys = m.conflicts.map((c) => c.key)

  test('手元と違う項目だけを並べ、知らない設定と既存のプロジェクトの置き場所は並べない', () => {
    assert.ok(keys.includes(s('fontSize')))
    assert.ok(keys.includes(pf('a', 'color')))
    assert.ok(!keys.includes(s('theme')))
    assert.ok(!keys.includes(s('futureKey')))
    assert.ok(!keys.includes(pf('a', 'path')))
  })

  test('手元に無いプロジェクトは有無の 1 行にまとめ、取り込むとフィールドも付いてくる', () => {
    assert.ok(keys.includes(p('b')))
    assert.ok(!keys.includes(pf('b', 'color')))
    const out = resolveSyncItems(m, new Map([[p('b'), 'remote']]), 'local')
    assert.equal(out.get(pf('b', 'color')), 'green')
    assert.equal(out.get(pf('b', 'path')), 'b')
    // 選ばなかった項目は手元のまま。
    assert.equal(out.get(s('fontSize')), 13)
    assert.equal(out.get(pf('a', 'color')), 'red')
  })

  test('手元で作れないプロジェクトは並べず、並び順は共通の要素の相対順だけで比べる', () => {
    const here = src({ projects: [proj('a', { order: 0 }), proj('c', { order: 1 })] })
    const there = src({ projects: [proj('a', { order: 0 }), proj('b', { order: 1 }), proj('c', { order: 2 })] })
    const r = importSyncItems(toItems(here), toItems(there), (id) => id === 'b')
    assert.deepEqual(
      r.conflicts.map((c) => c.key),
      [],
    )
  })

  test('選ばなければ何も変わらず、手元にだけある項目も消えない', () => {
    const only = importSyncItems(toItems(src({ projects: [proj('x')] })), toItems(src({})))
    const out = resolveSyncItems(only, new Map(), 'local')
    assert.equal(stableKey([...out]), stableKey([...only.local]))
  })
})

describe('選択時にコピーの古い真偽値（#408）', () => {
  const modeOf = (file: Record<string, unknown>) => fromSyncFile(file).settings.terminalCopyOnSelectMode

  test('鍵と食い違う真偽値は古い版の変更として鍵に映す', () => {
    assert.equal(modeOf({ terminalCopyOnSelect: false, terminalCopyOnSelectMode: 'ask' }), 'off')
    assert.equal(modeOf({ terminalCopyOnSelect: true, terminalCopyOnSelectMode: 'off' }), 'ask')
    // 鍵の無いファイル（古い版しか書いていない）
    assert.equal(modeOf({ terminalCopyOnSelect: false }), 'off')
    assert.equal(modeOf({ terminalCopyOnSelect: true }), 'ask')
  })

  test('食い違わなければ鍵のまま', () => {
    assert.equal(modeOf({ terminalCopyOnSelect: true, terminalCopyOnSelectMode: 'always' }), 'always')
    assert.equal(modeOf({ terminalCopyOnSelect: false, terminalCopyOnSelectMode: 'off' }), 'off')
    assert.equal(modeOf({ terminalCopyOnSelectMode: 'ask' }), 'ask')
  })
})

describe('同期に戻す（#463）', () => {
  const ssh = 'git@github.com:kan/dotfiles.git'
  const https = 'https://github.com/kan/dotfiles'
  const candidates = (
    project: Pick<SyncedProject, 'platform' | 'remoteUrl'>,
    shared: SyncedProject[],
    taken: string[] = [],
  ) => rejoinCandidates(project, shared, (id) => taken.includes(id), normalizeRemoteUrl).map((s) => s.id)

  test('同じリポジトリを同じプラットフォームで指すエントリだけが候補になる', () => {
    const shared = [
      proj('dotfiles', { platform: 'wsl', remoteUrl: ssh }),
      proj('dotfiles-89781', { platform: 'windows', remoteUrl: https }),
      proj('other', { platform: 'windows', remoteUrl: 'https://github.com/kan/pike' }),
    ]
    // origin の書き方（ssh / https）が違っても同じリポジトリ。
    assert.deepEqual(candidates({ platform: 'windows', remoteUrl: ssh }, shared), ['dotfiles-89781'])
    assert.deepEqual(candidates({ platform: 'wsl', remoteUrl: https }, shared), ['dotfiles'])
  })

  test('手元が使っている id と、消した記録のある id は候補にしない', () => {
    const shared = [proj('dotfiles-89781', { remoteUrl: https }), proj('dotfiles-24037', { remoteUrl: https })]
    assert.deepEqual(candidates({ platform: 'windows', remoteUrl: https }, shared, ['dotfiles-89781']), [
      'dotfiles-24037',
    ])
  })

  test('origin が無ければ候補を出さない', () => {
    const shared = [proj('dotfiles', { remoteUrl: undefined })]
    assert.deepEqual(candidates({ platform: 'windows', remoteUrl: undefined }, shared), [])
    assert.deepEqual(candidates({ platform: 'windows', remoteUrl: https }, shared), [])
  })

  test('寄せたあとの同期は何も変えず、元の id のエントリも据え置く', () => {
    // 共有: `dotfiles` は WSL 側、`dotfiles-89781` は Windows 側。このマシンは `dotfiles` を
    // Windows 側に使っていたので外れていた。id を `dotfiles-89781` へ付け替え、値もそろえた。
    const wsl = proj('dotfiles', { platform: 'wsl', name: 'dotfiles_wsl', remoteUrl: ssh })
    const win = proj('dotfiles-89781', { platform: 'windows', name: 'dotfiles_win', remoteUrl: https })
    const shared = src({ projects: [wsl, win] })
    const local = src({ projects: [{ ...win, path: 'elsewhere/dotfiles' }] })
    const r = merge(shared, local, shared)
    assert.deepEqual(r.conflicts, [])
    const out = fromItems(resolveSyncItems(r, new Map(), 'remote')).projects
    assert.deepEqual(
      out.find((p) => p.id === 'dotfiles'),
      wsl,
    )
    assert.deepEqual(
      out.find((p) => p.id === 'dotfiles-89781'),
      win,
    )
  })
})

describe('isRespelling', () => {
  test('同じリポジトリの書き方違いだけを差し替え対象にする', () => {
    assert.equal(isRespelling('git@github.com:kan/pike.git', 'https://github.com/kan/pike'), true)
    assert.equal(isRespelling('https://github.com/kan/pike', 'https://github.com/kan/pike'), false)
    // fork と upstream は別のリポジトリ（差し替えると push 先が変わる）。
    assert.equal(isRespelling('git@github.com:me/pike.git', 'git@github.com:kan/pike.git'), false)
    assert.equal(isRespelling(null, 'https://github.com/kan/pike'), false)
  })
})
