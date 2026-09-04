import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'
import { rust } from '@codemirror/lang-rust'
import { yaml } from '@codemirror/lang-yaml'
import { LanguageSupport, StreamLanguage } from '@codemirror/language'
import { c, cpp, csharp, java, kotlin, objectiveC, scala } from '@codemirror/legacy-modes/mode/clike'
import { css as cssMode, sCSS } from '@codemirror/legacy-modes/mode/css'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { go } from '@codemirror/legacy-modes/mode/go'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf'
import { python } from '@codemirror/legacy-modes/mode/python'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'
// CM6 に公式の rst は無い（CM5 にはあった）ので、外部パッケージを 1 つだけ足している。
// 依存は `@lezer/highlight` だけで、壊れてもハイライトが崩れるにとどまる（#284）。
import { rst } from 'codemirror-lang-rst'
import { basename } from './paths'

function legacy(mode: Parameters<typeof StreamLanguage.define>[0]): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(mode))
}

const EXT_MAP: Record<string, () => LanguageSupport> = {
  // Official CM6 packages
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  rs: () => rust(),
  md: () => markdown(),
  markdown: () => markdown(),
  rst: () => rst(),
  yaml: () => yaml(),
  yml: () => yaml(),
  vue: () => html(),
  html: () => html(),
  htm: () => html(),
  svg: () => html(),
  json: () => json(),
  jsonc: () => json(),
  jsonl: () => json(),
  ndjson: () => json(),
  php: () => php(),
  phtml: () => php(),
  // Legacy modes
  go: () => legacy(go),
  sh: () => legacy(shell),
  bash: () => legacy(shell),
  zsh: () => legacy(shell),
  py: () => legacy(python),
  rb: () => legacy(ruby),
  pl: () => legacy(perl),
  pm: () => legacy(perl),
  java: () => legacy(java),
  kt: () => legacy(kotlin),
  kts: () => legacy(kotlin),
  scala: () => legacy(scala),
  swift: () => legacy(swift),
  c: () => legacy(c),
  h: () => legacy(c),
  cpp: () => legacy(cpp),
  cc: () => legacy(cpp),
  cxx: () => legacy(cpp),
  hpp: () => legacy(cpp),
  cs: () => legacy(csharp),
  m: () => legacy(objectiveC),
  css: () => legacy(cssMode),
  scss: () => legacy(sCSS),
  sql: () => legacy(standardSQL),
  lua: () => legacy(lua),
  dockerfile: () => legacy(dockerFile),
  makefile: () => legacy(shell),
  // `.gitignore` は shell ではないが、コメントと素の語だけなので shell のモードが素直に当たる。
  // 専用のキーにしてあるのは、ラベル（`LABEL_MAP`）で「Shell」と名乗らせないため。
  gitignore: () => legacy(shell),
  toml: () => legacy(toml),
  diff: () => legacy(diff),
  patch: () => legacy(diff),
  ps1: () => legacy(powerShell),
  psm1: () => legacy(powerShell),
  conf: () => legacy(nginx),
  proto: () => legacy(protobuf),
}

/**
 * 拡張子では決まらないファイル名 → `EXT_MAP` / `LABEL_MAP` のキー。
 *
 * **`Dockerfile` / `Makefile` / `.gitignore` はここに要らない。** `resolveLanguageKey` の
 * 拡張子は「最後のドットより後ろ」ではなく `split('.').pop()` なので、ドットを持たない名前は
 * 名前そのものが、`.gitignore` は `gitignore` が拡張子として `EXT_MAP` に当たる。書くと
 * 同じ知識が 2 つの表に載るだけになる（この変更が消したかったのがまさにそれ）。
 */
const NAME_KEYS: Record<string, string> = {
  '.bashrc': 'sh',
  '.zshrc': 'sh',
}

/**
 * shebang のインタプリタ名 → キー（#312）。
 *
 * **既に import 済みのモードだけを載せる**（「軽さ最優先」）。`fish` や `awk` はモードを
 * 増やすことになるので入れない。
 */
const SHEBANG_KEYS: Record<string, string> = {
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
}

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

/**
 * ハイライトとラベルが共有する言語キー。**優先順は 名前 → 拡張子 → shebang**（#312）。
 *
 * 拡張子で決まるファイルの中身は読まない。`firstLine` を渡さなければファイル名だけで決まる。
 *
 * **拡張子は `paths.ts` の `extension` ではなく `split('.').pop()` で取る。** あちらは
 * 「最後のドットより後ろ、ただし先頭のドットは除く」なので `.gitignore` も `Makefile` も
 * 空を返す。ここは**拡張子を持たない名前をそのままキーとして引きたい**（`Makefile` →
 * `makefile`、`.gitignore` → `gitignore`）ので、意図して別の取り方をしている。
 */
function resolveLanguageKey(filename: string, firstLine = ''): string {
  const name = basename(filename).toLowerCase()
  const named = NAME_KEYS[name]
  if (named) return named
  const ext = name.split('.').pop() ?? ''
  return EXT_MAP[ext] ? ext : shebangKey(firstLine)
}

/**
 * キー → StatusBar の表記。**`EXT_MAP` と同じキー集合を保つこと**（#312）。
 *
 * ここに無いキーは `Plain Text` に落ちるので、片方にだけ足すと**色は付くのに種別が
 * Plain Text**という状態ができる。ハイライトとラベルの解決を 1 つにしたのはそれを消すため
 * だったが、この不変条件自体は型では守られない（`.jsonl` が実際にその穴だった）。
 *
 * ラベルがモードと違う名前になるのは構わない。`conf` → Nginx、`gitignore` → Git Ignore は
 * どちらも意図的で、**キーを間に挟んでいるから表現できる**。
 */
const LABEL_MAP: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript (JSX)',
  js: 'JavaScript',
  jsx: 'JavaScript (JSX)',
  mjs: 'JavaScript',
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
  // shell のモードで色を付けているが、種別として「Shell」とは名乗らせない（あれは shell では
  // ない）。**ラベルを持たせないと「色は付くのに Plain Text」**になり、この統合が直したはずの
  // 食い違いが 1 件だけ残る。
  gitignore: 'Git Ignore',
  diff: 'Diff',
  patch: 'Diff',
  conf: 'Nginx',
  proto: 'Protobuf',
}

/** キーを直に指定して言語を引く（StatusBar からの手動切り替え）。 */
export function languageByKey(key: string): LanguageSupport | null {
  return EXT_MAP[key]?.() ?? null
}

/** キーの表示名。手動で選んだときの StatusBar はファイル名を見ないのでこちらを引く。 */
export function languageLabelByKey(key: string): string {
  return LABEL_MAP[key] ?? 'Plain Text'
}

/** StatusBar に出すファイル種別。**`getLanguage` と同じキーを引く**（理由は `LABEL_MAP`）。 */
export function getLanguageLabel(filename: string, firstLine?: string): string {
  return languageLabelByKey(resolveLanguageKey(filename, firstLine))
}

export function getLanguage(filename: string, firstLine?: string): LanguageSupport | null {
  return languageByKey(resolveLanguageKey(filename, firstLine))
}

/**
 * 手動で選べる言語の一覧（StatusBar のドロップダウン）。
 *
 * **ラベルで畳む。** `EXT_MAP` のキーは拡張子なので同じ言語に何本もある（`js` / `mjs` /
 * `jsx`、`py`、`sh` / `bash` / `zsh`…）。利用者に見せたいのは言語であって拡張子ではないので、
 * 同じラベルを持つキーは最初の 1 本を代表にする。**ラベルの無いキーは出さない**: 選んでも
 * StatusBar の表示が `Plain Text` のままになり、切り替わったのか分からない。
 */
export function languageOptions(): { key: string; label: string }[] {
  const byLabel = new Map<string, string>()
  for (const key of Object.keys(EXT_MAP)) {
    const label = LABEL_MAP[key]
    if (label && !byLabel.has(label)) byLabel.set(label, key)
  }
  return [...byLabel].map(([label, key]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label))
}
