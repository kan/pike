#!/usr/bin/env node
// CHANGELOG.md の X.Y.Z の節からリリースノートの本文を作る（Release の draft ジョブ、#505）。
//
//   node scripts/release-notes.mjs X.Y.Z > notes.md
//
// ドラフトの本文になり、updater-json.mjs がそれを latest.json の notes に写す。latest.json は
// 公開前に上がり、公開後は Immutable releases で差し替えられないので、本文はタグの時点で
// リポジトリにある CHANGELOG から作る。節が無いか空なら止める（書き忘れたままタグを打ったとき）。

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = process.argv[2]

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('usage: node scripts/release-notes.mjs X.Y.Z')

const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/)

// 見出しはコードブロックの外にあるものだけを数える（中の `## ` で節を切らないため）
const headings = []
let inFence = false
for (const [i, line] of lines.entries()) {
  if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
  else if (!inFence && line.startsWith('## ')) headings.push(i)
}

const starts = headings.filter((i) => lines[i].startsWith(`## [${version}]`))
if (starts.length === 0) fail(`CHANGELOG.md に ${version} の節がありません（見出しは "## [${version}] - 日付"）`)
if (starts.length > 1) fail(`CHANGELOG.md に ${version} の節が ${starts.length} つあります`)
const start = starts[0]
const end = headings.find((i) => i > start) ?? lines.length
const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim()
if (!body) fail(`CHANGELOG.md の ${version} の節が空です`)

process.stdout.write(`## Pike v${version}\n\n${body}\n`)
