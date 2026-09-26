/**
 * Vue SFC のプレビュー（#397）の純粋な部分。描画は外部コマンド `vue-preview` の持ち物で
 * （`src-tauri/src/vue_preview.rs`）、ここにあるのは「どのファイルが変わったら描き直すか」、
 * 描けるまで／描けなかったときに子 webview へ置くページ、値を仮に埋める入力フォームの欄。
 */

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
