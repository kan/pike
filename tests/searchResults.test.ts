import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatExtractBody, groupByFile, headingTargetAt } from '../src/lib/searchResults'

const m = (path: string, line: number, content = 'x') => ({ path, line, content })

describe('groupByFile', () => {
  it('出てきた順を保ってまとめる', () => {
    const groups = groupByFile([m('b.ts', 3), m('a.ts', 1), m('b.ts', 9)])
    assert.deepEqual(
      groups.map((g) => [g.path, g.matches.map((x) => x.line)]),
      [
        ['b.ts', [3, 9]],
        ['a.ts', [1]],
      ],
    )
  })

  it('空なら空', () => {
    assert.deepEqual(groupByFile([]), [])
  })
})

describe('formatExtractBody', () => {
  const matches = [m('/r/src/a.ts', 12, 'foo()'), m('/r/src/a.ts', 34, '  bar'), m('/r/b.md', 5, 'baz')]
  const rel = (p: string) => p.slice(3)

  it('list は grep の形', () => {
    assert.deepEqual(formatExtractBody(matches, rel, 'list'), [
      'src/a.ts:12: foo()',
      'src/a.ts:34:   bar',
      'b.md:5: baz',
    ])
  })

  it('grouped は見出しと字下げ、ファイルの間に空行', () => {
    assert.deepEqual(formatExtractBody(matches, rel, 'grouped'), [
      'src/a.ts',
      '  12: foo()',
      '  34:   bar',
      '',
      'b.md',
      '  5: baz',
    ])
  })
})

describe('headingTargetAt', () => {
  const doc = ['# 見出し', '', 'src/a.ts', '  12: foo()', '  34: 80: http', '', 'docs/設計/b.md', '  5: baz']
  const lineAt = (n: number) => doc[n - 1] ?? null
  const at = (n: number, col = 0) => headingTargetAt(lineAt, n, col)

  it('本文の行番号から、上の見出しのファイルと行を返す', () => {
    assert.deepEqual(at(4, 3), { path: 'src/a.ts', line: 12 })
    assert.deepEqual(at(5, 0), { path: 'src/a.ts', line: 34 })
    assert.deepEqual(at(8, 2), { path: 'docs/設計/b.md', line: 5 })
  })

  it('行番号より右（本文）では当たらない', () => {
    assert.equal(at(4, 6), null)
  })

  it('見出しの行は、直後が本文のときだけ 1 行目を返す', () => {
    assert.deepEqual(at(3), { path: 'src/a.ts', line: 1 })
    assert.equal(at(1), null)
  })

  it('パスだけの行や、見出しの無い本文には当たらない', () => {
    const plain = ['src/a.ts', 'src/b.ts', '', '  12: foo']
    const get = (n: number) => plain[n - 1] ?? null
    assert.equal(headingTargetAt(get, 1, 0), null)
    assert.equal(headingTargetAt(get, 4, 2), null)
  })

  it('YAML のような「キー: 」の下の数字の行を拾わない', () => {
    const yaml = ['ports:', '  80: http']
    assert.equal(
      headingTargetAt((n) => yaml[n - 1] ?? null, 2, 2),
      null,
    )
  })

  it('記号だけの行は見出しにしない', () => {
    const src = ['{', "  200: 'OK',"]
    assert.equal(
      headingTargetAt((n) => src[n - 1] ?? null, 2, 2),
      null,
    )
  })

  it('拡張子の無いルート直下のファイルは見出しにする', () => {
    const out = ['Makefile', '  3: all:']
    assert.deepEqual(
      headingTargetAt((n) => out[n - 1] ?? null, 2, 2),
      { path: 'Makefile', line: 3 },
    )
  })

  it('空白を含む行は見出しにしない', () => {
    const src = ['const x = 1', '  12: foo']
    assert.equal(
      headingTargetAt((n) => src[n - 1] ?? null, 2, 2),
      null,
    )
  })
})
