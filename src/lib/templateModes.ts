/**
 * テンプレートエンジンのハイライト（#409）。**HTML の legacy モードに、区切り記号の内側だけ
 * 別のモードを差し込む**（CM5 の `addon/mode/multiplex` と同じ手法）。
 *
 * **依存を増やさない。** `@codemirror/legacy-modes` にテンプレート用のモードは無く、Lezer で
 * 混在言語を組むとエンジンごとに文法を書くことになる。区切りの内側の式は小さな自前の
 * モード（`exprMode`）で足りる。ERB だけは中身が Ruby そのものなので `ruby` を差し込む。
 *
 * 外側を `lang-html`（Lezer）ではなく legacy の `html` にするのは、StreamLanguage の中で
 * 1 行ずつ差し替えられるのが StreamParser だけだから。
 */

import type { StreamParser, StringStream } from '@codemirror/language'
import { css } from '@codemirror/legacy-modes/mode/css'
import { javascript } from '@codemirror/legacy-modes/mode/javascript'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { html } from '@codemirror/legacy-modes/mode/xml'
import { KOLON_LINE_CODE } from './jumpTo/xslateInclude'
import { escapeRegExp } from './text'

type AnyParser = StreamParser<unknown>

interface Region {
  /**
   * 開きの区切り。**`g` を付けること**（`lastIndex` から探す）。`^` は行頭でだけ当たる
   * （`m` を付けないので、`lastIndex` を進めても行の途中には当たらない）。
   */
  open?: RegExp
  /**
   * `open` の代わりに、**外側がトークンを読んだ直後に `pos` までの行を見て、真なら入る**
   * （`<script ...>` の直後）。区切りを持たない入り方で、中身が次の行から始まっても入れる。
   * トークンごとに呼ばれるので、安く判定できる形にすること。
   */
  enterAfter?: (line: string, pos: number) => boolean
  /**
   * 閉じの区切り（`g` 付き）。省くと行末で閉じる（Xslate の行コード）。**幅 0 の先読みなら
   * 区切りを食べずに外へ戻る**（`</script>` のタグは外側の HTML に読ませる）。
   */
  close?: RegExp
  /** 中身のモード。省くと区切りだけに色を付けて外側へ戻る（Blade のディレクティブ）。 */
  mode?: AnyParser
  /**
   * 区切りに付けるトークン名。既定は `meta`。`null` は色を付けずに読み飛ばすだけ
   * （ERB の `<%%` のようなエスケープを、外側のモードに読ませないため）。
   */
  style?: string | null
  /**
   * `close` の代わりに、開きに含めた `(` と対になる `)` で閉じる（Blade の `@if(...)`）。
   * 引数の中の `)`（`count($x)`）で閉じないよう、括弧の深さを数える。**数えるのは中身の
   * モードが返した `bracket` のトークン**なので、括弧を 1 文字ずつのトークンにするモード
   * （`exprMode`）に限る。文字列の中の括弧はモードが文字列として読むので数えない。
   */
  parens?: boolean
}

type ResolvedRegion = Region & { style: string | null }

interface MultiplexState {
  outer: unknown
  /** 開いている `Region` の添字。-1 なら外側。 */
  region: number
  inner: unknown
  depth: number
}

function copy(mode: AnyParser, state: unknown): unknown {
  if (mode.copyState) return mode.copyState(state)
  if (typeof state !== 'object' || state === null) return state
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(state)) out[k] = Array.isArray(v) ? v.slice() : v
  return out
}

/** 行を `cut` の手前までに見せかけて `f` を走らせる。内側のモードが閉じの区切りを食べないため。 */
function withCut<T>(stream: StringStream, cut: number, f: () => T): T {
  if (cut === Number.POSITIVE_INFINITY) return f()
  const orig = stream.string
  stream.string = orig.slice(0, cut)
  try {
    return f()
  } finally {
    stream.string = orig
  }
}

interface SearchMemo {
  line: string
  from: number
  match: RegExpExecArray | null
}

const searchMemo = new Map<RegExp, SearchMemo>()

/**
 * `stream.pos` から `re` の最初の一致を探す。**正規表現ごとに前回の結果を使い回す。**
 *
 * 区切りの探索は行末まで走るので、トークンごとに探し直すと 1 行が O(区域の数 × トークン数 ×
 * 行の長さ) になる。同じ行で前回の起点より後ろ、かつ前回の一致より手前なら答えは変わらない
 * （一致が無かったなら、後ろから探しても無い）。
 */
function search(re: RegExp, stream: StringStream): RegExpExecArray | null {
  const pos = stream.pos
  const memo = searchMemo.get(re)
  if (memo && memo.line === stream.string && memo.from <= pos && (!memo.match || memo.match.index >= pos)) {
    return memo.match
  }
  re.lastIndex = pos
  const match = re.exec(stream.string)
  searchMemo.set(re, { line: stream.string, from: pos, match })
  return match
}

/** `outer` に `regions` を差し込んだ StreamParser。 */
function multiplex(
  name: string,
  outer: AnyParser,
  specs: Region[],
  languageData?: StreamParser<unknown>['languageData'],
): StreamParser<MultiplexState> {
  const regions: ResolvedRegion[] = specs.map((r) => ({ style: 'meta', ...r }))
  const exit = (st: MultiplexState) => {
    st.region = -1
    st.inner = null
    st.depth = 0
  }
  const endsAtEol = (r: Region) => !r.close && !r.parens
  // `mode` を持たない区域には入らない（`enter`）ので、入っている区域のモードは必ずある。
  const modeOf = (st: MultiplexState) => regions[st.region].mode as AnyParser
  const enter = (st: MultiplexState, i: number, indentUnit: number) => {
    const r = regions[i]
    if (!r.mode) return
    st.region = i
    st.inner = r.mode.startState?.(indentUnit)
    st.depth = r.parens ? 1 : 0
  }

  function tokenOuter(stream: StringStream, st: MultiplexState): string | null {
    let cut = Number.POSITIVE_INFINITY
    for (let i = 0; i < regions.length; i++) {
      const open = regions[i].open
      const m = open && search(open, stream)
      if (!m) continue
      if (m.index === stream.pos) {
        stream.pos += m[0].length
        enter(st, i, stream.indentUnit)
        return regions[i].style
      }
      cut = Math.min(cut, m.index)
    }
    const style = withCut(stream, cut, () => outer.token(stream, st.outer))
    const i = regions.findIndex((r) => r.enterAfter?.(stream.string, stream.pos))
    if (i >= 0) enter(st, i, stream.indentUnit)
    return style
  }

  /** `undefined` は「幅 0 の閉じで外へ戻った」。 */
  function tokenInner(stream: StringStream, st: MultiplexState): string | null | undefined {
    const r = regions[st.region]
    let cut = Number.POSITIVE_INFINITY
    if (r.parens) {
      if (st.depth === 1 && stream.peek() === ')') {
        stream.next()
        exit(st)
        return r.style
      }
    } else if (r.close) {
      const m = search(r.close, stream)
      if (m && m.index === stream.pos) {
        stream.pos += m[0].length
        exit(st)
        return m[0].length === 0 ? undefined : r.style
      }
      if (m) cut = m.index
    }
    const start = stream.pos
    const style = withCut(stream, cut, () => modeOf(st).token(stream, st.inner))
    // StreamLanguage は進まないトークンを許さない。
    if (stream.pos === start) stream.next()
    if (r.parens && style === 'bracket') {
      const ch = stream.string[start]
      st.depth += ch === '(' ? 1 : ch === ')' ? -1 : 0
    }
    return style
  }

  return {
    name,
    languageData,
    startState: (indentUnit) => ({ outer: outer.startState?.(indentUnit), region: -1, inner: null, depth: 0 }),
    copyState: (st) => ({
      ...st,
      outer: copy(outer, st.outer),
      inner: st.region >= 0 ? copy(modeOf(st), st.inner) : null,
    }),
    token(stream, st) {
      // 行で閉じる区域は、次の行に持ち越さない（中身が空の行コード `:` だけの行もここで閉じる）。
      if (st.region >= 0 && stream.sol() && endsAtEol(regions[st.region])) exit(st)

      if (st.region >= 0) {
        const style = tokenInner(stream, st)
        // `undefined` は幅 0 の閉じで外へ戻ったとき。同じ位置から外側に読ませる。
        if (style !== undefined) return style
      }
      return tokenOuter(stream, st)
    },
    blankLine(st, indentUnit) {
      if (st.region < 0) outer.blankLine?.(st.outer, indentUnit)
      else if (endsAtEol(regions[st.region])) exit(st)
      else modeOf(st).blankLine?.(st.inner, indentUnit)
    },
  }
}

/** 区切りの内側を丸ごとコメントにする（`<%# %>` / `{{-- --}}` / `{# #}` / `{* *}`）。 */
const commentMode: StreamParser<null> = {
  startState: () => null,
  token(stream) {
    stream.skipToEnd()
    return 'comment'
  },
}

interface ExprOptions {
  keywords: string
  atoms?: string
  /** `$var` を変数として色付けする（PHP / Smarty / Xslate）。 */
  sigil?: boolean
  /** 行コメントの開始（Xslate の `#`）。 */
  lineComment?: string
}

interface ExprState {
  /** 閉じていない文字列の引用符。行をまたぐ文字列のため。 */
  quote: string | null
  /** 直前が `.` / `->` / `|` か。続く語をプロパティ・フィルタとして扱う。 */
  after: 'member' | 'filter' | null
}

/**
 * テンプレートの式（Blade / Twig / Smarty / Xslate の区切りの内側）。どれも「キーワード・
 * 変数・文字列・数値・演算子」で読めるので、1 つを語彙で切り替えて使う。
 */
function exprMode(opts: ExprOptions): StreamParser<ExprState> {
  const keywords = new Set(opts.keywords.split(' '))
  const atoms = new Set((opts.atoms ?? 'true false null').split(' '))

  const readString = (stream: StringStream, st: ExprState): string => {
    const quote = st.quote as string
    let ch = stream.next()
    while (ch != null) {
      if (ch === '\\') stream.next()
      else if (ch === quote) {
        st.quote = null
        break
      }
      ch = stream.next()
    }
    return 'string'
  }

  return {
    startState: () => ({ quote: null, after: null }),
    copyState: (st) => ({ ...st }),
    token(stream, st) {
      if (st.quote) return readString(stream, st)
      if (stream.eatSpace()) return null
      if (opts.lineComment && stream.match(opts.lineComment)) {
        stream.skipToEnd()
        return 'comment'
      }
      const after = st.after
      st.after = null
      const ch = stream.peek() as string
      if (ch === '"' || ch === "'") {
        stream.next()
        st.quote = ch
        return readString(stream, st)
      }
      if (stream.match(/^\d[\d_]*(?:\.\d+)?/)) return 'number'
      if (opts.sigil && stream.match(/^\$\w+/)) return 'variable-2'
      const word = stream.match(/^[A-Za-z_]\w*/) as RegExpMatchArray | null
      if (word) {
        if (after === 'member') return 'property'
        if (after === 'filter') return 'builtin'
        if (keywords.has(word[0])) return 'keyword'
        if (atoms.has(word[0].toLowerCase())) return 'atom'
        return 'variable'
      }
      if (stream.match('->') || stream.match('.')) {
        st.after = 'member'
        return 'operator'
      }
      if (stream.match(/^\|(?!\|)/)) {
        st.after = 'filter'
        return 'operator'
      }
      if (stream.match(/^[-+*/%=<>!&|~?:,^]+/)) return 'operator'
      if (stream.match(/^[()[\]{}]/)) return 'bracket'
      stream.next()
      return null
    },
  }
}

const phpExpr = exprMode({
  keywords:
    'if else elseif endif foreach endforeach for endfor while endwhile as return new function fn use isset empty array list echo print instanceof and or xor not match static self parent',
  sigil: true,
})

const twigExpr = exprMode({
  keywords:
    'for endfor in if elseif else endif block endblock extends include embed endembed set endset macro endmacro import from with only filter endfilter use apply endapply spaceless endspaceless verbatim endverbatim autoescape endautoescape sandbox endsandbox deprecated do flush guard endguard is not and or b-and b-or b-xor matches starts ends defined same as divisible by',
  atoms: 'true false null none',
})

const smartyExpr = exprMode({
  keywords:
    'if elseif else foreach foreachelse section sectionelse include assign capture block extends function call literal strip nocache while for as to step insert config_load append ldelim rdelim eq ne neq gt lt gte ge lte le not mod and or is even odd div by',
  sigil: true,
})

const kolonExpr = exprMode({
  keywords:
    'if else elsif unless given when default for while macro block around before after override cascade with include call super my constant last next and or not mod min max raw mark_raw unmark_raw html uri',
  atoms: 'true false nil',
  sigil: true,
  lineComment: '#',
})

/**
 * エンジンのコメント記法。**区域（色付け）と `commentTokens`（Mod+/ のコメントの切り替え）を
 * この 1 つから作る**ので、片方だけ直して食い違うことが無い。`closeRe` は閉じの綴りに
 * 揺れがあるとき（ERB の `-%>`）に、色付けの側だけ広げる。
 */
type Comment = { line: string } | { open: string; close: string; closeRe?: RegExp }

/** `<tag ...>` を閉じた `>` の直後か。`<` から先だけを見るので、長い行でも安い。 */
function afterOpenTag(tag: string): (line: string, pos: number) => boolean {
  const re = new RegExp(`^<${tag}\\b[^>]*>$`, 'i')
  return (line, pos) => {
    if (line[pos - 1] !== '>') return false
    const lt = line.lastIndexOf('<', pos - 1)
    return lt >= 0 && re.test(line.slice(lt, pos))
  }
}

/**
 * エンジンの区切りを HTML に差し込む。**`<script>` / `<style>` の中身は JS / CSS のモードにし、
 * その中でも同じ区切りを拾う**（Blade の `<script>` に `{{ }}` や `@json(...)` を書く）。
 * `lang-php` に載っていた `.blade.php` の `<script>` に色が付いていたので、ここで落とさない。
 */
function template(name: string, comment: Comment, specs: Region[]): StreamParser<MultiplexState> {
  const regions: Region[] =
    'line' in comment
      ? specs
      : [
          {
            open: new RegExp(escapeRegExp(comment.open), 'g'),
            close: comment.closeRe ?? new RegExp(escapeRegExp(comment.close), 'g'),
            mode: commentMode,
            style: 'comment',
          },
          ...specs,
        ]
  const commentTokens =
    'line' in comment ? { line: comment.line } : { block: { open: comment.open, close: comment.close } }
  const embed = (lang: AnyParser, tag: string): Region => ({
    enterAfter: afterOpenTag(tag),
    close: new RegExp(`(?=</${tag}\\b)`, 'gi'),
    mode: multiplex(name, lang, regions) as AnyParser,
  })
  return multiplex(name, html, [embed(javascript, 'script'), embed(css, 'style'), ...regions], { commentTokens })
}

/** ERB（`<% %>` / `<%= %>` / `<%- -%>`、`<%# %>` はコメント）。中身は Ruby のモード。 */
export const erb = template('erb', { open: '<%#', close: '%>', closeRe: /-?%>/g }, [
  // `<%%` は `<%` を文字として出すエスケープ。外側の HTML に読ませるとタグの始まりに見えて、
  // 以降のタグの対応が崩れる。
  { open: /<%%/g, style: null },
  { open: /<%[=-]?/g, close: /-?%>/g, mode: ruby },
])

/**
 * Blade（Laravel）。`{{ }}` / `{!! !!}` / `@php … @endphp` の中は PHP の式、`@if(...)` の
 * ような**ディレクティブは名前をキーワードに、引数を式にする**。`foo@example.com` や
 * エスケープの `@@if` を拾わないよう、`@` の直前に語の文字と `@` が無いことを見る。
 */
export const blade = template('blade', { open: '{{--', close: '--}}' }, [
  { open: /(?<!@)\{!!/g, close: /!!\}/g, mode: phpExpr },
  { open: /(?<!@)\{\{/g, close: /\}\}/g, mode: phpExpr },
  { open: /(?<![\w@])@php\b(?!\s*\()/g, close: /(?<![\w@])@endphp\b/g, mode: phpExpr, style: 'keyword' },
  { open: /(?<![\w@])@[A-Za-z_]\w*\s*\(/g, mode: phpExpr, style: 'keyword', parens: true },
  { open: /(?<![\w@])@[A-Za-z_]\w*/g, style: 'keyword' },
])

/** Twig（Symfony）。`{{ }}` / `{% %}` と空白制御の `-` / `~`、`{# #}` はコメント。 */
export const twig = template('twig', { open: '{#', close: '#}' }, [
  { open: /\{\{[-~]?/g, close: /[-~]?\}\}/g, mode: twigExpr },
  { open: /\{%[-~]?/g, close: /[-~]?%\}/g, mode: twigExpr },
])

/**
 * Smarty。`{* *}` はコメント。**`{` の直後が空白のものはタグにしない**（Smarty 3 の
 * auto_literal と同じ規則）。テンプレートに埋めた JS / CSS の `{ ... }` を拾わないため。
 */
export const smarty = template('smarty', { open: '{*', close: '*}' }, [
  { open: /\{(?=[^\s*])/g, close: /\}/g, mode: smartyExpr },
])

/**
 * Text::Xslate の Kolon（Perl）。`<: … :>` と、**行頭の `:` から行末までの行コード**
 * （`: for $items -> $item {`）。コメントは式の中の `#` なので、Mod+/ は行コードの
 * コメント（`: #`）を付け外しする。
 */
export const xslate = template('xslate', { line: ': #' }, [
  { open: /<:/g, close: /:>/g, mode: kolonExpr },
  { open: KOLON_LINE_CODE, mode: kolonExpr },
])
