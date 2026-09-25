// URL の判定（#412）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isSamePage } from '../src/lib/format.ts'

describe('isSamePage', () => {
  test('クエリとフラグメントだけの違いは同じページ', () => {
    const board = 'https://x.atlassian.net/jira/software/projects/A/boards/1'
    assert.equal(isSamePage(board, `${board}?selectedIssue=A-1`), true)
    assert.equal(isSamePage(`${board}?selectedIssue=A-1`, `${board}?selectedIssue=A-2`), true)
    assert.equal(isSamePage(board, `${board}#top`), true)
  })

  test('パスが変われば別のページ', () => {
    assert.equal(isSamePage('https://github.com/kan/pike', 'https://github.com/kan/pike/issues'), false)
  })

  test('オリジンが変われば別のページ（ポートも見る）', () => {
    assert.equal(isSamePage('https://a.example.com/x', 'https://b.example.com/x'), false)
    assert.equal(isSamePage('http://localhost:3000/', 'http://localhost:3001/'), false)
  })

  test('読めない URL は同じとみなさない', () => {
    assert.equal(isSamePage('not a url', 'not a url'), false)
  })
})
