/**
 * worktree の作成（#478）のうち、IPC を挟まない部分: 置き場所の解決と、持っていくファイルの
 * パターンの読み取り。作成の段取りは `stores/worktree.ts` の `createWorktree`、git の操作は
 * Rust の `git/worktree.rs`。
 *
 * **置き場所の設定は 1 つの文字列**（Windows 用と WSL / macOS 用で 2 つ持つ。設定は
 * `stores/settings.ts` の `worktreeLocation`）。絶対パスなら固定の場所、相対パスなら repo の
 * ルートからの相対として読む。`~` で始まればホームからで、展開は Rust が行う（WSL の `$HOME`
 * は distro に聞かないと分からない）。`${repoName}` は repo のディレクトリ名に置き換える:
 * 固定の場所を複数の repo で共有すると、同じ名前の worktree がぶつかるため。
 */
import type { ShellType } from '../types/tab'
import { basename, isAbsolutePath, joinPath, pathSep, stripTrailingSep } from './paths'

/** repo のディレクトリ名に置き換える印。 */
export const REPO_NAME_PLACEHOLDER = '${repoName}'

/** 既定の置き場所。VS Code と同じく repo の隣の `<repo 名>.worktrees`。 */
export const DEFAULT_WORKTREE_LOCATION = `../${REPO_NAME_PLACEHOLDER}.worktrees`

/**
 * worktree のディレクトリ名。**ブランチ名の `/` を `-` に置き換える**（VS Code と同じ）。
 * `feature/foo` をそのまま使うと、置き場所の下に `feature` のディレクトリが挟まる。
 */
export function worktreeDirName(name: string): string {
  return name.replace(/\//g, '-')
}

/**
 * 新しい worktree のパス。`root` は main の worktree のルート、`location` は設定の値
 * （空なら既定）。区切りはプロジェクトのシェルのもので、`..` は畳む。
 */
export function resolveWorktreePath(location: string, root: string, name: string, shell: ShellType): string {
  const sep = pathSep(shell)
  const base = stripTrailingSep(root)
  const template = (location.trim() || DEFAULT_WORKTREE_LOCATION).replaceAll(REPO_NAME_PLACEHOLDER, basename(base))
  const dir = template.startsWith('~') || isAbsolutePath(template) ? template : joinPath(base, template, sep)
  return joinPath(dir, worktreeDirName(name), sep)
}

/**
 * パターンの並びを git へ渡せる形にする。**`.gitignore` のファイルと同じ読み方**に寄せる:
 * 空行と `#` で始まる行は捨て、末尾の空白はエスケープされていなければ落とす。
 * 文字列でないものと改行を含むものは捨てる（VS Code も改行を含むものは捨てる）。
 */
function normalizePatterns(raws: unknown[]): string[] {
  return raws.flatMap((raw) => {
    if (typeof raw !== 'string' || /[\r\n]/.test(raw)) return []
    const pattern = raw.replace(/(?<!\\)\s+$/, '')
    return pattern === '' || pattern.startsWith('#') ? [] : [pattern]
  })
}

/**
 * `.vscode/settings.json`（JSONC を読んだ値）の `git.worktreeIncludeFiles`。VS Code の設定で、
 * 値は `.gitignore` 構文のパターンの配列。無い・形が違うときは空。
 */
export function includeFromVscodeSettings(settings: unknown): string[] {
  if (!settings || typeof settings !== 'object') return []
  const value = (settings as Record<string, unknown>)['git.worktreeIncludeFiles']
  return Array.isArray(value) ? normalizePatterns(value) : []
}

/** repo のルートの `.worktreeinclude`（Claude Code・Conductor が読むもの。`.gitignore` 構文）。 */
export function includeFromWorktreeInclude(text: string): string[] {
  return normalizePatterns(text.split(/\r?\n/))
}
