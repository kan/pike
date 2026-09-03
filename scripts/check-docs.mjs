#!/usr/bin/env node
// ドキュメントと実装の機械的な整合チェック（node scripts/check-docs.mjs / npm run check:docs）。
//
// 「文章として正しいか」は見ない。人間が見落とす類の乖離だけを対象にする:
//   1. src/ と src-tauri/src/ のファイルが CLAUDE.md のディレクトリ構成に載っているか
//   2. CLAUDE.md と .claude/rules/ が挙げるファイルパスが実在するか（削除・改名の取り残し）
//   3. CLAUDE.md と .claude/rules/ が挙げるシンボル名が実在するか（関数の改名・削除の取り残し）
//   4. README とマニュアルが参照する画像が実在するか / 使われていない画像が残っていないか
//   5. md 間のリンクとページ内アンカーが解決するか（Pike のプレビューと同じ slug 規則）
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

// Markdown inside code is notation being documented, not markup to follow, so
// fenced blocks come out before any scan below.
const stripFences = (body) => body.replace(/```[\s\S]*?```/g, '')

// --- 3. 開発ノートが挙げるシンボル名が実在するか --------------------------------
// 2 がファイルパスしか見ないので、**関数の改名・削除はここまで素通りしていた**（棚卸しで
// 一度に 9 件見つかった: `build_git_command` / `find_project_window` / `AppState` など）。
// バッククォート 1 つで囲まれた識別子だけを対象にする。`` `Mod+Shift+P` `` や
// `` `git status` `` のように識別子以外の文字を含むものは、正規表現の時点で当たらない。
//
// **対象は開発ノート（CLAUDE.md と .claude/rules）だけ。** README とマニュアルは
// 読み手が利用者で、`getUser` のような**架空の例**が普通に出てくる（実際に誤検出した）。
// 実装を指しているつもりの名前が並ぶのは開発ノートのほうで、9 件の取り残しも全部そこにあった。

// **コーパスは追跡ファイルだけ**（`git ls-files`）。ディレクトリを歩くと、生成物や手元の
// 作業ファイルまで名前の出典になり、**手元では通って CI で落ちる**。実際に踏んだ:
// `src-tauri/gen/schemas/*.json`（tauri が生成、gitignore 済み）が `restore_state` を
// 実在扱いにしていて、ビルド前に走る CI のクリーンチェックアウトでだけ検出された。
// ドキュメントが説明するのはコミットされたコードなので、範囲としてもこちらが正しい。
//
// **check-docs.mjs 自身も外す。** 下の許可リストと「9 件見つかった」の例が消えた名前を
// 並べているので、入れるとまさに検出したい名前を自分で実在扱いにする（これも実際に踏んだ）。
const CORPUS_SKIP_FILES = new Set(['package-lock.json', 'Cargo.lock', 'check-docs.mjs'])
const CORPUS_SKIP_EXT = /\.(md|png|jpg|svg|ico|icns|log)$/i

/**
 * 他所の名前。**Pike のコードに無いのが正しい**ので、実在チェックから外す。
 * ブラウザ / xterm / CodeMirror / tauri / serde / Win32 / git / Apple のもの。
 */
const EXTERNAL_NAMES = [
  'DisabledCspModificationKind', // tauri の config の型
  'MERGE_MSG', // git が書く状態ファイル（Pike は読まない）
  'ReadDirectoryChangesW', // Win32（notify クレート経由）
  'SetWindowCompositionAttribute', // Win32（window-vibrancy 経由）
  'WORK', // 同期ファイルの例に出てくるグループ名
  '__VERSION__', // tauri-action がタグ名に埋めるプレースホルダ
  '_keyDown', // xterm 内部
  'addKeymap', // @codemirror/lang-markdown のオプション
  'brotliDecompressSync', // node の zlib
  'defaultPrevented', // DOM
  'deny_unknown_fields', // serde の属性
  'evaluateKeyboardEvent', // xterm 内部
  'ld_prime', // Xcode 15 の新リンカ
  'offsetLeft', // DOM
  'offsetParent', // DOM
  'replace_csp_nonce', // tauri 内部
  'restore_state', // tauri-plugin-window-state
  'runHandlers', // CodeMirror 内部
  'set_csp', // tauri 内部（manager::set_csp）
  // このスクリプト自身の識別子。自分をコーパスから外している以上、外の名前と同じ扱いになる。
  'EXTERNAL_NAMES',
  'GONE_NAMES',
]

/**
 * **無いことを説明するために出てくる名前。** 「旧 X は廃止」「X という変数は存在しない」の
 * 類で、実在しないほうが正しい。消えた経緯ごと記録してあるので、この一覧から外すときは
 * 本文のほうも見直すこと。
 */
const GONE_NAMES = [
  'AppState', // 1 つにまとめていない、と rust.md が書くための名前
  'build_git_command', // このチェックが無かったころの取り残しの例（CLAUDE.md）
  'CLAUDE_CONFIG_PATH', // issue の表題にあるが実在しない変数（agent.md）
  'getWindowProjectId', // #175 で廃止
  'inlineSmallTextFiles', // #275 で削除
  'tryInlineFile', // #275 で削除
  'window_project_id', // #175 で廃止
]

const allowedNames = new Set([...EXTERNAL_NAMES, ...GONE_NAMES])

// 実装だけでなく設定・ワークフロー・スクリプトも読む。`APPLE_API_KEY` や
// `FriendlyAppName` のように、ドキュメントが挙げる名前の出典がそちらにあるものが多い。
const corpusNames = new Set()
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
for (const file of tracked) {
  if (CORPUS_SKIP_EXT.test(file) || CORPUS_SKIP_FILES.has(file.slice(file.lastIndexOf('/') + 1))) continue
  // index にあってワークツリーに無いファイル（削除の途中）は読み飛ばす。
  let body
  try {
    body = read(file)
  } catch {
    continue
  }
  for (const token of body.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) corpusNames.add(token)
}

// 1 語の小文字（`auto` / `editable` のような値リテラルや英単語）は散文と見分けが付かないので
// 対象外。`_` を含む・camelCase の段差がある・全部大文字、のどれかだけを名前とみなす。
const looksLikeSymbol = (name) => name.includes('_') || /[a-z][A-Z]/.test(name) || /^[A-Z0-9]+$/.test(name)

for (const file of noteFiles) {
  const body = stripFences(file === 'CLAUDE.md' ? claudeMd : read(file))
  const seen = new Set()
  for (const m of body.matchAll(/`([A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)*)(?:\(\))?`/g)) {
    // `types::os_open` や `EditorView.editable` は末尾の 1 語で照合する（手前は
    // モジュール名や型名で、コードの側では別の綴りになっていることがある）。
    const name = m[1].split(/::|\./).pop()
    if (name.length < 4 || seen.has(name)) continue
    if (allowedNames.has(name) || !looksLikeSymbol(name) || corpusNames.has(name)) continue
    seen.add(name)
    fail(`${file} が実在しないシンボルを参照: ${name}`)
  }
}

// --- 4. 画像の参照 -------------------------------------------------------------
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
for (const img of walk('docs/manual/img')) {
  if (img.endsWith('.png') && !referenced.has(img)) fail(`どのドキュメントからも参照されていない画像: ${img}`)
}
// 画像は README のヒーローを含めて docs/manual/img/ に集約する（#279）。置き場が 2 つあると、
// 上の未参照チェックが片方だけを見ている状態に戻る。
for (const stray of readdirSync(join(root, 'docs')).filter((e) => e.endsWith('.png'))) {
  fail(`画像は docs/manual/img/ に置く: docs/${stray}`)
}

// --- 5. リンクとアンカー -------------------------------------------------------
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

// A heading keeps its inline spans: dropping them would change its slug, since
// `## \`foo\` の使い方` anchors on the word `foo`. A link (`[text](url)`) can be
// spelled inline, so that scan drops them.
const stripCode = (body) => stripFences(body).replace(/`[^`\n]*`/g, '')

const anchors = new Map(
  docFiles.map((f) => [f, new Set([...stripFences(docBodies.get(f)).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1])))]),
)

for (const [file, body] of docBodies) {
  for (const m of stripCode(body).matchAll(/\]\(([^)\s]+)\)/g)) {
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
  console.error(
    '\nCLAUDE.md の構成・参照パス、マニュアルの画像とリンクを直してください。\n' +
      '「実在しないシンボル」は、改名したなら本文を直す。他所の API なら EXTERNAL_NAMES、\n' +
      '無いことを説明するために出しているなら GONE_NAMES へ（どちらもこのスクリプトの中）。',
  )
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
