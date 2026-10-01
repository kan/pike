// 「移って走らせて戻る」1 行の組み立て（#432）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runInDir } from '../src/types/tab.ts'

const RESUME = 'claude --resume abc'

describe('runInDir', () => {
  test('bash 系はサブシェルで走らせる（親は動かない）', () => {
    assert.equal(
      runInDir({ kind: 'wsl', distro: 'Ubuntu' }, '/home/kan/sitter/.worktree/com-531', RESUME),
      `(cd '/home/kan/sitter/.worktree/com-531' && ${RESUME})`,
    )
    assert.equal(runInDir({ kind: 'git-bash' }, 'C:/r/wt', RESUME), `(cd 'C:/r/wt' && ${RESUME})`)
  })

  test('単一引用符を含むパスは閉じて繋ぎ直す', () => {
    assert.equal(runInDir({ kind: 'unix' }, "/tmp/it's", RESUME), `(cd '/tmp/it'\\''s' && ${RESUME})`)
  })

  test('cmd は pushd で移り、終わったら popd で戻る', () => {
    assert.equal(runInDir({ kind: 'cmd' }, 'D:/r/my wt', RESUME), `pushd "D:/r/my wt" && (${RESUME} & popd)`)
  })

  test('PowerShell は 5 と 7 で同じ行（$? で移れたかを見る）', () => {
    const line = `Push-Location -LiteralPath 'C:/r/o''wt'; if ($?) { ${RESUME}; Pop-Location }`
    assert.equal(runInDir({ kind: 'powershell' }, "C:/r/o'wt", RESUME), line)
    assert.equal(runInDir({ kind: 'pwsh' }, "C:/r/o'wt", RESUME), line)
  })
})
