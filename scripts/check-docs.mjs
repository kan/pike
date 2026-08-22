#!/usr/bin/env node
// ドキュメントと実装の機械的な整合チェック（node scripts/check-docs.mjs / npm run check:docs）。
//
// 「文章として正しいか」は見ない。人間が見落とす類の乖離だけを対象にする:
//   1. src/ と src-tauri/src/ のファイルが CLAUDE.md のディレクトリ構成に載っているか
//   2. CLAUDE.md と .claude/rules/ が挙げるファイルパスが実在するか（削除・改名の取り残し）
//   3. README とマニュアルが参照する画像が実在するか / 使われていない画像が残っていないか
//   4. md 間のリンクとページ内アンカーが解決するか（Pike のプレビューと同じ slug 規則）
//
// 実装を変えたらこれが落ちる、という関係にしておくのが目的なので、判断の要る
// 「機能の説明が実装と合っているか」は CLAUDE.md「コミット前チェック」の手順側に置く。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const problems = []
const fail = (msg) => problems.push(msg)

/** ディレクトリ単位でまとめて説明してよい場所（個別ファイル名は載せない）。 */
const COLLECTIVE_DIRS = [
  'src/lib/outline/extractors',
  'src/lib/outline',
  'src/lib/jumpTo',
  'src/i18n',
  'src-tauri/src/codex/protocol',
  'src-tauri/src/bin',
]

/** 構成に載せる必要のないもの（型宣言のみのファイル）。 */
const skipFile = (path) => path.endsWith('.d.ts')

function walk(dir, out = []) {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out)
    else out.push(rel)
  }
  return out
}

// --- 1. CLAUDE.md のディレクトリ構成に載っているか -----------------------------
const claudeMd = read('CLAUDE.md')

function treeKey(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  // mod.rs はどのモジュールにもあるので、親ディレクトリ名で照合する。
  if (name === 'mod.rs') return dirname(path).slice(dirname(path).lastIndexOf('/') + 1)
  return name
}

const sources = [...walk('src'), ...walk('src-tauri/src')].filter(
  (p) => /\.(rs|ts|vue)$/.test(p) && !skipFile(p) && !COLLECTIVE_DIRS.includes(dirname(p)),
)
for (const path of sources) {
  if (!claudeMd.includes(treeKey(path))) fail(`CLAUDE.md の構成に未記載: ${path}`)
}
for (const dir of COLLECTIVE_DIRS) {
  const name = dir.slice(dir.lastIndexOf('/') + 1)
  if (!claudeMd.includes(`${name}/`)) fail(`CLAUDE.md の構成に未記載（ディレクトリ単位）: ${dir}/`)
}

// --- 2. CLAUDE.md と .claude/rules/ が挙げるパスが実在するか --------------------
// Rust は src-tauri/src 配下、フロントは src 配下の .ts/.vue だけを Pike 自身の
// パスとみなす。`src/main.rs` のような他プロジェクトの慣例を指す言及（cargo の
// タスク検出の説明など）を実在チェックに巻き込まないため。
const ownPathPatterns = [/src-tauri\/src\/[\w./-]+\.rs/g, /\bsrc\/[\w./-]+\.(?:ts|vue)/g]
const noteFiles = ['CLAUDE.md', ...walk('.claude/rules').filter((p) => p.endsWith('.md'))]
for (const file of noteFiles) {
  const body = file === 'CLAUDE.md' ? claudeMd : read(file)
  for (const pattern of ownPathPatterns) {
    for (const m of body.matchAll(pattern)) {
      if (!existsSync(join(root, m[0]))) fail(`${file} が実在しないパスを参照: ${m[0]}`)
    }
  }
}

// --- 3. 画像の参照 -------------------------------------------------------------
const docFiles = ['README.md', ...walk('docs/manual').filter((p) => p.endsWith('.md'))]
const docBodies = new Map(docFiles.map((f) => [f, read(f)]))
const referenced = new Set()

for (const [file, body] of docBodies) {
  for (const m of body.matchAll(/(?:src|srcset)="([^"]+\.png)"/g)) {
    const target = resolve(join(root, dirname(file)), m[1])
    if (!existsSync(target)) fail(`${file}: 参照先の画像が無い -> ${m[1]}`)
    else referenced.add(relative(root, target).replaceAll('\\', '/'))
  }
}
for (const img of [...walk('docs/manual/img'), ...walk('docs').filter((p) => !p.includes('/'))]) {
  if (img.endsWith('.png') && !referenced.has(img)) fail(`どのドキュメントからも参照されていない画像: ${img}`)
}

// --- 4. リンクとアンカー -------------------------------------------------------
// src/lib/slug.ts と同一規則。あちらを変えたらここも変える必要があるので、
// 期待する 2 つの置換が残っているかを確かめてから使う。
const slugTs = read('src/lib/slug.ts')
for (const expected of [String.raw`[^\p{L}\p{N}_\s-]`, String.raw`replace(/\s/g, '-')`]) {
  if (!slugTs.includes(expected)) {
    fail(`slug.ts の規則が変わっている（このスクリプトの slug() も合わせて更新する）: ${expected} が見つからない`)
  }
}
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-')

const anchors = new Map(
  docFiles.map((f) => [f, new Set([...docBodies.get(f).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1])))]),
)
for (const [file, body] of docBodies) {
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = m[1]
    if (/^(https?:|mailto:)/.test(link) || link.endsWith('.png')) continue
    const [path, frag] = link.split('#')
    let target = file
    if (path) {
      const abs = resolve(join(root, dirname(file)), path)
      if (!existsSync(abs)) {
        fail(`${file}: リンク先が無い -> ${link}`)
        continue
      }
      target = relative(root, abs).replaceAll('\\', '/')
    }
    if (frag && anchors.has(target) && !anchors.get(target).has(slug(frag))) {
      fail(`${file}: アンカーが無い -> ${link}`)
    }
  }
}

// --- 結果 ---------------------------------------------------------------------
if (problems.length > 0) {
  console.error(`ドキュメント整合チェック: ${problems.length} 件\n`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\nCLAUDE.md の構成・参照パス、マニュアルの画像とリンクを直してください。')
  process.exit(1)
}

// 実装差分に対する注意喚起（判断が必要なので落とさない）。
try {
  const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  const touchedCode = changed.some((f) => f.startsWith('src/') || f.startsWith('src-tauri/src/'))
  const touchedDocs = changed.some((f) => f === 'README.md' || f.startsWith('docs/manual/'))
  if (touchedCode && !touchedDocs) {
    console.log('ドキュメント整合チェック: 問題なし')
    console.log(
      'ヒント: 実装のみの変更です。ユーザーに見える挙動（UI / 設定 / ショートカット / CLI）を変えたなら、\n' +
        '        マニュアルの該当ページと README の機能一覧も確認してください。',
    )
    process.exit(0)
  }
} catch {
  // git が使えない環境ではヒントを出さないだけ
}
console.log('ドキュメント整合チェック: 問題なし')
