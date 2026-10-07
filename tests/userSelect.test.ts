// 文字を選択できる面の入口が `theme.css` の `.selectable` だけであること（#455）。
// `just test-ts` で走る。コンポーネントの CSS で選択可に戻すと、既定（選択できない）を
// 反転した意味が薄れ、`-webkit-` の併記も漏れる。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const THEME = join(SRC, 'assets', 'theme.css')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return /\.(vue|css|ts)$/.test(e.name) ? [path] : []
  })
}

// CSS の宣言（1 行に書いた規則と `style=""` を含む）と、JS から書く `userSelect`
// （`:style` のオブジェクト、`el.style.userSelect = …`、CodeMirror のテーマ）の両方を拾う。
const DECLARATIONS = [/user-select\s*:\s*([a-z-]+)/g, /userSelect\s*[:=]\s*['"`]([a-z-]*)['"`]/g]

test('`user-select` を `none` 以外にするのは theme.css だけ', () => {
  const offenders: string[] = []
  for (const file of sources(SRC)) {
    if (file === THEME) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const re of DECLARATIONS) {
          for (const m of line.matchAll(re)) {
            if (m[1] !== 'none') offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
          }
        }
      })
  }
  assert.deepEqual(offenders, [], '選択可にする面には `class="selectable"` を付ける（theme.css）')
})
