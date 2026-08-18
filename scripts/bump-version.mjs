#!/usr/bin/env node
// バージョン番号を 3 ファイルに書き込む（node scripts/bump-version.mjs X.Y.Z / just bump X.Y.Z）。
//
// tauri.conf.json / package.json / Cargo.toml が別々の形式で同じ値を持っているため、
// 手で直すと取り残しが出る（Cargo.lock と package-lock.json の drift は実際に何度も
// 起きている）。lockfile 側の更新は just の bump レシピが続けて走らせる。

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = process.argv[2]

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/bump-version.mjs X.Y.Z')
  process.exit(1)
}

/** 置換は 1 箇所だけ当たることを確認する（依存の version 行を巻き込まないため）。 */
function bump(relPath, pattern, replacement) {
  // pattern は g 付きで渡す（該当行が本当に 1 箇所かを数えるため）
  const path = join(root, relPath)
  const before = readFileSync(path, 'utf8')
  const hits = [...before.matchAll(pattern)].length
  if (hits !== 1) {
    console.error(`${relPath}: バージョン行が ${hits} 箇所見つかりました（1 箇所のはず）`)
    process.exit(1)
  }
  const after = before.replace(pattern, replacement)
  if (after !== before) writeFileSync(path, after)
  return { path: relPath, changed: after !== before }
}

const results = [
  // JSON の先頭付近にある自身の version（依存側に "version" キーは無い）
  bump('package.json', /^(\s*"version":\s*)"[^"]+"/gm, `$1"${version}"`),
  bump('src-tauri/tauri.conf.json', /^(\s*"version":\s*)"[^"]+"/gm, `$1"${version}"`),
  // [package] 直下の version（依存の version は行頭が version = ではない、
  // もしくは同じテーブルに無い）
  bump('src-tauri/Cargo.toml', /^version = "[^"]+"/gm, `version = "${version}"`),
]

for (const r of results) {
  console.log(`${r.changed ? 'updated' : 'unchanged'}  ${r.path}`)
}
console.log(`\nversion = ${version}`)
console.log('CHANGELOG.md の見出し追加は手動です。')
