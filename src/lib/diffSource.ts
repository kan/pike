/**
 * diff タブの左右が「どの版のファイルか」（#524）。省略行の展開（#285、`DiffTab.vue` の
 * `loadNewSide`）とプレビュー比較（`DiffPreview.vue`）が同じ規則で取り寄せる。
 *
 * **規則は出どころで決まる。** 作業ツリーの差分は index → 作業ツリー、ステージ済みは
 * HEAD → index、コミットは親（`<hash>^`）→ そのコミット。**基準はタブの root**（#321。
 * `activeRoot` を引き直さない）。
 */
import type { DiffTab, ShellType } from '../types/tab'
import { parseFileHeader, parseRename } from './diffParser'
import { mimeType, repoPath } from './paths'
import { fsReadFile, fsReadFileBase64, gitShowFile, gitShowFileBase64 } from './tauri'

/**
 * 取り寄せ先。`rev` が null なら作業ツリーのファイル、`''` は index（`git show :<path>`）。
 * `blob` は差分のヘッダにある中身のハッシュで、同じなら中身も同じ（取り直さなくてよい）。
 */
export type DiffSource = { rev: string | null; path: string; blob: string | null }

/** 変更後の側。省略行の展開は、ファイルが消えた差分でもここを読みに行く（読めなければ失敗を出す）。 */
export function newSideSource(tab: DiffTab, blob: string | null = null): DiffSource {
  if (tab.commitHash) return { rev: tab.commitHash, path: tab.filePath, blob }
  if (tab.staged) return { rev: '', path: tab.filePath, blob }
  return { rev: null, path: tab.filePath, blob }
}

/**
 * 左右の取り寄せ先。null の側は「その時点にファイルが無い」（新規の左・削除の右）。
 *
 * **無い側は差分のヘッダで決める。** 取りに行って失敗したから無い、とすると、読めなかった
 * だけのファイルを「追加された」と言うことになる。**変更前は元の名前で引く**（リネームの
 * ヘッダ、無ければ `origPath`。コミットの差分は `origPath` を持たない）。
 */
export function diffSides(tab: DiffTab): [DiffSource | null, DiffSource | null] {
  const header = parseFileHeader(tab.diff)
  const oldPath = parseRename(tab.diff)?.from ?? tab.origPath ?? tab.filePath
  const before: DiffSource = tab.commitHash
    ? { rev: `${tab.commitHash}^`, path: oldPath, blob: header.oldBlob }
    : tab.staged
      ? { rev: 'HEAD', path: oldPath, blob: header.oldBlob }
      : // 作業ツリーの差分は index との比較。index は新しい名前で持っている。
        { rev: '', path: tab.filePath, blob: header.oldBlob }
  const added = tab.untracked || header.added
  return [added ? null : before, header.deleted ? null : newSideSource(tab, header.newBlob)]
}

/**
 * 取り寄せる。`dataUrl` なら画像として `data:` URL で返す（`git show` の文字列化はバイナリを
 * 壊すので、base64 の口を使う）。
 */
export async function readDiffSource(
  root: string,
  shell: ShellType,
  src: DiffSource,
  as: 'text' | 'dataUrl',
): Promise<string> {
  if (as === 'text') {
    if (src.rev !== null) return gitShowFile(root, shell, src.rev, src.path)
    return (await fsReadFile(shell, worktreePath(root, src.path, shell))).content
  }
  const b64 =
    src.rev !== null
      ? await gitShowFileBase64(root, shell, src.rev, src.path)
      : await fsReadFileBase64(shell, worktreePath(root, src.path, shell))
  return `data:${mimeType(src.path)};base64,${b64}`
}

function worktreePath(root: string, rel: string, shell: ShellType): string {
  const path = repoPath(root, rel, shell)
  if (!path) throw new Error('no root')
  return path
}
