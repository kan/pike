// プレビューの GitHub 拡張書式（#482）。`just test-ts` で走る（`tsx --test`、node:test）。
// 組み合わせ（`lib/markdownGfm.ts`）は色付けのために CodeMirror を読むので、ここでは拡張を
// 直接 `Marked` に載せて見る。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Marked, type MarkedExtension } from 'marked'
import { issueRefs } from '../src/lib/issueRefs.ts'
import { alerts } from '../src/lib/markdownAlerts.ts'
import { colorSwatches, colorValue } from '../src/lib/markdownColors.ts'
import { emoji, loadEmojiFor } from '../src/lib/markdownEmoji.ts'
import { footnotes } from '../src/lib/markdownFootnotes.ts'
import { hasMathBlock, math, mathBlock } from '../src/lib/markdownMath.ts'

function render(md: string, ...exts: MarkedExtension[]): string {
  return new Marked(...exts).parse(md) as string
}

describe('alert', () => {
  test('5 種類を枠にする。種類名は大文字小文字を区別しない', () => {
    for (const kind of ['NOTE', 'tip', 'Important', 'WARNING', 'caution']) {
      const html = render(`> [!${kind}]\n> 本文`, alerts())
      assert.match(html, new RegExp(`class="markdown-alert markdown-alert-${kind.toLowerCase()}"`), kind)
      assert.match(html, /<p>本文<\/p>/)
      assert.doesNotMatch(html, /\[!/)
    }
  })

  test('本文の Markdown は通常どおり描く', () => {
    const html = render('> [!TIP]\n> [リンク](https://example.com) と `code`\n> - a\n> - b', alerts())
    assert.match(html, /<a href="https:\/\/example.com">リンク<\/a>/)
    assert.match(html, /<code>code<\/code>/)
    assert.match(html, /<li>a<\/li>/)
  })

  test('未知の種類・本文が空・同じ行に続きがあるものは普通の引用のまま', () => {
    for (const md of ['> [!FOO]\n> x', '> [!NOTE]', '> [!NOTE] 続き\n> x']) {
      const html = render(md, alerts())
      assert.match(html, /<blockquote>/, md)
      assert.doesNotMatch(html, /markdown-alert/, md)
    }
  })

  test('リストの中の alert も本文を段落として描く', () => {
    assert.match(render('- item\n  > [!NOTE]\n  > body', alerts()), /<p>body<\/p>/)
  })

  test('普通の引用は変わらない', () => {
    assert.equal(render('> quote', alerts()), render('> quote'))
  })
})

describe('数式', () => {
  const inline = (md: string) => render(md, math())

  test('インラインの $…$ と $`…`$', () => {
    assert.match(inline('式 $x^2$ です'), /<span class="math math-inline">x\^2<\/span>/)
    assert.match(inline('値$x$を'), /<span class="math math-inline">x<\/span>/)
    assert.match(inline('式 $`a$b`$ です'), /<span class="math math-inline">a\$b<\/span>/)
  })

  test('金額の $ は数式にしない', () => {
    for (const md of ['$5 と $10', '価格は $ 5 $ です', 'US$5 and 3$', '$x $']) {
      assert.doesNotMatch(inline(md), /class="math/, md)
    }
  })

  test('閉じの直後が数字なら数式にしない', () => {
    assert.doesNotMatch(inline('$1,000 から $2'), /class="math/)
  })

  test('エスケープした $ は数式にしない', () => {
    assert.doesNotMatch(inline('\\$x$ と書く'), /class="math/)
    assert.doesNotMatch(inline('a \\$x$ y'), /class="math/)
    assert.match(inline('a \\$x$ y'), /a \$x\$ y/)
  })

  test('コードスパンの中は数式にしない', () => {
    assert.doesNotMatch(inline('`$x$`'), /class="math/)
  })

  test('段落の中の $$…$$ は表示形式', () => {
    assert.match(inline('前 $$a+b$$ 後'), /<span class="math math-display">a\+b<\/span>/)
  })

  test('```math は表示形式のブロック', () => {
    const html = inline('```math\n\\frac{1}{2}\n```')
    assert.match(html, /<div class="math math-display">\\frac\{1\}\{2\}<\/div>/)
  })

  test('行頭の $$ ブロック（複数行）', () => {
    const md = '前の段落\n$$\na = b\n+ c\n$$\n後の段落'
    assert.equal(hasMathBlock(md), true)
    const html = render(md, mathBlock(), math())
    assert.match(html, /<div class="math math-display">a = b\n\+ c<\/div>/)
    assert.match(html, /<p>前の段落<\/p>/)
    assert.match(html, /<p>後の段落<\/p>/)
  })

  test('閉じていない行頭の $$ は、後ろの段落やコードを飲み込まない', () => {
    const md = '$$a$$ is text\n\npara two\n\n```sh\necho hi\n```\n\n$$\nb\n$$'
    const html = render(md, mathBlock(), math())
    assert.match(html, /<p>para two<\/p>/)
    assert.match(html, /<code[^>]*>echo hi/)
    assert.match(html, /<div class="math math-display">b<\/div>/)
  })

  test('ソースはエスケープして出す', () => {
    assert.match(inline('$a<b$'), /a&(?:lt|#60);b/)
  })

  test('行頭に $$ が無ければ block 拡張は要らない', () => {
    assert.equal(hasMathBlock('文中の $$a$$ だけ'), false)
  })
})

describe('カラーコード', () => {
  test('色の値だけのコードスパンに色見本を付ける', () => {
    for (const v of [
      '#0969DA',
      '#fff',
      'rgb(9, 105, 218)',
      'rgba(9,105,218,0.5)',
      'hsl(212, 92%, 45%)',
      'rgb(9 105 218 / 50%)',
    ]) {
      const html = render(`\`${v}\``, colorSwatches())
      assert.match(html, /class="color-swatch" style="background-color: /, v)
    }
  })

  test('色の値でないものと、素の #0969DA は対象外', () => {
    for (const md of ['`#ggg`', '`red`', '`rgb(1)`', '`#0969DA は青`', '#0969DA', '`rgb(1,2,3);color:red`']) {
      assert.doesNotMatch(render(md, colorSwatches()), /color-swatch/, md)
    }
  })

  test('値に宣言の外へ抜ける文字を許さない', () => {
    assert.equal(colorValue('rgb(1,2,3)"onmouseover="x'), null)
    assert.equal(colorValue('#fff;background:url(x)'), null)
  })
})

describe('絵文字', () => {
  test('ショートコードを置き換える。コードの中と表に無い名前はそのまま', async () => {
    await loadEmojiFor(':tada:')
    assert.match(render(':tada: と :+1:', emoji()), /🎉 と 👍/)
    assert.match(render('`:tada:`', emoji()), /<code>:tada:<\/code>/)
    assert.match(render('12:30:00 と :no_such_emoji:', emoji()), /12:30:00 と :no_such_emoji:/)
  })
})

describe('issue 参照', () => {
  test('リンクの文字の中では拾わない', () => {
    const html = render('[#12 を参照](https://example.com)', issueRefs())
    assert.doesNotMatch(html, /issue-ref/)
  })

  test('文中と見出しでは拾い、色コードとコードの中は拾わない', () => {
    assert.match(render('see #12', issueRefs()), /data-issue="12"/)
    assert.match(render('## fix #3', issueRefs()), /data-issue="3"/)
    assert.doesNotMatch(render('color #fff and `#12`', issueRefs()), /issue-ref/)
  })
})

test('全部を載せても脚注と alert が共存する', () => {
  const md = '> [!NOTE]\n> 注[^1]と $x$\n\n[^1]: 脚注'
  const html = render(md, footnotes(), alerts(), math())
  assert.match(html, /markdown-alert-note/)
  assert.match(html, /footnote-ref/)
  assert.match(html, /math-inline/)
})
