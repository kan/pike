#!/usr/bin/env node
// リリース PR の中身をそろえる（tagpr の postVersionCommand、#529）。
//
//   TAGPR_CURRENT_VERSION=vX.Y.Z TAGPR_NEXT_VERSION=vX.Y.Z TAGPR_ARTIFACT_DIR=<dir> \
//     node scripts/release-prepare.mjs
//
// tagpr は `.tagpr` の versionFile（tauri.conf.json / Cargo.toml / package.json）の版を
// 書き換えてからこれを呼ぶ。main が進むたびにリリース PR のブランチを main から作り直して
// 呼び直す（書き換え済みのツリーで走らせ直すと、「タグより新しい版の節がある」で落ちる）。やること:
//
// 1. kan/tagpr-scripts の subtree（`scripts/tagpr/release-prepare.mjs --cargo src-tauri`、
//    #562 / #565）。`.tagpr` の versionFile の 3 ファイルの版が提案と同じかを確かめ、Cargo.lock と
//    package-lock.json の pike 自身の版をそろえ、CHANGELOG の `## [Unreleased]` を版の節にする。
//    cargo も npm も呼ばない。`scripts/tagpr/` の中は編集しない
// 2. クレジット（src/assets/credits.json）を TAGPR_ARTIFACT_DIR/credits.json で置き換える。
//    **ここでは作らない。** 作るには依存のコード（node_modules）とネットワークが要るので、
//    tagpr.yml の書き込みの権限を持たない credits ジョブが main のツリーで作り、artifact `credits` で
//    渡す。kan/tagpr-scripts の共通の workflow がそれを展開し、そのディレクトリを TAGPR_ARTIFACT_DIR で
//    渡す（#573。展開に失敗すると空になる）。一覧は Pike 自身を含まないので、版を上げる前のツリーで
//    作っても同じものになる
//    手元で試すときは、先に `just credits` を走らせて TAGPR_ARTIFACT_DIR=src/assets を渡す
//
// TAGPR_ARTIFACT_DIR に credits.json が無いか、1 が落ちたら（リリースの直後は `## [Unreleased]` が空なので毎回落ちる）、
// lockfile・CHANGELOG・クレジットを書き換えずに失敗で終える（1 は検査を
// すべて済ませてから書く）。**3 ファイルの版は tagpr がこれより前に書き換えている**ので、tagpr が
// 失敗しても作るリリース PR には版だけが上がる。そのリリース PR は共通の workflow が draft にするが、
// tagpr の run が赤ならマージしない。

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const CREDITS = join(root, 'src/assets/credits.json')

function fail(message) {
  console.error(message)
  process.exit(1)
}

// 版の形と versionFile の版（TAGPR_NEXT_VERSION / TAGPR_CURRENT_VERSION）は scripts/tagpr/ が
// 書き込みの前に確かめる
const artifactDir = process.env.TAGPR_ARTIFACT_DIR ?? ''
const credits = artifactDir ? resolve(artifactDir, 'credits.json') : ''
if (!credits || !existsSync(credits)) {
  fail(`TAGPR_ARTIFACT_DIR に作り直したクレジット（credits.json）のあるディレクトリを渡してください: "${artifactDir}"`)
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
  console.log(`${credits} -> src/assets/credits.json`)
}
