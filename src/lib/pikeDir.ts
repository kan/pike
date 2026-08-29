import type { ShellType } from '../types/tab'
import { pathSep } from './paths'
import { fsCreateDir, fsReadFile, fsWriteFile } from './tauri'

/**
 * `<root>/.pike`（`sub` を渡せばその子）を作り、`.pike/.gitignore` を 1 度だけ置く。
 *
 * **`.pike` を作る側はここを通すこと。** あそこは Pike の作業置き場なので、作った人が
 * `.gitignore` も置かないとユーザーのリポジトリに `uploads/` や `todo.md` が現れる。
 * アップロード（`useImagePaste`）と TODO（`stores/todo`）が別々に同じ手順を持っていて、
 * worktree 対応（#269）で「1 度だけ」の記憶をどちらもディレクトリ単位に変えたときに、
 * 完全に同じ実装が 2 つ並んだ。
 *
 * `.gitignore` は**無いときだけ**書く（手で編集したものを上書きしない）。作成の失敗は
 * 握り潰す: 呼び出し側はこの直後に本命のファイルを読み書きするので、本当に作れなければ
 * そちらが失敗する。
 */
const gitignoreEnsured = new Set<string>()

export async function ensurePikeDir(shell: ShellType, root: string, sub?: string): Promise<string> {
  const sep = pathSep(shell)
  const pikeDir = `${root}${sep}.pike`
  const dir = sub ? `${pikeDir}${sep}${sub}` : pikeDir
  await fsCreateDir(shell, dir).catch(() => {})
  if (!gitignoreEnsured.has(pikeDir)) {
    gitignoreEnsured.add(pikeDir)
    const giPath = `${pikeDir}${sep}.gitignore`
    fsReadFile(shell, giPath).catch(() => fsWriteFile(shell, giPath, '*\n').catch(() => {}))
  }
  return dir
}
