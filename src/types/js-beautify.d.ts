// `js-beautify` は型を同梱しない。使う 3 つの関数と、渡すオプションだけを宣言する（#366）。
// CommonJS のモジュールなので、動的 import では関数が `default` の下に入ることがある
// （`lib/editorFormat.ts` が両方を見る）。
declare module 'js-beautify' {
  interface BeautifyOptions {
    indent_size?: number
    end_with_newline?: boolean
    preserve_newlines?: boolean
    max_preserve_newlines?: number
    wrap_line_length?: number
  }
  interface Beautifiers {
    html_beautify(source: string, options?: BeautifyOptions): string
    css_beautify(source: string, options?: BeautifyOptions): string
    js_beautify(source: string, options?: BeautifyOptions): string
  }
  export const html_beautify: Beautifiers['html_beautify']
  export const css_beautify: Beautifiers['css_beautify']
  export const js_beautify: Beautifiers['js_beautify']
  const beautifiers: Beautifiers
  export default beautifiers
}
