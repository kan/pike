// エディタの blame（#510）の、行の追いかけ。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EditorState } from '@codemirror/state'
import { blameAt, blameField, requestBlame, setBlame } from '../src/lib/editorBlame.ts'
import type { BlameCommit, GitBlame } from '../src/types/git.ts'

const A: BlameCommit = { hash: 'a'.repeat(40), author: 'Alice', time: 1, summary: 'first', uncommitted: false }
const B: BlameCommit = { hash: 'b'.repeat(40), author: 'Bob', time: 2, summary: 'second', uncommitted: false }

/** 文書を作って blame を載せる。`lines` は各行のコミット（0 = A、1 = B）。 */
function loaded(doc: string, lines: number[]): EditorState {
  const state = EditorState.create({ doc, extensions: [blameField] })
  const requested = state.update({ effects: requestBlame.of(1) }).state
  return requested.update({ effects: setBlame.of({ id: 1, blame: { commits: [A, B], lines } }) }).state
}

/** 各行の作者（未コミットは `*`、blame の無い行は `-`）。 */
function authors(state: EditorState): string[] {
  const out: string[] = []
  for (let i = 1; i <= state.doc.lines; i++) {
    const c = blameAt(state, i)
    out.push(c === null ? '-' : c.uncommitted ? '*' : c.author)
  }
  return out
}

test('結果を行に並べる。ファイルが改行で終わるときの末尾の空行は blame を持たない', () => {
  assert.deepEqual(authors(loaded('a\nb\nc\n', [0, 0, 1])), ['Alice', 'Alice', 'Bob', '-'])
  assert.deepEqual(authors(loaded('a\nb\nc', [0, 0, 1])), ['Alice', 'Alice', 'Bob'])
})

test('打った行だけ未コミットになる', () => {
  const state = loaded('a\nb\nc', [0, 0, 1])
  const pos = state.doc.line(2).to
  const next = state.update({ changes: { from: pos, insert: 'x' } }).state
  assert.deepEqual(authors(next), ['Alice', '*', 'Bob'])
})

test('行末で Enter を打つと、新しい行だけが未コミットになる', () => {
  const state = loaded('a\nb\nc', [0, 0, 1])
  const next = state.update({ changes: { from: state.doc.line(1).to, insert: '\n' } }).state
  assert.deepEqual(authors(next), ['Alice', '*', 'Alice', 'Bob'])
})

test('行頭で Enter を打つと、上にできた新しい行だけが未コミットになる', () => {
  const state = loaded('a\nb\nc', [0, 0, 1])
  const next = state.update({ changes: { from: state.doc.line(3).from, insert: '\n' } }).state
  assert.deepEqual(authors(next), ['Alice', 'Alice', '*', 'Bob'])
})

test('空行で Enter を打つと、元の空行は blame を保ち、新しい行だけが未コミットになる', () => {
  const state = loaded('a\n\nc', [0, 1, 0])
  const next = state.update({ changes: { from: state.doc.line(2).from, insert: '\n' } }).state
  assert.deepEqual(authors(next), ['Alice', '*', 'Bob', 'Alice'])
})

test('行を消すと、続く行の blame がそのまま繰り上がる', () => {
  const state = loaded('a\nb\nc', [0, 1, 0])
  const line = state.doc.line(2)
  // 2 行目を改行ごと消す（`b\n`）。
  const next = state.update({ changes: { from: line.from, to: line.to + 1 } }).state
  assert.deepEqual(authors(next), ['Alice', 'Alice'])
})

test('2 行を連結した行は未コミットになる', () => {
  const state = loaded('a\nb\nc', [0, 1, 0])
  const next = state.update({ changes: { from: state.doc.line(1).to, to: state.doc.line(2).from } }).state
  assert.deepEqual(authors(next), ['*', 'Alice'])
})

test('取得を待つあいだの編集をずらしてから載せる', () => {
  const state = EditorState.create({ doc: 'a\nb\nc', extensions: [blameField] })
  const requested = state.update({ effects: requestBlame.of(1) }).state
  // 待つあいだに先頭へ 1 行足す。
  const edited = requested.update({ changes: { from: 0, insert: 'new\n' } }).state
  const blame: GitBlame = { commits: [A, B], lines: [0, 1, 0] }
  const done = edited.update({ effects: setBlame.of({ id: 1, blame }) }).state
  assert.deepEqual(authors(done), ['*', 'Alice', 'Bob', 'Alice'])
})

test('追い越された古い結果は捨てる', () => {
  const state = EditorState.create({ doc: 'a\nb', extensions: [blameField] })
  const second = state.update({ effects: requestBlame.of(1) }).state.update({ effects: requestBlame.of(2) }).state
  const stale = second.update({ effects: setBlame.of({ id: 1, blame: { commits: [A], lines: [0, 0] } }) }).state
  assert.deepEqual(authors(stale), ['-', '-'])
})

test('行数が合わない結果は載せない（ディスクのファイルが書き換わっていた）', () => {
  assert.deepEqual(authors(loaded('a\nb\nc', [0, 1])), ['-', '-', '-'])
})

test('追跡外のファイル（blame が null）では何も出さない', () => {
  const state = EditorState.create({ doc: 'a', extensions: [blameField] })
  const requested = state.update({ effects: requestBlame.of(1) }).state
  const done = requested.update({ effects: setBlame.of({ id: 1, blame: null }) }).state
  assert.deepEqual(authors(done), ['-'])
})
