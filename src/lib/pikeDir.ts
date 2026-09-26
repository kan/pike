import type { ShellType } from '../types/tab'
import { pathSep } from './paths'
import { fsCreateDir, fsReadFile, fsWriteFile } from './tauri'

/**
 * `<root>/.pike/<sub>` を作り、`.pike/.gitignore` を 1 度だけ置く。
 *
 * **`.pike` の下に何かを置く側はここを通すこと。** あそこは Pike の作業置き場なので、
 * 作った人が `.gitignore` も置かないとユーザーのリポジトリに `uploads/` が現れる。
 * 呼び出し元はアップロード（`useImagePaste`）と Vue のプレビューの入れた値
 * （`VuePreview.vue` の `preview/`）で、同じ手順を書き写させないための入口として独立させてある。
 *
 * `.gitignore` は**無いときだけ**書く（手で編集したものを上書きしない）。作成の失敗は
 * 握り潰す: 呼び出し側はこの直後に本命のファイルを読み書きするので、本当に作れなければ
 * そちらが失敗する。
 */
const gitignoreEnsured = new Set<string>()

/** `<root>/.pike`。 */
function pikeRoot(shell: ShellType, root: string): string {
  return `${root}${pathSep(shell)}.pike`
}

/** `<root>/.pike/<sub>` のパスだけを返す（作らない）。読むだけの側と `ensurePikeDir` が共有する。 */
export function pikeDirPath(shell: ShellType, root: string, sub: string): string {
  return `${pikeRoot(shell, root)}${pathSep(shell)}${sub}`
}

export async function ensurePikeDir(shell: ShellType, root: string, sub: string): Promise<string> {
  const pikeDir = pikeRoot(shell, root)
  const dir = pikeDirPath(shell, root, sub)
  await fsCreateDir(shell, dir).catch(() => {})
  if (!gitignoreEnsured.has(pikeDir)) {
    gitignoreEnsured.add(pikeDir)
    const giPath = `${pikeDir}${pathSep(shell)}.gitignore`
    fsReadFile(shell, giPath).catch(() => fsWriteFile(shell, giPath, '*\n').catch(() => {}))
  }
  return dir
}
