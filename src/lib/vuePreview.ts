/**
 * Vue SFC のプレビュー（#397）の純粋な部分。描画は外部コマンド `vue-preview` の持ち物で
 * （`src-tauri/src/vue_preview.rs`）、ここにあるのは「どのファイルが変わったら描き直すか」、
 * 描けるまで／描けなかったときに子 webview へ置くページ、値を仮に埋める入力フォームの欄。
 */

import { isPosixShell, type ShellType } from '../types/tab'
import { escapeHtml } from './text'

/** 子 webview で開く仮想ファイル（`html_preview.rs` の `__pike/` の下）。 */
export const VUE_PREVIEW_ENTRY = '__pike/vue-preview.html'

/** vue-preview がルート直下に探す設定ファイル。 */
const CONFIG_FILE = 'vue-preview.config.json'

/** SFC に対応する fixture（`<name>.preview.json`）。vue-preview が省略時に探す名前。 */
export function fixtureOf(rel: string): string {
  return rel.replace(/\.vue$/i, '.preview.json')
}

/**
 * ルートからの相対パス `rel` が変わったら描き直すか。前回の結果の `deps` に加えて、SFC 自身と
 * **まだ無い fixture と設定ファイル**も見る（無いファイルは `deps` に載らないので、作った
 * ときに描き直せない）。
 */
export function affectsVuePreview(rel: string, entry: string, deps: ReadonlySet<string>): boolean {
  return rel === entry || deps.has(rel) || rel === fixtureOf(entry) || rel === CONFIG_FILE
}

/** fixture で与えられるもの 1 つ（vue-preview の `--json` の `inputs`）。 */
export interface VueInput {
  name: string
  /** 宣言された型（props だけ）。 */
  types?: string[]
  /** 静的に読めた既定値・初期値。 */
  default?: unknown
  /** `call`: 関数呼び出しの戻り値から受け取った名前（`const store = useProjectStore()`。composable の関数やストア）。 */
  origin?: 'call'
}

/** vue-preview の `--json` の `inputs`（vue-preview 0.4 以降。古い版では無い）。 */
export interface VueInputs {
  props: VueInput[]
  /** props 以外にテンプレートが参照した値。描画中に記録されるので、描かれた部分の分だけ並ぶ。 */
  values: VueInput[]
  /** 使った fixture（描画のルートからの相対パス）。 */
  fixture: string | null
}

/**
 * フォームで入れた値を置く fixture の名前（`.pike/preview/` の下）。SFC の、プロジェクトからの
 * 相対パスを 1 段の名前にする（ディレクトリを掘らない。`a/b.vue` と `a__b.vue` がぶつかりうるが、
 * 手で入れる仮の値なので割り切る）。
 */
export function pikeFixtureName(rel: string): string {
  return `${rel.replaceAll('/', '__')}.json`
}

/**
 * 入力フォームの 1 欄。`text` は値を JSON で書いたもの（空なら与えない）。`kind` の `call` は
 * composable から受け取った値で、フォームは畳んで見せる（JSON で意味のある値を与えにくい）。
 */
export interface InputField {
  name: string
  kind: 'prop' | 'value' | 'call'
  /** 宣言された型（`Boolean | String`）。無ければ空。 */
  types: string
  /** 静的に読めた既定値・初期値を JSON で書いたもの。無ければ null。 */
  initial: string | null
  text: string
}

/**
 * フォームの欄。props、値、composable から受け取った値の順に並べ、今の値（`current`）を JSON で
 * 入れておく。`current` にだけある名前（前に入れたが、今回の描画では参照されなかった値）も残す:
 * 消すと、`v-if` で隠れた部分の値を入れ直すことになる。
 */
export function inputFields(inputs: VueInputs, current: Record<string, unknown>): InputField[] {
  // `in` ではなく自分のキーで見る（`constructor` のような名前がプロトタイプに当たる）
  const own = new Set(Object.keys(current))
  const field = (input: VueInput, kind: InputField['kind']): InputField => ({
    name: input.name,
    kind,
    types: input.types?.join(' | ') ?? '',
    initial: input.default === undefined ? null : JSON.stringify(input.default),
    text: own.has(input.name) ? JSON.stringify(current[input.name]) : '',
  })
  const fields = [
    ...inputs.props.map((p) => field(p, 'prop')),
    ...inputs.values.filter((v) => v.origin !== 'call').map((v) => field(v, 'value')),
    ...inputs.values.filter((v) => v.origin === 'call').map((v) => field(v, 'call')),
  ]
  const known = new Set(fields.map((f) => f.name))
  for (const name of Object.keys(current)) {
    if (!known.has(name)) fields.push(field({ name }, 'value'))
  }
  return fields
}

/**
 * 欄の入力を fixture の値にする。空の欄は与えない。**JSON として読めなければ文字列として扱う**
 * （`山田 太郎` を引用符無しで入れられるように）。
 */
export function fixtureFromFields(fields: readonly Pick<InputField, 'name' | 'text'>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const text = f.text.trim()
    if (!text) continue
    try {
      out[f.name] = JSON.parse(text)
    } catch {
      out[f.name] = text
    }
  }
  return out
}

/**
 * 描けるまでと、描けなかったときに置くページ。**Pike のテーマの変数は子 webview に届かない**
 * （別の文書）ので、配色は OS の設定（`prefers-color-scheme`）に合わせる。
 */
export function vuePreviewMessagePage(title: string, detail?: string): string {
  const body = detail ? `<pre>${escapeHtml(detail)}</pre>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark}
body{margin:0;padding:24px;font:13px/1.6 system-ui,sans-serif;color:#555}
@media (prefers-color-scheme:dark){body{background:#1e1e1e;color:#aaa}}
pre{white-space:pre-wrap;word-break:break-all;font:12px/1.5 ui-monospace,Consolas,monospace}
</style></head><body><p>${escapeHtml(title)}</p>${body}</body></html>`
}

/** vue-preview の最新版のリリース（`latest/download/<名前>` は GitHub が最新のタグへ振り替える）。 */
export const VUE_PREVIEW_RELEASES = 'https://github.com/kan/vue-preview/releases'
const LATEST = `${VUE_PREVIEW_RELEASES}/latest/download`

/**
 * WSL / macOS で入れる 1 行。置き場は `~/.local/bin`（sudo が要らない。WSL は Pike の
 * `WSL_EXTRA_PATH`、macOS は起動時の `augment_process_path` がそこを PATH に入れる）。
 * sha256 を照合してから置く。配っているのは linux-x64 と darwin-arm64 だけ。
 *
 * `bash -c` で包むのは、ターミナルの対話シェル（zsh でも）に `set -e` と `exit` を流さないため。
 * **中身に単引用符を使わないこと**（包みが割れる）。macOS には `sha256sum` が無いことがあるので
 * `shasum -a 256` に落とす。
 */
const INSTALL_POSIX =
  'bash -c \'set -e; case "$(uname -s)-$(uname -m)" in Linux-x86_64) t=linux-x64;; ' +
  'Darwin-arm64) t=darwin-arm64;; *) echo "unsupported: $(uname -sm)"; exit 1;; esac; ' +
  `n=vue-preview-$t; u=${LATEST}/$n; d=$(mktemp -d); trap "rm -rf \\"$d\\"" EXIT; cd "$d"; ` +
  'curl -fsSLO "$u"; curl -fsSLO "$u.sha256"; ' +
  'if command -v sha256sum >/dev/null; then sha256sum -c "$n.sha256"; else shasum -a 256 -c "$n.sha256"; fi; ' +
  'mkdir -p "$HOME/.local/bin"; install -m 755 "$n" "$HOME/.local/bin/vue-preview"; ' +
  '"$HOME/.local/bin/vue-preview" --version\''

/**
 * Windows のシェル（cmd / PowerShell / Git Bash）で入れるスクリプト。置き場は
 * `%USERPROFILE%\.local\bin`（Pike が起動時に PATH の末尾へ足す。`types.rs` の
 * `augment_process_path`）。
 *
 * **cmdlet を使わず .NET を直に呼ぶ**。pwsh（PowerShell 7）から `powershell.exe`（5.1）を
 * 起こすと 7 の `PSModulePath` を継いでしまい、`Get-FileHash` などのモジュールの cmdlet が
 * 読めずに落ちる（実測）。
 */
const INSTALL_WINDOWS = [
  "$ErrorActionPreference='Stop'",
  '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
  `$n='vue-preview-windows-x64.exe'; $u="${LATEST}/$n"`,
  '$tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), [Guid]::NewGuid().ToString())',
  '[void][IO.Directory]::CreateDirectory($tmp); $f = [IO.Path]::Combine($tmp, $n)',
  'try {',
  '  $web = New-Object Net.WebClient',
  '  $web.DownloadFile($u, $f)',
  '  $want = $web.DownloadString("$u.sha256").Trim().Split(" ")[0]',
  '  $s = [IO.File]::OpenRead($f)',
  '  try { $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($s) } finally { $s.Dispose() }',
  '  $got = [BitConverter]::ToString($hash).Replace("-", "")',
  '  if ($got -ne $want) { throw "sha256 mismatch: $got <> $want" }',
  '  $d = [IO.Path]::Combine($env:USERPROFILE, ".local", "bin"); [void][IO.Directory]::CreateDirectory($d)',
  '  $exe = [IO.Path]::Combine($d, "vue-preview.exe"); [IO.File]::Copy($f, $exe, $true)',
  '  & $exe --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  '} finally { [IO.Directory]::Delete($tmp, $true) }',
].join('\n')

/**
 * PowerShell の `-EncodedCommand` に渡す形（UTF-16LE の base64）。**引用を 1 つも持たない**ので、
 * 打ち込む先が cmd でも PowerShell でも Git Bash でも同じ 1 行で通る（`-Command "..."` だと、
 * 打ち込んだ先の PowerShell が `$` を先に展開する）。
 */
export function powershellEncoded(script: string): string {
  let bytes = ''
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bytes += String.fromCharCode(c & 0xff, c >> 8)
  }
  return btoa(bytes)
}

/** `shell` のターミナルで vue-preview を入れる 1 行（`stores/vuePreview.ts` の `install` が流す）。 */
export function vuePreviewInstallCommand(shell: ShellType): string {
  if (isPosixShell(shell)) return INSTALL_POSIX
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${powershellEncoded(INSTALL_WINDOWS)}`
}

/** `vuePreviewInstallCommand` が置く場所（案内に出す表記）。 */
export function vuePreviewInstallDir(shell: ShellType): string {
  return isPosixShell(shell) ? '~/.local/bin' : '%USERPROFILE%\\.local\\bin'
}
