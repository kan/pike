/**
 * コミット全体の差分（`git diff <親> <コミット>`）をファイルごとに分けて、統合形式の行に
 * 落とす（コミットタブ、#374）。
 *
 * **`diffParser.ts` の `parseDiff` を使わない理由**: あちらは 1 ファイルぶんの差分を左右の
 * 欄に割る（diff タブの形）。コミットタブは複数のファイルを縦に並べて読む場所なので、
 * 行を割らない統合形式のほうが一覧性が高く、行ごとの文字単位の強調も要らない。
 */

import { HUNK_HEADER_RE } from './diffParser'

export type PatchLineType = 'hunk' | 'add' | 'del' | 'ctx' | 'note'

export interface PatchLine {
  type: PatchLineType
  /** 古い側の行番号（追加行と hunk 行には無い）。 */
  oldNum: number | null
  /** 新しい側の行番号（削除行と hunk 行には無い）。 */
  newNum: number | null
  text: string
}

export interface PatchFile {
  /** 新しい側のパス（削除なら古い側）。リポジトリのルートからの相対。 */
  path: string
  /** リネーム・コピーの元のパス。 */
  oldPath: string | null
  /** `A` / `D` / `R` / `C` / `M`（Git パネルの表示と同じ文字）。 */
  status: 'A' | 'D' | 'R' | 'C' | 'M'
  binary: boolean
  added: number
  removed: number
  lines: PatchLine[]
}

/** `a/` / `b/` を外す。`/dev/null` は `null`。 */
function stripSide(p: string): string | null {
  const v = p.replace(/\t.*$/, '')
  if (v === '/dev/null') return null
  return v.replace(/^[ab]\//, '')
}

/**
 * `diff --git a/x b/y` の見出しからパスを取る（`+++` / `---` を持たない差分のため。
 * バイナリやモードだけの変更）。パスに空白を含むと区切りが曖昧になるので、両側が同じ
 * パスである（リネームでない）ときの対称性で割る。リネームは `rename to` が先に拾う。
 */
function pathFromHeader(header: string): string {
  const rest = header.slice('diff --git '.length)
  const half = (rest.length - 1) / 2
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = rest.slice(0, half)
    const b = rest.slice(half + 1)
    if (a.slice(2) === b.slice(2)) return b.slice(2)
  }
  const i = rest.lastIndexOf(' b/')
  return i === -1 ? rest : rest.slice(i + 3)
}

export function parsePatch(raw: string): PatchFile[] {
  const files: PatchFile[] = []
  let file: PatchFile | null = null
  let oldNum = 0
  let newNum = 0
  let inHunks = false

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: pathFromHeader(line), oldPath: null, status: 'M', binary: false, added: 0, removed: 0, lines: [] }
      files.push(file)
      inHunks = false
      continue
    }
    if (!file) continue

    if (!inHunks) {
      if (line.startsWith('new file mode')) file.status = 'A'
      else if (line.startsWith('deleted file mode')) file.status = 'D'
      else if (line.startsWith('rename from ')) {
        file.status = 'R'
        file.oldPath = line.slice('rename from '.length)
      } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length)
      else if (line.startsWith('copy from ')) {
        file.status = 'C'
        file.oldPath = line.slice('copy from '.length)
      } else if (line.startsWith('copy to ')) file.path = line.slice('copy to '.length)
      else if (line.startsWith('Binary files ')) file.binary = true
      else if (line.startsWith('--- ')) {
        const p = stripSide(line.slice(4))
        if (p && file.status === 'D') file.path = p
      } else if (line.startsWith('+++ ')) {
        const p = stripSide(line.slice(4))
        if (p) file.path = p
      }
    }

    const hunk = line.startsWith('@@') ? HUNK_HEADER_RE.exec(line) : null
    if (hunk) {
      inHunks = true
      oldNum = Number(hunk[1])
      newNum = Number(hunk[3])
      file.lines.push({ type: 'hunk', oldNum: null, newNum: null, text: line })
      continue
    }
    if (!inHunks) continue

    // `\ No newline at end of file` は直前の行への注釈。行番号は進めない。
    if (line.startsWith('\\')) file.lines.push({ type: 'note', oldNum: null, newNum: null, text: line })
    else if (line.startsWith('+')) {
      file.lines.push({ type: 'add', oldNum: null, newNum: newNum++, text: line.slice(1) })
      file.added++
    } else if (line.startsWith('-')) {
      file.lines.push({ type: 'del', oldNum: oldNum++, newNum: null, text: line.slice(1) })
      file.removed++
    } else if (line.startsWith(' ')) {
      file.lines.push({ type: 'ctx', oldNum: oldNum++, newNum: newNum++, text: line.slice(1) })
    }
    // 空行（末尾の改行が作るもの）は捨てる。context 行は必ず先頭に空白を持つ。
  }
  return files
}
