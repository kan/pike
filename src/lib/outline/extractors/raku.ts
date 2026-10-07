import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { Extractor, OutlineKind, OutlineNode } from '../types'

/**
 * Raku のアウトライン（#452）。`codemirror-lang-raku` の構文木から宣言を拾う。
 *
 * **ノード名はライブラリの公開インターフェース**（README の「Syntax tree」）。0.x のあいだは
 * マイナーバージョンで変わりうるので、依存を上げるときはあちらを確認する。
 */

/**
 * 宣言ノード → 名前を持つ子ノードと、宣言子から種別を引けなかったときの種別。
 *
 * `multi foo($x) { }` は宣言子を持たず、最初の子が名前になるので、`kind` で sub として扱う。
 * ライブラリが宣言子を足したときもここへ落ちる。
 */
const DECLARATIONS: Record<string, { nameNode: string; kind: OutlineKind }> = {
  PackageDeclaration: { nameNode: 'PackageName', kind: 'class' },
  RoutineDeclaration: { nameNode: 'RoutineName', kind: 'function' },
  RegexDeclaration: { nameNode: 'RegexName', kind: 'method' },
  EnumDeclaration: { nameNode: 'EnumName', kind: 'enum' },
  SubsetDeclaration: { nameNode: 'SubsetName', kind: 'type' },
  ConstantDeclaration: { nameNode: 'ConstantName', kind: 'constant' },
}

/**
 * 宣言子のキーワード（宣言ノードの最初の子で、綴りがそのままノード名）→ 種別。
 * 載っていない宣言子は `DECLARATIONS` の `kind` に落ちる。
 *
 * `role` は `trait`（合成される側。PHP の trait と同じ扱い）、`token` / `rule` / `regex` は
 * grammar のメソッドなので `method`。`grammar` は class の一種。
 */
const KINDS: Record<string, OutlineKind> = {
  class: 'class',
  grammar: 'class',
  role: 'trait',
  module: 'module',
  package: 'namespace',
  sub: 'function',
  method: 'method',
  submethod: 'method',
  token: 'method',
  rule: 'method',
  regex: 'method',
  enum: 'enum',
  subset: 'type',
  constant: 'constant',
}

/** 種別だけでは宣言子が分からないものは、名前の横に宣言子を出す。 */
const SHOW_DECLARATOR = new Set(['grammar', 'submethod', 'token', 'rule', 'regex', 'subset'])

/**
 * `parent` の下の宣言を `out` へ集める。**宣言でないノード（`if` のブロック、括弧）は素通しで
 * 潜る**ので、その中の宣言は外側の宣言の子になる。無名の宣言（`sub ($a) { }`、名前のノードを
 * 持たない `constant \x = 2`）も同じく素通しにする。
 *
 * **入れ先を引数で受ける**（戻り値の配列を展開しない）。この文法は文や式を解析せず全トークンを
 * ノードにするので、ノードごとに配列を作ると文書の大きさに比例した割り当てが打鍵のたびに走る。
 */
function collect(parent: SyntaxNode, text: string, lineFor: (offset: number) => number, out: OutlineNode[]): void {
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (!c.firstChild) continue
    const nameNode = c.name in DECLARATIONS ? c.getChild(DECLARATIONS[c.name].nameNode) : null
    if (!nameNode) {
      collect(c, text, lineFor, out)
      continue
    }
    const declarator = c.firstChild.name
    const kind = KINDS[declarator] ?? DECLARATIONS[c.name].kind
    // `token c :sym<a>` の名前は空白ごと `c :sym<a>` になる（0.4.0）。`c:sym<a>` と同じ表示に揃える。
    const name = text.slice(nameNode.from, nameNode.to).replace(/\s+(?=:)/g, '')
    const line = lineFor(c.from)
    // `unit class Foo;` は `;` で終わり、以降の宣言は木の上では兄弟になる。子へ振り替える。
    // **`unit` の語は見ない**: 間にコメントが入りうるうえ、古い Perl 6 は `unit` 無しで書いた。
    const isUnit = c.name === 'PackageDeclaration' && c.lastChild?.name === ';'
    const node: OutlineNode = {
      id: `${kind}:${name}:${line}:${c.from}`,
      name,
      detail: SHOW_DECLARATOR.has(declarator) ? declarator : undefined,
      kind,
      line,
      from: c.from,
      // `unit` の宣言は親の終わりまでが本体（カーソル位置の追従がこの範囲を見る）。
      to: isUnit ? parent.to : Math.max(c.to, nameNode.to),
      children: [],
    }
    out.push(node)
    if (isUnit) out = node.children
    else collect(c, text, lineFor, node.children)
  }
}

export const rakuExtractor: Extractor = (text, ctx) => {
  const tree = ensureSyntaxTree(ctx.state, ctx.state.doc.length, 150) ?? syntaxTree(ctx.state)
  const lineFor = (offset: number) => ctx.state.doc.lineAt(offset).number
  const out: OutlineNode[] = []
  collect(tree.topNode, text, lineFor, out)
  return out
}
