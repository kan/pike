#!/usr/bin/env node
// リリース PR の中身をそろえる（tagpr の postVersionCommand、#529）。
//
//   TAGPR_NEXT_VERSION=vX.Y.Z node scripts/release-prepare.mjs
//
// tagpr は `.tagpr` の versionFile（tauri.conf.json）だけを書き換えてからこれを呼ぶ。
// main が進むたびにリリース PR のブランチを main から作り直して呼び直すので、何度走っても
// 同じ結果になるようにしてある。やること:
//
// 1. 残りの版の表記（package.json / Cargo.toml）と 2 つの lockfile を合わせる（bump-version.mjs）
// 2. CHANGELOG の `## [Unreleased]` を `## [X.Y.Z] - 日付` にする。節は各 PR が書く
// 3. クレジット（src/assets/credits.json）を作り直す。依存の更新ではもう作り直さない
//
// 1 つが落ちても残りは走らせ、最後に失敗で終える。tagpr は失敗してもリリース PR を作るので、
// ステップの失敗（Actions の注釈）を見てからマージする。

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = (process.env.TAGPR_NEXT_VERSION ?? '').replace(/^v/, '')

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`TAGPR_NEXT_VERSION が vX.Y.Z の形ではありません: "${process.env.TAGPR_NEXT_VERSION ?? ''}"`)
  process.exit(1)
}

const failures = []

function runScript(label, script, args = []) {
  console.log(`\n== ${label}`)
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) failures.push(`${label}（終了コード ${r.status ?? r.error}）`)
}

/** `## [Unreleased]` の見出しを版と日付に置き換える。見出しはコードブロックの外だけを見る。 */
function stampChangelog() {
  console.log('\n== CHANGELOG')
  const path = join(root, 'CHANGELOG.md')
  const lines = readFileSync(path, 'utf8').split('\n')
  let inFence = false
  const hits = []
  const stamped = []
  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    else if (inFence) continue
    else if (/^## \[Unreleased\]\s*$/i.test(line)) hits.push(i)
    else if (line.startsWith(`## [${version}]`)) stamped.push(i)
  }
  // 同じブランチで呼び直されたとき（見出しは書き換え済み）はそのままにする
  if (hits.length === 0 && stamped.length === 1) {
    console.log(`## [${version}] の節は書き換え済み`)
    return
  }
  if (hits.length !== 1 || stamped.length !== 0) {
    failures.push(
      `CHANGELOG（## [Unreleased] が ${hits.length} 個、## [${version}] が ${stamped.length} 個ある。` +
        '## [Unreleased] が 1 個だけあるはず。各 PR がこの節に項目を足す）',
    )
    return
  }
  // 日付は日本時間で付ける（ランナーは UTC）
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date())
  // 行末の \r は残す（Windows で autocrlf のツリーを試すとき、この行だけ LF にしない）
  const eol = lines[hits[0]].endsWith('\r') ? '\r' : ''
  lines[hits[0]] = `## [${version}] - ${date}${eol}`
  writeFileSync(path, lines.join('\n'))
  console.log(`## [Unreleased] -> ## [${version}] - ${date}`)
}

runScript('bump', 'scripts/bump-version.mjs', [version])
stampChangelog()
// node_modules（npm ci --ignore-scripts）はワークフローが先に入れておく
runScript('credits', 'scripts/gen-credits.mjs')

if (failures.length > 0) {
  console.error(`\n失敗したステップ:\n${failures.map((f) => `- ${f}`).join('\n')}`)
  process.exit(1)
}
