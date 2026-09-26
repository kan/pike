// Text::Xslate の include / cascade の Ctrl+Click。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { xslateTemplateAt } from '../src/lib/jumpTo/xslateInclude.ts'

/** `line` の中の `needle` の真ん中を指したときの結果。 */
function at(line: string, needle: string) {
  return xslateTemplateAt(line, line.indexOf(needle) + Math.floor(needle.length / 2))
}

describe('xslateTemplateAt', () => {
  test('行コードの文字列', () => {
    const line = ': include "partials/footer.tx" { year => 2026 };'
    assert.deepEqual(at(line, 'footer'), {
      name: 'partials/footer.tx',
      from: line.indexOf('"'),
      to: line.lastIndexOf('"') + 1,
    })
  })

  test('<: :> の中と、単引用符', () => {
    assert.equal(at("<p><: include 'parts/nav.tx' :></p>", 'nav')?.name, 'parts/nav.tx')
  })

  test('裸の名前は :: を / にして .tx を足す', () => {
    assert.equal(at(': cascade myapp::base', 'base')?.name, 'myapp/base.tx')
  })

  test('cascade ... with の後ろに並べたもの', () => {
    const line = ': cascade "layout.tx" with macros::form, macros::table'
    assert.equal(at(line, 'layout')?.name, 'layout.tx')
    assert.equal(at(line, 'table')?.name, 'macros/table.tx')
    assert.equal(at(line, 'with'), null)
  })

  test('変数で include するものは対象にしない', () => {
    assert.equal(at(': include $tmpl { a => 1 }', 'tmpl'), null)
    assert.equal(at(': include $c.req.path', 'req'), null)
  })

  test('引数のハッシュは対象にしない', () => {
    assert.equal(at(': include "x.tx" { title => "t" }', 'title'), null)
  })

  test('Kolon のコードの外は拾わない', () => {
    assert.equal(at('<p>We include cookies</p>', 'cookies'), null)
    assert.equal(at('<p>include "x.tx"</p>', 'x.tx'), null)
  })
})
