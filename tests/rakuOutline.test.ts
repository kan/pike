// Raku の種別の判定とアウトライン（#452）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { EditorState } from '@codemirror/state'
import { rakuLanguage } from 'codemirror-lang-raku'
import { fileTypeKey, fileTypeLabelOf } from '../src/lib/fileType.ts'
import { rakuExtractor } from '../src/lib/outline/extractors/raku.ts'
import type { OutlineNode } from '../src/lib/outline/types.ts'

/** `kind name(detail)` を字下げで並べた形にする。 */
function outline(src: string): string[] {
  const state = EditorState.create({ doc: src, extensions: [rakuLanguage] })
  const nodes = rakuExtractor(src, { langId: 'raku', state }) ?? []
  const lines: string[] = []
  const walk = (list: OutlineNode[], depth: number) => {
    for (const n of list) {
      lines.push(`${'  '.repeat(depth)}${n.kind} ${n.name}${n.detail ? ` (${n.detail})` : ''}`)
      walk(n.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return lines
}

describe('種別の判定', () => {
  test('拡張子', () => {
    for (const name of ['a.raku', 'A.rakumod', 'a.rakutest', 'a.rakudoc', 'a.p6', 'A.pm6', 'a.pl6', 'a.pod6']) {
      assert.equal(fileTypeLabelOf(name), 'Raku', name)
    }
    assert.equal(fileTypeLabelOf('a.pm'), 'Perl')
  })

  test('shebang の perl6 は Perl 5 にしない', () => {
    assert.equal(fileTypeKey('script', '#!/usr/bin/env raku'), 'raku')
    assert.equal(fileTypeKey('script', '#!/usr/bin/perl6'), 'raku')
    assert.equal(fileTypeKey('script', '#!/usr/bin/env rakudo'), 'raku')
    assert.equal(fileTypeKey('script', '#!/usr/bin/perl5.36'), 'pl')
    assert.equal(fileTypeKey('script', '#!/usr/bin/env python3.11'), 'py')
  })
})

describe('アウトライン', () => {
  test('宣言の種類と入れ子', () => {
    const src = `class Point is Base {
  has $.x;
  method len() { }
  submethod BUILD() { }
}
role Shape { }
grammar G {
  token TOP { <a> }
  rule a { x }
  regex b-c { y }
}
module M { package P { } }
enum Color <Red Green>;
subset Pos of Int where * > 0;
my constant PI = 3;
our sub helper($x) is export { my sub inner() { } }
`
    assert.deepEqual(outline(src), [
      'class Point',
      '  method len',
      '  method BUILD (submethod)',
      'trait Shape',
      'class G (grammar)',
      '  method TOP (token)',
      '  method a (rule)',
      '  method b-c (regex)',
      'module M',
      '  namespace P',
      'enum Color',
      'type Pos (subset)',
      'constant PI',
      'function helper',
      '  function inner',
    ])
  })

  test('multi / proto / only は宣言子が無くても sub になる', () => {
    const src = 'multi foo($x) { }\nproto bar(|) {*}\nmulti method m(Int $x) { }\n'
    assert.deepEqual(outline(src), ['function foo', 'function bar', 'method m'])
  })

  test('unit の宣言は以降の宣言を子にする', () => {
    const src = 'use v6;\nunit class Foo::Bar;\nmethod a() { }\nsub b() { }\n'
    assert.deepEqual(outline(src), ['class Foo::Bar', '  method a', '  function b'])
  })

  test('unit の語が無くても、間にコメントがあっても同じ', () => {
    assert.deepEqual(outline('class Old;\nsub a() { }\n'), ['class Old', '  function a'])
    assert.deepEqual(outline('unit # c\nmodule M;\nsub a() { }\n'), ['module M', '  function a'])
  })

  test('sigil 付きの constant は sigil ごと名前にし、名前のノードが無いものは出さない', () => {
    const src = 'my constant $Z = 3;\nconstant @A = 1, 2;\nconstant = 1;\nconstant \\x = 2;\n'
    assert.deepEqual(outline(src), ['constant $Z', 'constant @A'])
  })

  test('名前と :sym<…> のあいだの空白は詰める', () => {
    const src = `grammar G {
  token c :sym<a> { a }
  token d:sym<b> { b }
}
sub infix:<< stash-eq >> ($l, $r) { }
`
    assert.deepEqual(outline(src), [
      'class G (grammar)',
      '  method c:sym<a> (token)',
      '  method d:sym<b> (token)',
      'function infix:<< stash-eq >>',
    ])
  })

  test('｢…｣ の引用の中の宣言は出さない', () => {
    assert.deepEqual(outline('is_run ｢sub foo() { }｣, 1;\nsub real() { }\n'), ['function real'])
  })

  test('無名の宣言は出さず、中の宣言は外へ出す', () => {
    const src = 'my $f = sub ($a) { sub named() { } };\nif $x { sub in-if() { } }\n'
    assert.deepEqual(outline(src), ['function named', 'function in-if'])
  })
})
