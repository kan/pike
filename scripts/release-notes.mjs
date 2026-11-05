#!/usr/bin/env node
// CHANGELOG.md の X.Y.Z の節からリリースノートの本文を作る（Release の draft ジョブ、#505）。
//
//   node scripts/release-notes.mjs X.Y.Z > notes.md
//
// ドラフトの本文になり、updater-json.mjs がそれを latest.json の notes に写す。latest.json は
// 公開前に上がり、公開後は Immutable releases で差し替えられないので、本文はタグの時点で
// リポジトリにある CHANGELOG から作る。
//
// 節の抜き出しは kan/tagpr-scripts の subtree（`scripts/tagpr/release-notes.mjs`、#562）に任せ、
// ここでは先頭に `## Pike vX.Y.Z` を足すだけにする。節が無いか、2 つ以上あるか、空なら、
// そちらが止める（書き忘れたままタグを打ったとき）。段落と項目の中の折り返しは 1 行につながる。

import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = process.argv[2]

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/release-notes.mjs X.Y.Z')
  process.exit(1)
}

// 本文を受け取ってから書く（落ちたときに見出しだけを出さない）。エラーはそのまま流す
const r = spawnSync(process.execPath, [join(root, 'scripts/tagpr/release-notes.mjs'), version], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})
if (r.error) console.error(`scripts/tagpr/release-notes.mjs を起動できませんでした: ${r.error.message}`)
if (r.status !== 0) process.exit(r.status ?? 1)

process.stdout.write(`## Pike v${version}\n\n${r.stdout}`)
