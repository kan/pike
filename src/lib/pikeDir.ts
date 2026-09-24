import type { ShellType } from '../types/tab'
import { pathSep } from './paths'
import { fsCreateDir, fsReadFile, fsWriteFile } from './tauri'

/**
 * `<root>/.pike/<sub>` を作り、`.pike/.gitignore` を 1 度だけ置く。
 *
 * **`.pike` の下に何かを置く側はここを通すこと。** あそこは Pike の作業置き場なので、
 * 作った人が `.gitignore` も置かないとユーザーのリポジトリに `uploads/` が現れる。
 * 呼び出し元はアップロード（`useImagePaste`）と Vue SFC のプレビューの入口（`VuePreview.vue`、
 * #397）。同じ手順を呼び出し側ごとに書き写させないための入口。
 *
 * `.gitignore` は**無いときだけ**書く（手で編集したものを上書きしない）。作成の失敗は
 * 握り潰す: 呼び出し側はこの直後に本命のファイルを読み書きするので、本当に作れなければ
 * そちらが失敗する。
 */
const gitignoreEnsured = new Set<string>()

export async function ensurePikeDir(shell: ShellType, root: string, sub: string): Promise<string> {
  const sep = pathSep(shell)
  const pikeDir = `${root}${sep}.pike`
  const dir = `${pikeDir}${sep}${sub}`
  await fsCreateDir(shell, dir).catch(() => {})
  if (!gitignoreEnsured.has(pikeDir)) {
    gitignoreEnsured.add(pikeDir)
    const giPath = `${pikeDir}${sep}.gitignore`
    fsReadFile(shell, giPath).catch(() => fsWriteFile(shell, giPath, '*\n').catch(() => {}))
  }
  return dir
}
