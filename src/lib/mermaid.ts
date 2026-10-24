/**
 * Mermaid の図を描く（#417 → #508）。
 *
 * **描画器は Obsidian の Pele（`pele`）1 つ。** Mermaid 12.1.0 に組み込みの全図種を、自前の
 * パーサとレイアウトで同期に描く（実行時の依存なし）。以前は beautiful-mermaid と本家の mermaid の
 * 2 段で、1 行目の見出しでの振り分け・投げずに読み違えた図の検出・素のセレクタの `<style>` の
 * 絞り込み・ELK の重さを隠すキャッシュを抱えていた（#417）。Pele ではどれも要らない:
 * 空白を挟まない `A-->B` も読め、出力に `<style>` も `foreignObject` も無く、300 本のエッジの
 * flowchart で 1 回 10ms ほどで描ける。
 *
 * - **`pele/lazy` を遅延 import する**。図種ごとのチャンクは、その図を描くときに読まれる
 * - **配色は CSS 変数で渡す**（`theme.css` の `.pele`）。SVG は色を `var(--pele-*)` で参照する
 *   だけなので、ライト／ダークを切り替えても描き直さない
 * - **書体は `fontFamily` で渡す**（CSS の `--pele-font` では渡さない）。ラベルの幅を測る書体と
 *   描く書体が同じでないと、箱からはみ出る
 * - 本家にしか無いものは効かない: `%%{init}%%` やフロントマターの `themeVariables`、`click` の
 *   コールバック、HTML ラベル（`<b>` `<i>` `<br>` などの書式以外のタグは落ちる）。`click` の
 *   リンクと画像も出させない（`links` / `images`。前者は本家でも `securityLevel` で止めていた。
 *   後者は外のホストを CSP が止め、そのたびにコンソールへ違反が出る）
 * - ラベルの `$$…$$` は文字のまま出る（`math` を渡していない）
 */
import DOMPurify from 'dompurify'
import type { RenderOptions } from 'pele'

/**
 * Pele に渡すオプション。`tests/mermaid.test.ts` も同じものを使う（DOMPurify は DOM が要るので、
 * テストは `renderMermaid` を呼べない）。
 *
 * @param id 文書の中で一意の id（SVG の中の id の接頭辞に使う）
 * @param font 図の文字の書体（`settingsStore.uiFontFamilyCss`。UI と同じ組み立て済みの font-family）
 */
export function peleOptions(id: string, font: string): RenderOptions {
  return { idPrefix: id, fontFamily: font, links: false, images: false }
}

/**
 * 図を描いて、**無害化済みの** SVG を断片で返す。描けなければ Pele の例外（`PeleError`。行と列を
 * 持つ）をそのまま投げる。
 *
 * Pele はラベルも属性値も自前でエスケープし、`<style>` 要素を出さない（ページの他の SVG に
 * 効かない）。それでも DOMPurify の SVG のプロファイルに通す: 公開から間もなく版の上がり方が
 * 速いので、パーサの取りこぼしを当てにしない。出力に `foreignObject` が無いので、本家のときの
 * ようにラベルが消えることはない。断片で返すのは、文字列に戻して `innerHTML` でもう一度
 * 解析させないため（Markdown のプレビューは打鍵のたびに全部の図を描き直す）。
 */
export async function renderMermaid(source: string, id: string, font: string): Promise<DocumentFragment> {
  const { renderAsync } = await import('pele/lazy')
  const { svg } = await renderAsync(source, peleOptions(id, font))
  // `role` は SVG のプロファイルに入っていない（読み上げに図として伝える `graphics-document` が落ちる）
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true }, ADD_ATTR: ['role'], RETURN_DOM_FRAGMENT: true })
}
