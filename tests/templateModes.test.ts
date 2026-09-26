// テンプレートエンジンのハイライト（#409）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type StreamParser, StringStream } from '@codemirror/language'
import { fileTypeKey } from '../src/lib/fileType.ts'
import { blade, erb, smarty, twig, xslate } from '../src/lib/templateModes.ts'

/** 行ごとに回して、`[文字列, トークン名]` を返す。空白だけのトークンは落とす。 */
function tokens<S>(mode: StreamParser<S>, text: string): [string, string | null][] {
  const state = mode.startState?.(2) as S
  const out: [string, string | null][] = []
  for (const line of text.split('\n')) {
    if (line === '') {
      mode.blankLine?.(state, 2)
      continue
    }
    const stream = new StringStream(line, 4, 2)
    while (!stream.eol()) {
      stream.start = stream.pos
      const style = mode.token(stream, state)
      assert.ok(stream.pos > stream.start, `進まないトークン: ${line}`)
      const s = stream.current()
      if (s.trim()) out.push([s, style])
    }
  }
  return out
}

/** `text` を持つ最初のトークンのトークン名。 */
function styleOf<S>(mode: StreamParser<S>, text: string, needle: string): string | null | undefined {
  return tokens(mode, text).find(([s]) => s === needle)?.[1]
}

describe('ERB', () => {
  test('区切りの中は Ruby、外は HTML', () => {
    const src = '<p class="x"><%= link_to user.name, user %></p>'
    assert.equal(styleOf(erb, src, 'p'), 'tag')
    assert.equal(styleOf(erb, src, '<%='), 'meta')
    assert.equal(styleOf(erb, src, '%>'), 'meta')
    assert.equal(styleOf(erb, src, 'link_to'), 'variable')
  })

  test('属性値の中の埋め込みから戻ると、属性値の続きになる', () => {
    const t = tokens(erb, '<a href="<%= path %>">x</a>')
    assert.deepEqual(
      t.filter(([, s]) => s === 'meta').map(([s]) => s),
      ['<%=', '%>'],
    )
    assert.equal(t.at(-1)?.[1], 'angleBracket')
  })

  test('<%# %> はコメント、-%> で閉じる', () => {
    assert.equal(styleOf(erb, '<%# note %>', ' note '), 'comment')
    assert.equal(styleOf(erb, '<% if x -%>', '-%>'), 'meta')
  })

  test('<%% はエスケープで、後ろの HTML を崩さない', () => {
    const t = tokens(erb, '<body>\n<%%= literal %>\n</body>')
    assert.equal(
      t.some(([, s]) => s === 'error'),
      false,
    )
    assert.deepEqual(
      t.filter(([s]) => s === 'body').map(([, s]) => s),
      ['tag', 'tag'],
    )
  })

  test('複数行の区域', () => {
    const t = tokens(erb, '<%\n  items.each do |i|\n%>\n<b>')
    assert.equal(t.find(([s]) => s === 'do')?.[1], 'keyword')
    assert.equal(t.at(-1)?.[1], 'angleBracket')
  })
})

describe('Blade', () => {
  test('{{ }} の中は PHP の式', () => {
    const src = '<p>{{ $user->name }}</p>'
    assert.equal(styleOf(blade, src, '$user'), 'variable-2')
    assert.equal(styleOf(blade, src, 'name'), 'property')
  })

  test('ディレクティブの引数の括弧は入れ子を数える', () => {
    const t = tokens(blade, '@if(count($items) > 1)<b>')
    assert.equal(t[0][1], 'keyword')
    assert.equal(t.find(([s]) => s === 'count')?.[1], 'variable')
    // `count(...)` の `)` では閉じず、最後の `)` が区切りになる
    assert.deepEqual(t.at(-4), [')', 'keyword'])
    assert.deepEqual(t.at(-2), ['b', 'tag'])
  })

  test('引数の無いディレクティブ、メールアドレスは拾わない', () => {
    assert.equal(styleOf(blade, '@endif', '@endif'), 'keyword')
    assert.equal(
      tokens(blade, 'foo@example.com').some(([, s]) => s === 'keyword'),
      false,
    )
  })

  test('{{-- --}} はコメント', () => {
    assert.equal(styleOf(blade, '{{-- todo --}}', ' todo '), 'comment')
  })
})

describe('Twig', () => {
  test('タグとフィルタ', () => {
    const src = '{% for item in items %}{{ item.title|upper }}{% endfor %}'
    assert.equal(styleOf(twig, src, 'for'), 'keyword')
    assert.equal(styleOf(twig, src, 'title'), 'property')
    assert.equal(styleOf(twig, src, 'upper'), 'builtin')
    assert.equal(styleOf(twig, src, '{%'), 'meta')
  })

  test('空白制御と {# #}', () => {
    assert.equal(styleOf(twig, '{%- if x -%}', '-%}'), 'meta')
    assert.equal(styleOf(twig, '{# c #}', ' c '), 'comment')
  })
})

describe('Smarty', () => {
  test('変数とタグ', () => {
    const src = '{if $user}{$user.name|escape}{/if}'
    assert.equal(styleOf(smarty, src, 'if'), 'keyword')
    assert.equal(styleOf(smarty, src, '$user'), 'variable-2')
    assert.equal(styleOf(smarty, src, 'escape'), 'builtin')
  })

  test('{ の直後が空白ならタグにしない（埋め込んだ JS）', () => {
    assert.equal(
      tokens(smarty, 'var o = { a: 1 };').some(([, s]) => s === 'meta'),
      false,
    )
  })
})

describe('Text::Xslate (Kolon)', () => {
  test('<: :> と行コード', () => {
    const src = ': for $items -> $item {\n<li><: $item.name :></li>\n: }'
    const t = tokens(xslate, src)
    assert.equal(t.find(([s]) => s === 'for')?.[1], 'keyword')
    assert.equal(t.find(([s]) => s === 'name')?.[1], 'property')
    assert.equal(t.find(([s]) => s === 'li')?.[1], 'tag')
  })

  test('行コードは行末で閉じる', () => {
    const t = tokens(xslate, ': if $x {\nplain if text')
    // 2 行目は HTML の地の文なので、`if` はキーワードにならない
    assert.equal(t.filter(([s, st]) => s === 'if' && st === 'keyword').length, 1)
  })

  test('# はコメント', () => {
    assert.equal(styleOf(xslate, '<: # note :>', '# note '), 'comment')
  })
})

describe('<script> / <style> の中身', () => {
  test('JS として色付けし、その中の区切りも拾う', () => {
    const t = tokens(blade, '<script>\nconst users = @json($users);\nlet n = {{ $n }};\n</script>\n<p>')
    assert.equal(t.find(([s]) => s === 'const')?.[1], 'keyword')
    assert.equal(t.find(([s]) => s === '@json(')?.[1], 'keyword')
    assert.equal(t.find(([s]) => s === '$n')?.[1], 'variable-2')
    // `</script>` は外側の HTML がタグとして読み、その後は HTML に戻る
    assert.deepEqual(
      t.filter(([s]) => s === 'script').map(([, st]) => st),
      ['tag', 'tag'],
    )
    assert.equal(t.at(-2)?.[0], 'p')
    assert.equal(t.at(-2)?.[1], 'tag')
  })

  test('開いた直後に閉じる <script></script> でも止まらない', () => {
    const t = tokens(twig, '<script src="a.js"></script><b>')
    assert.equal(t.at(-2)?.[0], 'b')
    assert.equal(t.at(-2)?.[1], 'tag')
  })

  test('<style> は CSS', () => {
    const t = tokens(erb, '<style>\n.a { color: <%= c %>; }\n</style>')
    assert.equal(t.find(([s]) => s === 'color')?.[1], 'property')
    assert.equal(t.find(([s]) => s === '<%=')?.[1], 'meta')
  })

  test('Mod+/ 用のコメント記法を持つ', () => {
    assert.deepEqual(erb.languageData?.commentTokens, { block: { open: '<%#', close: '%>' } })
    assert.deepEqual(xslate.languageData?.commentTokens, { line: ': #' })
  })
})

describe('fileTypeKey', () => {
  test('テンプレートの拡張子', () => {
    assert.equal(fileTypeKey('app/views/users/show.html.erb'), 'erb')
    assert.equal(fileTypeKey('resources/views/welcome.blade.php'), 'blade')
    assert.equal(fileTypeKey('templates/base.html.twig'), 'twig')
    assert.equal(fileTypeKey('index.tpl'), 'tpl')
    assert.equal(fileTypeKey('index.tx'), 'tx')
  })

  test('.blade.php 以外の php はそのまま', () => {
    assert.equal(fileTypeKey('src/Controller.php'), 'php')
    assert.equal(fileTypeKey('blade.php'), 'php')
  })
})
