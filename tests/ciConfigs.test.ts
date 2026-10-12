// 監視の変更から「CI の設定の有無を聞き直すか」を決める述語。`just test-ts` で走る（`tsx --test`、node:test）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ciConfigsMayHaveChanged } from '../src/lib/ciConfigs.ts'

const ROOT = '/home/kan/repo'
const NONE = { github: false, circleci: false }
const BOTH = { github: true, circleci: true }
const create = (rel: string) => ({ path: `${ROOT}/${rel}`, kind: 'create' as const })
const modify = (rel: string) => ({ path: `${ROOT}/${rel}`, kind: 'modify' as const })
const remove = (rel: string) => ({ path: `${ROOT}/${rel}`, kind: 'delete' as const })
/** WSL のプロジェクトで、変更 1 件が聞き直しを起こすか。 */
const hit = (change: ReturnType<typeof create | typeof modify | typeof remove>, known = NONE) =>
  ciConfigsMayHaveChanged(ROOT, [change], known, 'wsl')

describe('ciConfigsMayHaveChanged', () => {
  test('設定のディレクトリとその親は、種別を問わず拾う', () => {
    for (const rel of ['.github', '.github/workflows', '.circleci']) {
      for (const change of [create(rel), modify(rel), remove(rel)]) {
        assert.equal(hit(change, NONE), true, `${change.kind} ${rel}`)
        assert.equal(hit(change, BOTH), true, `${change.kind} ${rel}`)
      }
    }
  })

  test('中のファイルは、無いと覚えているときの作成と変更だけ拾う', () => {
    assert.equal(hit(create('.github/workflows/ci.yml'), NONE), true)
    assert.equal(hit(create('.circleci/config.yml'), NONE), true)
    // 改名で入ったファイルは Windows では modify で届く。
    assert.equal(hit(modify('.github/workflows/ci.yml'), NONE), true)
    assert.equal(hit(remove('.github/workflows/ci.yml'), NONE), false)
    for (const change of [create, modify, remove].map((f) => f('.github/workflows/ci.yml'))) {
      assert.equal(hit(change, BOTH), false, change.kind)
    }
  })

  test('覚えている答えは CI ごとに見る', () => {
    const githubOnly = { github: true, circleci: false }
    assert.equal(hit(create('.github/workflows/ci.yml'), githubOnly), false)
    assert.equal(hit(create('.circleci/config.yml'), githubOnly), true)
  })

  test('関係のない変更は拾わない', () => {
    const changes = [
      create('src/main.ts'),
      create('.github/dependabot.yml'),
      create('.github/ISSUE_TEMPLATE/bug.md'),
      create('.githubx'),
      create('.circleci-old/config.yml'),
      create('docs/.github/workflows/ci.yml'),
    ]
    assert.equal(ciConfigsMayHaveChanged(ROOT, changes, NONE, 'wsl'), false)
    // root の外（名前が前方一致するだけの隣のディレクトリ）と、root 自身。
    assert.equal(hit({ path: `${ROOT}-2/.circleci`, kind: 'create' }), false)
    assert.equal(hit({ path: ROOT, kind: 'modify' }), false)
  })

  test('Windows では区切りと大小の違いを吸収する', () => {
    const change = { path: 'C:\\src\\repo\\.github\\workflows', kind: 'create' as const }
    assert.equal(ciConfigsMayHaveChanged('C:\\src\\repo', [change], NONE, 'windows'), true)
    assert.equal(ciConfigsMayHaveChanged('C:/src/Repo/', [change], NONE, 'windows'), true)
    const cased = { path: 'C:\\src\\repo\\.GitHub\\Workflows\\ci.yml', kind: 'create' as const }
    assert.equal(ciConfigsMayHaveChanged('C:\\src\\repo', [cased], NONE, 'windows'), true)
    // WSL は大小を区別する（`[ -d .github/workflows ]` が見るのは小文字の綴りだけ）。
    assert.equal(hit(create('.GitHub/workflows')), false)
  })

  test('ドライブ直下や / が root でも当たる', () => {
    assert.equal(ciConfigsMayHaveChanged('C:\\', [{ path: 'C:\\.circleci', kind: 'create' }], NONE, 'windows'), true)
    assert.equal(ciConfigsMayHaveChanged('/', [{ path: '/.github', kind: 'create' }], NONE, 'unix'), true)
  })
})
