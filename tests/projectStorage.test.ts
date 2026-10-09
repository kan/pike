// プロジェクト id の付け替えで localStorage の項目を移す（#463）。`just test-ts` で走る
// （`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { moveProjectStorage, PROJECT_ID_LIST_KEY, PROJECT_KEY_PREFIX } from '../src/lib/projectStorage.ts'

function fakeStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

// **ソースの綴りを見張る**（`tests/userSelect.test.ts` と同じ置き場）。プロジェクト id を鍵に
// 持つ項目を表の外で組むと、id の付け替えで黙って取り残される。`pike:…:` で終わる接頭辞は
// 後ろに何かを繋ぐためのものなので、表にあるか、id 以外を繋ぐと分かっているものに限る。
const SRC = fileURLToPath(new URL('../src', import.meta.url))
const TABLE = join(SRC, 'lib', 'projectStorage.ts')
/** 後ろに繋ぐのがプロジェクト id ではない接頭辞（同期先の鍵・ドロップの照合 id）。 */
const NOT_PROJECT_KEYED = ['pike:sync-base:', 'pike:sync-last:', 'pike:sync-written:', 'pike:drop-paths:']
const KEY_PREFIX = /pike:[A-Za-z0-9:_-]*:(?=['"`]|\$\{)/g

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return /\.(vue|ts)$/.test(e.name) ? [path] : []
  })
}

test('id を後ろに繋ぐ鍵の接頭辞は projectStorage.ts の表だけにある', () => {
  const offenders: string[] = []
  for (const file of sources(SRC)) {
    if (file === TABLE) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(KEY_PREFIX)) {
          if (!NOT_PROJECT_KEYED.includes(m[0])) offenders.push(`${relative(SRC, file)}:${i + 1}: ${m[0]}`)
        }
      })
  }
  assert.deepEqual(
    offenders,
    [],
    'プロジェクト id を鍵にするなら `PROJECT_KEY_PREFIX` に足す。id 以外を繋ぐなら `NOT_PROJECT_KEYED` に足す',
  )
})

describe('moveProjectStorage', () => {
  test('id を鍵に持つ項目を全部移し、古い鍵を消す', () => {
    const initial = Object.fromEntries(Object.values(PROJECT_KEY_PREFIX).map((p) => [`${p}old`, `"${p}"`]))
    const s = fakeStorage(initial)
    moveProjectStorage(s, 'old', 'new')
    for (const prefix of Object.values(PROJECT_KEY_PREFIX)) {
      assert.equal(s.getItem(`${prefix}new`), `"${prefix}"`)
      assert.equal(s.getItem(`${prefix}old`), null)
    }
  })

  test('移す先に値があれば上書きしない（古い鍵は消す）', () => {
    const key = PROJECT_KEY_PREFIX.recentFiles
    const s = fakeStorage({ [`${key}old`]: '["a"]', [`${key}new`]: '["b"]' })
    moveProjectStorage(s, 'old', 'new')
    assert.equal(s.getItem(`${key}new`), '["b"]')
    assert.equal(s.getItem(`${key}old`), null)
  })

  test('id が前方一致するだけの別のプロジェクトには触らない', () => {
    const key = PROJECT_KEY_PREFIX.treeExpanded
    const s = fakeStorage({ [`${key}dotfiles`]: '1', [`${key}dotfiles-89781`]: '2' })
    moveProjectStorage(s, 'dotfiles', 'dotfiles-abc123')
    assert.equal(s.getItem(`${key}dotfiles-abc123`), '1')
    assert.equal(s.getItem(`${key}dotfiles-89781`), '2')
  })

  test('id の配列の項目は、その id だけを置き換える', () => {
    const key = PROJECT_ID_LIST_KEY.golangci
    const s = fakeStorage({ [key]: '["a","old","b"]' })
    moveProjectStorage(s, 'old', 'new')
    assert.deepEqual(JSON.parse(s.getItem(key) ?? ''), ['a', 'new', 'b'])
  })

  test('配列に移す先が既に居れば重ねない', () => {
    const key = PROJECT_ID_LIST_KEY.golangci
    const s = fakeStorage({ [key]: '["old","new"]' })
    moveProjectStorage(s, 'old', 'new')
    assert.deepEqual(JSON.parse(s.getItem(key) ?? ''), ['new'])
  })

  test('壊れた値があっても投げない', () => {
    const s = fakeStorage({ [PROJECT_ID_LIST_KEY.golangci]: '{not json' })
    assert.doesNotThrow(() => moveProjectStorage(s, 'old', 'new'))
  })
})
