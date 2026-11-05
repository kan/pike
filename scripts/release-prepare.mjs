#!/usr/bin/env node
// リリース PR の中身をそろえる（tagpr の postVersionCommand、#529）。
//
//   TAGPR_CURRENT_VERSION=vX.Y.Z TAGPR_NEXT_VERSION=vX.Y.Z PIKE_CREDITS=<credits.json> \
//     node scripts/release-prepare.mjs
//
// tagpr は `.tagpr` の versionFile（tauri.conf.json / Cargo.toml / package.json）の版を
// 書き換えてからこれを呼ぶ。main が進むたびにリリース PR のブランチを main から作り直して
// 呼び直す（書き換え済みのツリーで走らせ直すと、「タグより新しい版の節がある」で落ちる）。やること:
//
// 1. kan/tagpr-scripts の subtree（`scripts/tagpr/release-prepare.mjs --cargo src-tauri`、
//    #562 / #565）。3 ファイルの版が提案と同じかを確かめ、Cargo.lock と package-lock.json の
//    pike 自身の版をそろえ、CHANGELOG の `## [Unreleased]` を版の節にする。cargo も npm も
//    呼ばない。`scripts/tagpr/` の中は編集しない
// 2. クレジット（src/assets/credits.json）を PIKE_CREDITS のファイルで置き換える。
//    **ここでは作らない。** 作るには依存のコード（node_modules）とネットワークが要るので、
//    tagpr.yml の書き込みの権限を持たない credits ジョブが main のツリーで作り、artifact で渡す。
//    一覧は Pike 自身を含まないので、版を上げる前のツリーで作っても同じものになる
//    手元で試すときは、先に `just credits` を走らせて PIKE_CREDITS=src/assets/credits.json を渡す
//
// 1 の前に、tauri.conf.json の版が提案と同じかを確かめる。scripts/tagpr/ が見るのは Cargo.toml と
// package.json だけで、マージ後のタグと成果物の名前を決めるこのファイルは見ない。
//
// PIKE_CREDITS が無いか、tauri.conf.json の検査か 1 が落ちたら（リリースの直後は `## [Unreleased]`
// が空なので毎回落ちる）、lockfile・CHANGELOG・クレジットを書き換えずに失敗で終える（1 は検査を
// すべて済ませてから書く）。**3 ファイルの版は tagpr がこれより前に書き換えている**ので、tagpr が
// 失敗しても作るリリース PR には版だけが上がる。tagpr の run が赤ならマージしない。

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const CREDITS = join(root, 'src/assets/credits.json')

function fail(message) {
  console.error(message)
  process.exit(1)
}

// 版の形（TAGPR_NEXT_VERSION / TAGPR_CURRENT_VERSION）は scripts/tagpr/ が書き込みの前に確かめる
const next = (process.env.TAGPR_NEXT_VERSION ?? '').replace(/^v/, '')
const tauriVersion = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version
if (tauriVersion !== next) {
  fail(
    `src-tauri/tauri.conf.json の version（${tauriVersion}）が tagpr の提案（${next}）と食い違っています。` +
      '.tagpr の versionFile と、版より前に同じ文字列が無いかを確かめてください',
  )
}
const credits = process.env.PIKE_CREDITS ? resolve(process.env.PIKE_CREDITS) : ''
if (!credits || !existsSync(credits)) {
  fail(`PIKE_CREDITS に作り直したクレジットのファイルを渡してください: "${process.env.PIKE_CREDITS ?? ''}"`)
}

console.log('== CHANGELOG と lockfile')
// ルートを作業ディレクトリにする（tagpr-scripts は CHANGELOG.md などをそこから読む）
const r = spawnSync(process.execPath, [join(root, 'scripts/tagpr/release-prepare.mjs'), '--cargo', 'src-tauri'], {
  cwd: root,
  stdio: 'inherit',
})
if (r.error) console.error(`scripts/tagpr/release-prepare.mjs を起動できませんでした: ${r.error.message}`)
if (r.status !== 0) fail(`\n失敗したステップ: CHANGELOG と lockfile（終了コード ${r.status ?? 1}）`)

console.log('\n== credits')
if (credits === CREDITS) console.log('src/assets/credits.json をそのまま使う')
else {
  copyFileSync(credits, CREDITS)
  console.log(`${process.env.PIKE_CREDITS} -> src/assets/credits.json`)
}
