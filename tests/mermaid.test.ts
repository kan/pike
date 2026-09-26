// mermaid の描画器の振り分け（#417）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as bm from 'beautiful-mermaid'
import { isBeautifulDiagram, misreadsGraph } from '../src/lib/mermaid.ts'

test('beautiful-mermaid が扱う 6 種は振り分ける', () => {
  for (const src of [
    'graph TD\n  A --> B',
    'flowchart lr\n  A --> B',
    'graph LR; A --> B',
    '  stateDiagram-v2\n  [*] --> A',
    'stateDiagram\n  [*] --> A',
    'sequenceDiagram\n  A->>B: hi',
    'classDiagram\n  A <|-- B',
    'erDiagram\n  A ||--o{ B : has',
    'xychart-beta\n  bar [1, 2]',
    'xychart-beta horizontal\n  bar [1, 2]',
  ]) {
    assert.equal(isBeautifulDiagram(src), true, src)
  }
})

test('扱わない図と、1 行目が見出しでない図は本家に回す', () => {
  for (const src of [
    'gantt\n  title x',
    'pie\n  "a" : 1',
    'gitGraph\n  commit',
    'mindmap\n  root',
    // 向きの無い flowchart は beautiful-mermaid が読めない
    'flowchart\n  A --> B',
    // 設定（フロントマター・init）を読むのは本家だけ
    '---\ntitle: x\n---\ngraph TD\n  A --> B',
    '%%{init: {"theme": "forest"}}%%\ngraph TD\n  A --> B',
    '%% comment\ngraph TD\n  A --> B',
    '',
  ]) {
    assert.equal(isBeautifulDiagram(src), false, src)
  }
})

test('beautiful-mermaid が投げずに読み違える flowchart / state は本家に回す', () => {
  for (const src of [
    // 空白を挟まない矢印でエッジが消え、ノード名が `A--` に化ける
    'graph TD\n  A-->B\n  B-->C',
    'graph LR\n  A-- label -->B',
    'graph TD\n  A==>B\n  A-.->C',
    // 本家にしか無い文
    'graph TD\n  A --> B\n  click A "https://example.com"',
    'stateDiagram-v2\n  [*] --> A\n  note right of A : memo',
  ]) {
    assert.equal(misreadsGraph(bm, src), true, src)
  }
  for (const src of [
    'graph TD\n  A --> B\n  B --> C',
    'graph TD\n  A[x]-->B[y]',
    'graph TD\n  my-node --> other',
    'stateDiagram-v2\n  [*] --> 待機\n  待機 --> 完了: done',
    'sequenceDiagram\n  A->>B: hi',
  ]) {
    assert.equal(misreadsGraph(bm, src), false, src)
  }
})
