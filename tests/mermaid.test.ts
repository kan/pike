// Mermaid の描画器（Pele、#508）。`just test-ts` で走る（`tsx --test`、node:test）。
//
// `renderMermaid` は DOMPurify に通すので DOM が要り、ここでは Pele を直に呼ぶ（オプションは
// 同じ `peleOptions`）。見るのは描画器を 1 つにした前提（#417 で beautiful-mermaid が読み違えた
// 図を読める、出力に `<style>` も `foreignObject` も無い）で、Pele の版を上げたときに崩れたら
// ここで落ちる。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { render as peleRender } from 'pele'
import { peleOptions } from '../src/lib/mermaid.ts'

const render = (source: string) => peleRender(source, peleOptions('t', 'sans-serif'))

/** 描いた図のノードと辺の id（`data-id`）。 */
function ids(svg: string, kind: 'node' | 'edge'): string[] {
  // `pele-edge-label` を辺に数えない（class の語として一致させる）
  return Array.from(svg.matchAll(new RegExp(`class="pele-${kind}(?: [^"]*)?" data-id="([^"]+)"`, 'g')), (m) => m[1])
}

test('空白を挟まない矢印を読む（#417 で beautiful-mermaid はノード名を `A--` にした）', () => {
  const { svg } = render('graph TD\n  A-->B\n  A-.->C\n  A==>|x|D')
  assert.deepEqual(ids(svg, 'node').sort(), ['A', 'B', 'C', 'D'])
  assert.equal(ids(svg, 'edge').length, 3)
})

test('`click` をノードにしない', () => {
  const { svg } = render('graph LR\n  A --> B\n  click A "https://example.com"\n  click B call alert()')
  assert.deepEqual(ids(svg, 'node').sort(), ['A', 'B'])
  assert.doesNotMatch(svg, /<a\b/)
})

test('ラベルの HTML はタグとして出さない', () => {
  const { svg } = render('graph LR\n  A["<img src=x onerror=alert(1)>"] --> B["<script>x</script> &lt;b&gt;"]')
  assert.doesNotMatch(svg, /<img|<script|onerror/)
})

test('`<style>` も `foreignObject` も出さない（ページの他の SVG に効かず、DOMPurify でラベルが消えない）', () => {
  for (const src of [
    'graph TD\n  A[開始] --> B{判定}',
    'sequenceDiagram\n  A->>B: hi',
    'gantt\n  dateFormat YYYY-MM-DD\n  section S\n  T :a1, 2026-01-01, 3d',
    'pie\n  "a" : 1\n  "b" : 2',
    'mindmap\n  root\n    child',
    'gitGraph\n  commit\n  branch dev\n  commit',
  ]) {
    const { svg } = render(src)
    assert.doesNotMatch(svg, /<style|<foreignObject/i, src)
  }
})

test('beautiful-mermaid が扱えず本家に回していた図も描く', () => {
  for (const [src, type] of [
    ['gantt\n  dateFormat YYYY-MM-DD\n  section S\n  T :a1, 2026-01-01, 3d', 'gantt'],
    ['pie\n  "a" : 1', 'pie'],
    ['gitGraph\n  commit', 'gitGraph'],
    ['mindmap\n  root', 'mindmap'],
    ['flowchart\n  A --> B', 'flowchart'],
    ['---\ntitle: x\n---\ngraph TD\n  A --> B', 'flowchart'],
    ['%%{init: {"theme": "forest"}}%%\ngraph TD\n  A --> B', 'flowchart'],
    ['%% comment\ngraph TD\n  A --> B', 'flowchart'],
  ] as const) {
    assert.equal(render(src).type, type, src)
  }
})
