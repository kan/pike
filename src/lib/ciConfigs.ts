import type { CiConfigs, CiProvider } from '../types/ci'
import { isPosixPlatform, type ProjectPlatform, relativeToBase } from './projectPaths'

/** 監視から届く変更 1 件（`useFsWatcher.ts` の `FsChangeEntry` と同じ形。ディレクトリも来る）。 */
interface Change {
  path: string
  kind: 'create' | 'modify' | 'delete'
}

/** CI の設定のディレクトリ（root からの相対。Rust の `ci_configs` が見るものと揃える）。 */
const CONFIG_DIRS: Record<CiProvider, string> = { github: '.github/workflows', circleci: '.circleci' }

/**
 * 監視が知らせた変更で、覚えている CI の設定の有無（`known`）が古くなりうるか。
 *
 * 設定の有無はウィンドウの寿命のあいだ覚えるので、聞き直す契機が無いと、開いたあとに
 * ワークフローを足したリポジトリで CI のアイコンが出ないままになる（更新ボタンはパネルの
 * 中にあり、アイコンが無いと届かない）。
 *
 * **聞き直しは WSL では `wsl.exe` の起動 1 回**なので、答えが変わりえない変更はなるべく落とす:
 *
 * - **設定のディレクトリそのものと、その親（`.github`）は、種別を問わず拾う。** 改名で
 *   入れたディレクトリは Windows では `modify` で届き、再帰で作ったときは親の `create` しか
 *   届かないことがある（`inotifywait -r` は、新しいディレクトリに監視を張る前の中身を落とす）。
 *   **Windows は中身が増減しただけでも親の `modify` を出す**ので、そこでは保存のたびに真に
 *   なる。見分けは付かないので、聞き直す側が答えの変わらなかった回を安く済ませる
 * - **中のファイルは、無いと覚えているときの作成と変更だけ拾う。** 上の取りこぼしのあとでも、
 *   ワークフローを 1 本書いた時点で追い付く（改名で入ったファイルは Windows では `modify`）。
 *   在ると覚えているあいだは、中身が増えても減ってもディレクトリの有無は変わらない
 *   （消えるときはディレクトリ自身の知らせが来る）
 *
 * root との突き合わせは `relativeToBase` に任せる（区切りの正規化、ドライブ直下の root、
 * Windows での大小無視）。相対パスの側も Windows では大小を無視する（Rust の `is_dir` が
 * そう答えるため）。
 */
export function ciConfigsMayHaveChanged(
  root: string,
  changes: readonly Change[],
  known: CiConfigs,
  platform: ProjectPlatform,
): boolean {
  const providers = Object.keys(CONFIG_DIRS) as CiProvider[]
  return changes.some(({ path, kind }) => {
    const below = relativeToBase(root, path, platform)
    if (below === null) return false
    const rel = isPosixPlatform(platform) ? below : below.toLowerCase()
    return providers.some((p) => {
      const dir = CONFIG_DIRS[p]
      if (rel === dir || dir.startsWith(`${rel}/`)) return true
      return kind !== 'delete' && !known[p] && rel.startsWith(`${dir}/`)
    })
  })
}
