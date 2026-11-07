// 検証バイナリ（`src-tauri/src/bin/`）がリリースの配布物に入らないこと（#587）。`just test-ts` で走る。
// tauri のバンドラは crate の bin をすべてインストーラと `.app` に同梱し、`required-features` を
// 満たさない bin だけを飛ばす。`[[bin]]` に書き忘れた bin は cargo が自動で拾い、配布物に紛れ込む。
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'

const tauriDir = fileURLToPath(new URL('../src-tauri/', import.meta.url))

type Bin = { name?: string; path?: string; 'required-features'?: string[] }

/**
 * cargo の自動検出と同じく、`src/bin/<名前>.rs` と `src/bin/<名前>/main.rs` を bin として拾う。
 * 値はその bin のファイル（`[[bin]]` の `path` と比べる）
 */
function discoveredBins(): Map<string, string> {
  return new Map(
    readdirSync(`${tauriDir}src/bin`, { withFileTypes: true }).flatMap((e): [string, string][] => {
      if (e.isFile() && e.name.endsWith('.rs')) return [[e.name.slice(0, -3), `src/bin/${e.name}`]]
      if (e.isDirectory() && existsSync(`${tauriDir}src/bin/${e.name}/main.rs`)) {
        return [[e.name, `src/bin/${e.name}/main.rs`]]
      }
      return []
    }),
  )
}

test('src/bin/ の bin はすべて [[bin]] に verify の required-features 付きで載っている', () => {
  const manifest = parse(readFileSync(`${tauriDir}Cargo.toml`, 'utf8')) as { bin?: Bin[] }
  const declared = new Map((manifest.bin ?? []).map((b) => [b.name, b]))
  const problems = [...discoveredBins()].flatMap(([name, file]) => {
    const bin = declared.get(name)
    if (!bin) return [`${name}: [[bin]] が無い`]
    if (!bin['required-features']?.includes('verify')) return [`${name}: required-features に verify が無い`]
    // path を省けば cargo は同じ規則で探す。書くなら、そのファイルを指していること
    if (bin.path !== undefined && bin.path !== file) return [`${name}: path が ${file} ではない（${bin.path}）`]
    return []
  })
  assert.deepEqual(problems, [], `Cargo.toml の [[bin]] を直す（required-features = ["verify"]）: ${problems}`)
})
