import { basename } from './paths'

/**
 * ファイル名（と任意で 1 行目）→ **種別のキー**（#347 / #348）。
 *
 * **Pike が「このファイルは何か」を決める唯一の場所。** 以前は同じ知識が 4 系統に分かれて
 * いて、片方だけ直すと食い違った（`Dockerfile.dev` はアイコンとアウトラインでは Dockerfile
 * なのに、エディタだけ Plain Text だった）。読む側は次の 4 つ:
 *
 * | 用途 | 読む場所 |
 * |---|---|
 * | ハイライトと StatusBar の種別 | `lib/languages.ts` |
 * | アウトラインの抽出器の振り分け | `lib/outline/index.ts` |
 * | 定義ジャンプ（`vue` / `go` の分岐） | `lib/jumpTo/` |
 * | ファイルアイコンの補い | `lib/fileIcons.ts` |
 *
 * **CodeMirror を import しない。** アイコンやアウトラインから、種別を知りたいだけのために
 * 言語モードの束を読み込ませないため（`languages.ts` はこの表を読み、キー → モードの対応
 * だけを持つ）。
 */

/**
 * 種別のキー → StatusBar の表記。**この表がキーの正本**（#347）。
 *
 * ラベルをここに置いてあるので、`languages.ts` の `EXT_MAP` は
 * `Partial<Record<FileTypeKey, …>>` として型で縛れる。**モードだけ足してラベルを忘れると
 * コンパイルエラーになる**ので、「色は付くのに Plain Text」（#312 で直した食い違い）が
 * 型の届かないところに戻らない。
 *
 * ラベルがモードと違う名前になるのは構わない。`conf` → Nginx、`gitignore` → Git Ignore、
 * `justfile` → Just はどれも意図的で、**キーを間に挟んでいるから表現できる**。
 *
 * **ここにあってモードが無いキーは、色が付かないだけ**（アウトラインやアイコンだけが使う
 * 種別も置ける）。逆は上のとおり型で塞いである。
 */
export const FILE_TYPE_LABELS = {
  ts: 'TypeScript',
  tsx: 'TypeScript (JSX)',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript (JSX)',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  rs: 'Rust',
  go: 'Go',
  py: 'Python',
  rb: 'Ruby',
  pl: 'Perl',
  pm: 'Perl',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  scala: 'Scala',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cs: 'C#',
  m: 'Objective-C',
  php: 'PHP',
  phtml: 'PHP',
  json: 'JSON',
  jsonc: 'JSON',
  jsonl: 'JSON Lines',
  ndjson: 'JSON Lines',
  md: 'Markdown',
  markdown: 'Markdown',
  rst: 'reStructuredText',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  html: 'HTML',
  htm: 'HTML',
  vue: 'Vue',
  svg: 'SVG',
  css: 'CSS',
  scss: 'SCSS',
  sql: 'SQL',
  lua: 'Lua',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  psm1: 'PowerShell',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  // 分割した `rules.mk` / `config.mak`。**落とさないこと**: 判定を 1 つにまとめる前は
  // アウトラインの振り分けだけがこの 2 つを知っていた。
  mk: 'Makefile',
  mak: 'Makefile',
  justfile: 'Just',
  // shell のモードで色を付けているが、種別として「Shell」とは名乗らせない（あれは shell では
  // ない）。
  gitignore: 'Git Ignore',
  ini: 'INI',
  // iOS のビルド設定（`Debug.xcconfig`）。**XML ではなく `KEY = value`** なので INI 側に
  // 寄せる（#345）。
  xcconfig: 'INI',
  env: 'DotEnv',
  // #345。`svg` は `html()` のままにしてある（SVG は XML だが、実用上あちらで足りていて
  // 困っていないため）。**`.xcconfig` はここに入れない**: 中身は XML ではなく `KEY = value`
  // なので `ini` 側。
  xml: 'XML',
  xsd: 'XML',
  xsl: 'XML',
  xslt: 'XML',
  wsdl: 'XML',
  plist: 'XML',
  csproj: 'XML',
  diff: 'Diff',
  patch: 'Diff',
  conf: 'Nginx',
  proto: 'Protobuf',
} as const

export type FileTypeKey = keyof typeof FILE_TYPE_LABELS

/** プロトタイプ無しの索引（引くキーは利用者が書いた文字列。理由は `languages.ts` の `table`）。 */
const LABELS: Record<string, string> = Object.assign(Object.create(null), FILE_TYPE_LABELS)

function isKnown(key: string): key is FileTypeKey {
  return key in LABELS
}

/**
 * 拡張子としては引けないファイル名 → キー。
 *
 * **`Dockerfile` / `Makefile` / `.gitignore` / `justfile` はここに要らない。** 下の
 * `fileTypeKey` が取る拡張子は「最後のドットより後ろ」ではなく `split('.').pop()` なので、
 * ドットを持たない名前は名前そのものが、`.gitignore` は `gitignore` がそのままキーに当たる。
 * 書くと同じ知識が 2 つの表に載るだけになる。
 *
 * **`.bashrc` 系をここに置くのは、ラベルを「Shell」と名乗らせるため**（`bashrc` をキーに
 * すると専用のラベルが要る）。`.envrc` / `.profile` 系も同じ。
 *
 * **`*.lock` を拡張子で引かないこと**（#347）。`Cargo.lock` / `uv.lock` / `poetry.lock` は
 * TOML だが、`yarn.lock` / `Gemfile.lock` は別の形式なので、名前ごとに置く。
 */
const NAME_KEYS: Record<string, string> = Object.assign(Object.create(null), {
  '.bashrc': 'sh',
  '.zshrc': 'sh',
  '.envrc': 'sh',
  '.profile': 'sh',
  '.bash_profile': 'sh',
  '.zprofile': 'sh',
  '.zshenv': 'sh',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.gitconfig': 'ini',
  'cargo.lock': 'toml',
  'uv.lock': 'toml',
  'poetry.lock': 'toml',
  gnumakefile: 'makefile',
})

/**
 * 複合名（`Dockerfile.dev` / `.env.local`）のとき、**先頭のセグメントで引き直してよい名前**
 * （#348）。
 *
 * **全キーを先頭セグメントで引かないこと。** `go.mod` / `go.sum` は先頭が `go` なので Go と
 * してハイライトされ（今は拡張子 `mod` / `sum` が当たらず Plain Text）、`c` / `h` / `m` の
 * ような短いキーも同じ誤判定を起こす。**ファイル名として使われるキーに限る。**
 */
const COMPOUND_NAMES = new Set(['dockerfile', 'gnumakefile', 'makefile', 'justfile', 'env'])

/**
 * shebang のインタプリタ名 → キー（#312）。
 *
 * **既に扱えるものだけを載せる**（「軽さ最優先」）。`fish` や `awk` はモードを増やすことに
 * なるので入れない。
 */
const SHEBANG_KEYS: Record<string, string> = Object.assign(Object.create(null), {
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  dash: 'sh',
  ksh: 'sh',
  ash: 'sh',
  python: 'py',
  ruby: 'rb',
  perl: 'pl',
  php: 'php',
  lua: 'lua',
  node: 'js',
  nodejs: 'js',
  bun: 'js',
  deno: 'ts',
  pwsh: 'ps1',
  powershell: 'ps1',
})

/** 1 行目から読む最大文字数。minify された JS のように長い 1 行目を丸ごと走査しない。 */
const SHEBANG_MAX = 256

/**
 * 言語判定に渡す 1 行目を切り出す（#312）。
 *
 * **切る長さをこのファイルに置くのが要点。** 呼び出し側がリテラルで持つと、`SHEBANG_MAX` を
 * 広げても手前で切られていて効かない、という無言の不整合になる。`slice` を先にするのは、
 * 改行を持たない数 MB の 1 行に `split` を当てないため。
 */
export function firstLineOf(text: string): string {
  return text.slice(0, SHEBANG_MAX).split('\n', 1)[0]
}

/**
 * shebang からキーを引く（#312）。当たらなければ空文字。
 *
 * 規則は 2 つ。**先頭のパスの basename を取り、それが `env` なら続く最初の非オプション語を
 * 見る**（`#!/usr/bin/env -S deno run --allow-net` の `-S` もここで飛ぶ）。そして**末尾の
 * バージョンを落とす**（`python3` / `python3.11` → `python`）。
 *
 * shebang のパスは常に POSIX なので、`paths.ts` の `basename`（`\` も切る）ではなく `/` だけで
 * 切る。行末の `\r`（CRLF）は `trim` が落とす。
 */
function shebangKey(firstLine: string): string {
  const line = firstLine.slice(0, SHEBANG_MAX)
  if (!line.startsWith('#!')) return ''
  const tokens = line.slice(2).trim().split(/\s+/)
  const interp = (token?: string) => token?.split('/').pop() ?? ''
  let i = 0
  let name = interp(tokens[i])
  if (name === 'env') {
    i++
    while (tokens[i]?.startsWith('-')) i++
    name = interp(tokens[i])
  }
  return SHEBANG_KEYS[name.replace(/[\d.]+$/, '').toLowerCase()] ?? ''
}

/** 候補を `NAME_KEYS` 越しに正規化して、扱えるキーなら返す。 */
function keyFor(candidate: string): string {
  if (!candidate) return ''
  const mapped = NAME_KEYS[candidate] ?? candidate
  return isKnown(mapped) ? mapped : ''
}

/**
 * このファイルの種別のキー。当たらなければ空文字。
 *
 * **優先順は 名前 → 拡張子 → 先頭セグメント → shebang。**
 *
 * - **名前**: `.bashrc` / `Cargo.lock` / `GNUmakefile` のように、拡張子では引けないもの
 * - **拡張子は `paths.ts` の `extension` ではなく `split('.').pop()` で取る。** あちらは
 *   「最後のドットより後ろ、ただし先頭のドットは除く」なので `.gitignore` も `Makefile` も
 *   空を返す。ここは**拡張子を持たない名前をそのままキーとして引きたい**ので、意図して
 *   別の取り方をしている
 * - **先頭セグメント**は複合名のため（#348）。`Dockerfile.dev` → `dockerfile`、
 *   `.env.local` → `env`。引いてよい名前は `COMPOUND_NAMES` に絞る
 * - **shebang は `firstLine` を渡したときだけ**（#312）。拡張子で決まるファイルの中身は
 *   読まない。アウトラインとアイコンは渡さないので、あちらは名前だけで決まる
 */
export function fileTypeKey(filename: string, firstLine = ''): string {
  const name = basename(filename).toLowerCase()
  const byName = keyFor(name)
  if (byName) return byName

  const segments = name.split('.')
  const byExt = keyFor(segments[segments.length - 1] ?? '')
  if (byExt) return byExt

  // ドット始まりの名前は先頭が空文字になるので、そのときは 2 番目を見る。
  const head = segments[0] || segments[1] || ''
  if (COMPOUND_NAMES.has(head)) {
    const byHead = keyFor(head)
    if (byHead) return byHead
  }

  return shebangKey(firstLine)
}

/** キーの表示名。扱えないキーは `Plain Text`。 */
export function fileTypeLabel(key: string): string {
  return LABELS[key] ?? 'Plain Text'
}

/** StatusBar に出すファイル種別。 */
export function fileTypeLabelOf(filename: string, firstLine?: string): string {
  return fileTypeLabel(fileTypeKey(filename, firstLine))
}
