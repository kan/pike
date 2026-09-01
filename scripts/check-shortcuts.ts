/**
 * マニュアルの「プリセット別の早見表」が実装と合っているかを照合する（#280）。
 *
 * `scripts/check-docs.mjs` と違って **`src/lib/` を実際に import する**。キーの表は
 * `Mod` の解決・プリセットの重ね合わせ・`macChords` の差し替えを経て初めて確定するので、
 * 正規表現でソースを読むと、その組み立てをこちら側に書き写すことになる。実装が持っている
 * `bindingsFor(preset, mac)` と `chordLabel(chord, mac)` をそのまま呼べば、写しが要らない。
 * どちらも照合のために `mac` を引数で受ける形にしてある（アプリの中からは `isMacHost` の
 * 既定で呼ぶ）。node から読めるよう `tsx` 経由で走らせる。
 *
 * **見るのは「実装 → マニュアル」の一方向だけ。** 実装が持つ chord が表に載っていなければ
 * 落とす。逆（表にあって実装に無い）を見ないのは、この表が CodeMirror 層のキー（保存・検索）
 * のようにプリセットの表へ載らないものも併記しているため。狙いは「キーを変えたのにマニュアルが
 * 古い」を捕まえることで、そちらはこの向きで捕まる。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chordLabel } from '../src/lib/keys'
import { bindingsFor, editorChordsFor, type ShortcutPreset } from '../src/lib/shortcuts'

const root = join(import.meta.dirname, '..')
const MANUAL = 'docs/manual/shortcuts-and-cli.md'
/** 早見表の見出し。ここから次の `###` までを表とみなす。 */
const HEADING = '### プリセット別の早見表'

/** プリセットごとの表の見出し（この順で並んでいる）。 */
const TABLES: { preset: ShortcutPreset; label: string }[] = [
  { preset: 'vscode', label: '**VSCode 互換**' },
  { preset: 'idea', label: '**IDEA 互換**' },
]

const problems: string[] = []

const body = readFileSync(join(root, MANUAL), 'utf8')
const start = body.indexOf(HEADING)
if (start === -1) {
  problems.push(`${MANUAL}: 「${HEADING}」の節が無い（この照合が対象を見失っている）`)
}
const section = start === -1 ? '' : body.slice(start).split(/\n### /)[0]

/**
 * 早見表のセルから chord の表記を集める。単一のコードスパンに加え、``` `` ``` で囲んだもの
 * （中身にバッククォートを含む `Ctrl+Shift+\`` 用）も拾う。
 */
function codeSpans(text: string): Set<string> {
  const found = new Set<string>()
  for (const m of text.matchAll(/``\s?(.+?)\s?``|`([^`\n]+)`/g)) found.add(m[1] ?? m[2])
  return found
}

/** その表の範囲（次の `**...**` 見出しか節の末尾まで）。 */
function tableFor(label: string): string {
  const i = section.indexOf(label)
  if (i === -1) {
    problems.push(`${MANUAL}: 早見表に「${label}」が無い`)
    return ''
  }
  const rest = section.slice(i + label.length)
  const next = rest.search(/\n\*\*/)
  return next === -1 ? rest : rest.slice(0, next)
}

for (const { preset, label } of TABLES) {
  const listed = codeSpans(tableFor(label))
  for (const mac of [false, true]) {
    const os = mac ? 'macOS' : 'Windows / Linux'
    const expected = new Set<string>()
    for (const b of bindingsFor(preset, mac)) {
      // **アクションを持つ行だけを見る。** `Mod+S` / `Mod+F` / `Mod+H` の行は「ブラウザの
      // 既定を潰すだけ」で、実処理も表記も CodeMirror 側にある（IDEA 互換では置換が
      // `Ctrl+R` なのに `Ctrl+H` の行は潰す用に残る、mac では `⌘H` が OS のアプリ非表示、
      // といった具合に、操作の一覧には載らない）。
      if (!b.action) continue
      for (const c of b.chords) expected.add(chordLabel(c, mac))
    }
    // 置換だけは CodeMirror 側の割り当てで、`keyBindings` に無い（#261）。表には載っている。
    expected.add(chordLabel(editorChordsFor(preset, mac).replace, mac))

    for (const chord of expected) {
      if (!listed.has(chord)) {
        problems.push(`${MANUAL}: ${label.replaceAll('*', '')} / ${os} の表に \`${chord}\` が無い`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`ショートカット照合: ${problems.length} 件\n`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\nマニュアルの「プリセット別の早見表」を実装に合わせてください。')
  process.exit(1)
}
console.log('ショートカット照合: 問題なし')
