/**
 * Vue SFC のプレビュー（#397）の純粋な部分。描画は外部コマンド `vue-preview` の持ち物で
 * （`src-tauri/src/vue_preview.rs`）、ここにあるのは「どのファイルが変わったら描き直すか」と、
 * 描けるまで／描けなかったときに子 webview へ置くページだけ。
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
