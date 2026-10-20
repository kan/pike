// `markdown-it-emoji` の対応表（名前 → 絵文字）だけを使う（#482、`lib/markdownEmoji.ts`）。
// パッケージは型を同梱しないので、読むファイルだけを宣言する。
declare module 'markdown-it-emoji/lib/data/full.mjs' {
  const table: Record<string, string>
  export default table
}
