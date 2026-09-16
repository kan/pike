import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { php } from '@codemirror/lang-php'
import { rust } from '@codemirror/lang-rust'
import { vue } from '@codemirror/lang-vue'
import { yaml } from '@codemirror/lang-yaml'
import { type Language, LanguageSupport, StreamLanguage } from '@codemirror/language'
import { c, cpp, csharp, java, kotlin, objectiveC, scala } from '@codemirror/legacy-modes/mode/clike'
import { css as cssMode, less, sCSS } from '@codemirror/legacy-modes/mode/css'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { go } from '@codemirror/legacy-modes/mode/go'
import { jinja2 } from '@codemirror/legacy-modes/mode/jinja2'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf'
import { python } from '@codemirror/legacy-modes/mode/python'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { xml as xmlMode } from '@codemirror/legacy-modes/mode/xml'
// CM6 に公式の rst は無い（CM5 にはあった）ので、外部パッケージを 1 つだけ足している。
// 依存は `@lezer/highlight` だけで、壊れてもハイライトが崩れるにとどまる（#284）。
import { rst } from 'codemirror-lang-rst'
import { type FileTypeKey, fileTypeKey, fileTypeLabel, fileTypeLabelOf } from './fileType'

function legacy(mode: Parameters<typeof StreamLanguage.define>[0]): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(mode))
}

/**
 * プロトタイプを持たない表を作る。**このファイルの表は全部これを通すこと。**
 *
 * 引くキーになるのは利用者が書いた文字列（ファイル名の拡張子、Markdown のフェンスの言語名）
 * なので、素のオブジェクトリテラルだと `constructor` や `__proto__` でプロトタイプ側の値が
 * 返る。`Record` の型はそこで破れ、`EXT_MAP` では**関数でないものを呼びに行く**
 * （`constructor` は `Object` に当たるので、今は例外にならず空のオブジェクトが返るだけ）。
 *
 * **読む側にガードを置くより、作る側で閉じる。** 引く場所（`languageByKey` と
 * `fenceLanguage`）は増えていく側で、キーの出どころも利用者の入力だけだから。
 * `Object.keys` はプロトタイプ無しでも従来どおり動く。
 */
function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null), entries)
}

/**
 * フェンスの info 文字列 → `EXT_MAP` のキー（#344）。**綴りが違うものだけを載せる**
 * （info がキーそのものなら表を引く必要が無い）。
 *
 * **想像で網羅表を作らない**（「軽さ最優先」）。着手時に手元のリポジトリ 8 本の追跡済み md と、
 * `node_modules` の README（約 4,000 件）でフェンスの名前を数え、実在した順に拾った:
 * `javascript` 346 / `typescript` 280 / `console` 111 / `shell` 45 / `powershell` 37 /
 * `rust` 23。残りの上位（`js` / `ts` / `sh` / `bash` / `html` / `json` / `yaml` / `toml` /
 * `diff` / `vue` / `tsx` / `jsx` / `mjs` / `markdown`）は既に `EXT_MAP` のキーそのもの。
 *
 * **`console` は shell のセッション**（プロンプト付きの貼り付け）で、GitHub も shell として
 * 色を付ける。実測で 111 件あり、無視すると `npm install` を並べた README が軒並み無色になる。
 *
 * 残り（`golang` 以降）は**この表の綴りの規則から漏れるもの**を足しただけで、実測には
 * 出ていない。`text` / `txt` / `mermaid` / `cmd` / `ini` は当てるモードが無いので載せない
 * （`null` に落ちて無色になる）。
 */
const FENCE_ALIASES: Record<string, string> = table({
  javascript: 'js',
  typescript: 'ts',
  shell: 'sh',
  console: 'sh',
  rust: 'rs',
  python: 'py',
  ruby: 'rb',
  perl: 'pl',
  powershell: 'ps1',
  golang: 'go',
  csharp: 'cs',
  'c#': 'cs',
  kotlin: 'kt',
  docker: 'dockerfile',
  make: 'makefile',
})

/**
 * フェンスに当てる `Language`（#344）。**キーごとにキャッシュするのが要点。**
 *
 * `codeLanguages` のコールバックは**フェンスごと・再パースごと**に呼ばれる。
 * `languageByKey` は呼ぶたびに `LanguageSupport` を作り直し、legacy モードでは
 * `StreamLanguage.define` もやり直すので、そのまま返すと同じ言語のフェンスが毎回**別の
 * `Language`** になり、ネストした木を使い回せない。
 *
 * **未対応の名前も覚える**（`null` を入れる）。`mermaid` のように当てるモードが無い名前は
 * README で普通に出てくるので、打鍵のたびに表を 2 つ引き直す必要が無い。
 */
const fenceLanguages = new Map<string, Language | null>()

function fenceLanguage(info: string): Language | null {
  const name = info.toLowerCase()
  const key = FENCE_ALIASES[name] ?? name
  const cached = fenceLanguages.get(key)
  if (cached !== undefined) return cached
  const language = languageByKey(key)?.language ?? null
  fenceLanguages.set(key, language)
  return language
}

/**
 * Markdown（#344）。**フェンスの中身を `EXT_MAP` の言語で解析する。**
 *
 * `codeLanguages` を渡さないと lang-markdown はフェンスを素通りするので、コードブロックの
 * 多い md（`CLAUDE.md` / README / エージェントが書いた設計メモ）が丸ごと無色になる。
 * **依存は増えない**（`@codemirror/language-data` は入れず、既にある `EXT_MAP` を引く）。
 *
 * 受け取る `info` は**先頭の語だけ**（lang-markdown の `getCodeParser` が最初の空白までで
 * 切る）なので、`ts title="x"` のように属性を書いたフェンスもこちらで気にしなくてよい。
 */
const markdownSupport = () => markdown({ codeLanguages: fenceLanguage })

/**
 * `<style lang="…">` の中身に当てるパーサ（#346）。**モジュールの先頭で 1 度だけ作る**
 * （`vueSupport` はファイルを開くたびに呼ばれるので、そこで `StreamLanguage.define` を
 * やり直すと SFC ごとに別のパーサになる）。
 */
const STYLE_LANGS = [
  { lang: 'scss', mode: sCSS },
  { lang: 'less', mode: less },
].map(({ lang, mode }) => ({
  tag: 'style',
  attrs: (attrs: Record<string, string>) => attrs.lang === lang,
  parser: StreamLanguage.define(mode).parser,
}))

/**
 * Vue SFC（#346）。**土台の `html()` と `vue()` を重ねる。**
 *
 * - **`<style lang="scss">` / `<style lang="less">`** … `html()` の `nestedLanguages`。
 *   既定の規則が CSS を当てるのは `lang` が無いか `css` のときだけなので、これが無いと
 *   SCSS / Less を書いた SFC は style ブロックが丸ごと無色になる
 * - **テンプレートの式**（`{{ }}` の補間と `v-if` / `:prop` / `@event` の属性値）…
 *   `@codemirror/lang-vue`。**`nestedAttributes` では代用できない**: あれは属性名を固定で
 *   並べる形で、`:` と `@` で任意の名前が作られる Vue のバインディングを表せない
 * - **`<script setup lang="ts">`** … lang-html の既定の規則（`attrs.lang == "ts"`）が
 *   元から効いているので、こちらで足すものは無い
 *
 * **`base` は `html()` の結果でなければならない**（lang-vue の契約。ただの `LanguageSupport`
 * を渡すと動かない）ので、style の設定はそちらへ乗せてから渡す。
 */
const vueSupport = () => vue({ base: html({ nestedLanguages: STYLE_LANGS }) })

/**
 * キー → 言語モード。**キーの正本は `fileType.ts` の `FILE_TYPE_LABELS`**（#347）。
 *
 * `Partial<Record<FileTypeKey, …>>` で縛ってあるので、**ラベルを持たないキーにモードを
 * 足すとコンパイルエラーになる**。「色は付くのに種別が Plain Text」（#312 で直した食い違い）が
 * 型の届かないところに戻らない。逆向き（ラベルだけあってモードが無い）は許す。
 *
 * **`satisfies` はリテラルの内側に置くこと。** `table(…) satisfies …` と外へ書くと、
 * `table` の戻り値が `Record<string, …>` に広がって索引シグネチャが何でも満たすため、
 * **知らないキーを足しても通ってしまう**（実測で確認）。余剰プロパティの検査が働くのは、
 * オブジェクトリテラルに直接当てたときだけ。
 */
const EXT_MAP = table({
  // Official CM6 packages
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),
  rs: () => rust(),
  md: markdownSupport,
  markdown: markdownSupport,
  rst: () => rst(),
  yaml: () => yaml(),
  yml: () => yaml(),
  vue: vueSupport,
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
  less: () => legacy(less),
  j2: () => legacy(jinja2),
  sql: () => legacy(standardSQL),
  lua: () => legacy(lua),
  dockerfile: () => legacy(dockerFile),
  makefile: () => legacy(shell),
  mk: () => legacy(shell),
  mak: () => legacy(shell),
  // just のレシピ本体はシェルなので、`makefile` と同じく shell のモードに寄せる（#347）。
  justfile: () => legacy(shell),
  // `.editorconfig` / `.npmrc` / `.gitconfig` / `.env` 系もここへ寄せる（#347 / #348）。
  // どれも `KEY=value` とコメントだけなので properties のモードが素直に当たる。
  ini: () => legacy(properties),
  xcconfig: () => legacy(properties),
  env: () => legacy(properties),
  // XML（#345）。**legacy-modes の `xml` を使う**（導入済みなので依存が増えない）。
  // `@codemirror/lang-xml` を足すと構文木が得られるが、アウトラインに XML を載せる予定が
  // 無いので、その 1 点のために依存を増やさない。
  xml: () => legacy(xmlMode),
  xsd: () => legacy(xmlMode),
  xsl: () => legacy(xmlMode),
  xslt: () => legacy(xmlMode),
  wsdl: () => legacy(xmlMode),
  plist: () => legacy(xmlMode),
  csproj: () => legacy(xmlMode),
  // `.gitignore` は shell ではないが、コメントと素の語だけなので shell のモードが素直に当たる。
  // 専用のキーにしてあるのは、`FILE_TYPE_LABELS` で「Shell」と名乗らせないため。
  gitignore: () => legacy(shell),
  toml: () => legacy(toml),
  diff: () => legacy(diff),
  patch: () => legacy(diff),
  ps1: () => legacy(powerShell),
  psm1: () => legacy(powerShell),
  conf: () => legacy(nginx),
  proto: () => legacy(protobuf),
} satisfies Partial<Record<FileTypeKey, () => LanguageSupport>>)

/** キーを直に指定して言語を引く（StatusBar からの手動切り替え）。 */
export function languageByKey(key: string): LanguageSupport | null {
  return EXT_MAP[key]?.() ?? null
}

/** キーの表示名。手動で選んだときの StatusBar はファイル名を見ないのでこちらを引く。 */
export const languageLabelByKey = fileTypeLabel

/** StatusBar に出すファイル種別。**`getLanguage` と同じキーを引く**（#347）。 */
export const getLanguageLabel = fileTypeLabelOf

export function getLanguage(filename: string, firstLine?: string): LanguageSupport | null {
  return languageByKey(fileTypeKey(filename, firstLine))
}

/**
 * 手動で選べる言語の一覧（StatusBar のドロップダウン）。
 *
 * **ラベルで畳む。** `EXT_MAP` のキーは拡張子なので同じ言語に何本もある（`js` / `mjs` /
 * `jsx`、`py`、`sh` / `bash` / `zsh`…）。利用者に見せたいのは言語であって拡張子ではないので、
 * 同じラベルを持つキーは最初の 1 本を代表にする。**モードを持つキーだけを出す**: ラベルだけの
 * キー（アウトラインやアイコンのためにある種別）を選んでも、色が付かず切り替わったのか
 * 分からない。
 */
export function languageOptions(): { key: string; label: string }[] {
  const byLabel = new Map<string, string>()
  for (const key of Object.keys(EXT_MAP)) {
    const label = fileTypeLabel(key)
    if (label !== 'Plain Text' && !byLabel.has(label)) byLabel.set(label, key)
  }
  return [...byLabel].map(([label, key]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label))
}
