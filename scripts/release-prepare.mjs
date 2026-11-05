#!/usr/bin/env node
// リリース PR の中身をそろえる（tagpr の postVersionCommand、#529）。
//
//   TAGPR_CURRENT_VERSION=vX.Y.Z TAGPR_NEXT_VERSION=vX.Y.Z PIKE_CREDITS=<credits.json> \
//     node scripts/release-prepare.mjs
//
// tagpr は `.tagpr` の versionFile（tauri.conf.json）だけを書き換えてからこれを呼ぶ。
// main が進むたびにリリース PR のブランチを main から作り直して呼び直す（書き換え済みの
// ツリーで走らせ直すと、CHANGELOG の段が「タグより新しい版の節がある」で落ちる）。やること:
//
// 1. CHANGELOG の `## [Unreleased]` を `## [X.Y.Z] - 日付` にし、空の `## [Unreleased]` を
//    上に戻して、末尾にその版のリンクを足す（kan/tagpr-scripts の subtree、#562。
//    `scripts/tagpr/` の中は編集しない。直すときは kan/tagpr-scripts を直して subtree pull する）
// 2. 残りの版の表記（package.json / Cargo.toml）と 2 つの lockfile を合わせる（bump-version.mjs）
// 3. クレジット（src/assets/credits.json）を PIKE_CREDITS のファイルで置き換える。
//    **ここでは作らない。** 作るには依存のコード（node_modules）とネットワークが要るので、
//    tagpr.yml の書き込みの権限を持たない credits ジョブが main のツリーで作り、artifact で渡す。
//    一覧は Pike 自身を含まないので、版を上げる前のツリーで作っても同じものになる
//    手元で試すときは、先に `just credits` を走らせて PIKE_CREDITS=src/assets/credits.json を渡す
//
// PIKE_CREDITS が無いか、CHANGELOG の段が落ちたら（リリースの直後は `## [Unreleased]` が
// 空なので毎回落ちる）、何も書き換えずに失敗で終える。tagpr は失敗してもリリース PR を作るので、
// Cargo.toml などまで書き換えた PR を残さない。tagpr の run が赤ならマージしない。

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = (process.env.TAGPR_NEXT_VERSION ?? '').replace(/^v/, '')
const CREDITS = join(root, 'src/assets/credits.json')

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`TAGPR_NEXT_VERSION が vX.Y.Z の形ではありません: "${process.env.TAGPR_NEXT_VERSION ?? ''}"`)
}
const credits = process.env.PIKE_CREDITS ? resolve(process.env.PIKE_CREDITS) : ''
if (!credits || !existsSync(credits)) {
  fail(`PIKE_CREDITS に作り直したクレジットのファイルを渡してください: "${process.env.PIKE_CREDITS ?? ''}"`)
}

/** ルートを作業ディレクトリにして Node のスクリプトを走らせる。tagpr-scripts は CHANGELOG.md をそこから読む。 */
function runScript(label, script, args = []) {
  console.log(`\n== ${label}`)
  const r = spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, stdio: 'inherit' })
  if (r.error) console.error(`${script} を起動できませんでした: ${r.error.message}`)
  if (r.status !== 0) fail(`\n失敗したステップ: ${label}（終了コード ${r.status ?? 1}）`)
}

// TAGPR_NEXT_VERSION と TAGPR_CURRENT_VERSION は環境変数のまま渡る。落ちるときは何も書き換えない
runScript('CHANGELOG', 'scripts/tagpr/release-prepare.mjs', ['--changelog-only'])
runScript('bump', 'scripts/bump-version.mjs', [version])

console.log('\n== credits')
if (credits === CREDITS) console.log('src/assets/credits.json をそのまま使う')
else {
  copyFileSync(credits, CREDITS)
  console.log(`${process.env.PIKE_CREDITS} -> src/assets/credits.json`)
}
