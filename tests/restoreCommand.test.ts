// 固定タブを復元するときのコマンドの決め方（#437）。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { restoreCommandFor } from '../src/lib/agents.ts'

describe('restoreCommandFor', () => {
  const session = { agent: 'claude', id: '0b5c' } as const

  it('セッションが分からなければ「続きから」に読み替える', () => {
    assert.deepEqual(restoreCommandFor('claude'), { command: 'claude --continue' })
    assert.deepEqual(restoreCommandFor('codex'), { command: 'codex resume --last' })
  })

  it('表に無い行はそのまま走らせる', () => {
    assert.deepEqual(restoreCommandFor('npm run dev'), { command: 'npm run dev' })
  })

  it('そのタブのセッションが分かっていれば id を指定して再開する', () => {
    assert.deepEqual(restoreCommandFor('claude', session), { command: 'claude --resume 0b5c', session })
    // 古い版が「続きから」に読み替えて保存した行も、同じエージェントの起動行として扱う。
    assert.deepEqual(restoreCommandFor('claude --continue', session), { command: 'claude --resume 0b5c', session })
  })

  it('利用者が書いた行と、別のエージェントの行には id を足さない', () => {
    assert.deepEqual(restoreCommandFor('claude --model opus', session), { command: 'claude --model opus' })
    assert.deepEqual(restoreCommandFor('claude --resume abc --model opus', session), {
      command: 'claude --resume abc --model opus',
    })
    assert.deepEqual(restoreCommandFor('codex', session), { command: 'codex resume --last' })
  })

  it('id の形をしていない値はシェルの行に入れない', () => {
    for (const id of ['0b5c; rm -rf ~', '$(whoami)', 'a b', '']) {
      assert.deepEqual(restoreCommandFor('claude', { agent: 'claude', id }), { command: 'claude --continue' })
    }
  })
})
